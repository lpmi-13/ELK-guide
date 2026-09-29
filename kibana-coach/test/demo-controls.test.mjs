import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function loadClass(path, name, globals = [], values = []) {
  const source = fs.readFileSync(new URL(path, import.meta.url), 'utf8');
  return new Function(...globals, `${source}\nreturn ${name};`)(...values);
}

test('the demonstration briefing explains that the countdown starts automatically', () => {
  const Briefing = loadClass('../src/ui/incident-briefing.js', 'IncidentBriefing');
  const copy = Briefing.prototype.modeCopy('demonstration');
  assert.equal(`${copy.waiting} in 30`, 'Demonstration will automatically begin in 30');
});

test('Advance completes the current typed value and lets the action continue', async () => {
  const Adapter = loadClass('../src/kibana-adapter.js', 'KibanaAdapter',
    ['KeyboardEvent', 'Event'], [class { constructor(type) { this.type = type; } }, class { constructor(type) { this.type = type; } }]);
  const adapter = new Adapter();
  let releaseCharacter;
  adapter.wait = () => new Promise(resolve => { releaseCharacter = resolve; });
  adapter.setNativeValue = (element, value) => { element.value = value; };
  const events = [];
  const input = {value: '', focus() {}, dispatchEvent(event) { events.push(event.type); }};
  const typing = adapter.typeValue(input, 'service.version: "v2"');
  assert.equal(input.value, 's');
  assert.equal(adapter.advanceTyping(), true);
  releaseCharacter();
  await typing;
  assert.equal(input.value, 'service.version: "v2"');
  assert.deepEqual(events, ['keydown', 'keyup', 'change']);
  assert.equal(adapter.advanceTyping(), false);
});

test('the coach can be dragged and stays clear of a newly added column', () => {
  const header = {
    classList: {add() {}, remove() {}},
    setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {},
  };
  const column = {textContent: 'service.version', getBoundingClientRect: () => ({left: 1420, right: 1580, top: 300, width: 160})};
  const Panel = loadClass('../src/ui/coach-panel.js', 'IncidentCoachPanel',
    ['innerWidth', 'innerHeight', 'document'], [1920, 1080, {querySelectorAll: () => [column]}]);
  const panel = Object.create(Panel.prototype);
  panel.root = {querySelector: () => header};
  panel.panel = {hidden: false, style: {}, getBoundingClientRect: () => ({left: 18, top: 72, width: 468, height: 390})};
  panel.findFlyout = () => null;
  panel.applyPosition = () => {};
  panel.pos = {left: 18, top: 72};

  panel.startDrag({button: 0, pointerId: 1, clientX: 40, clientY: 100, target: {closest: () => null}, preventDefault() {}});
  panel.moveDrag({pointerId: 1, clientX: 1442, clientY: 500});
  assert.deepEqual(panel.pos, {left: 1420, top: 472});
  panel.evidenceField = 'service.version';
  panel.endDrag({pointerId: 1});
  assert.equal(panel.pos.left, 18);
  assert.ok(panel.pos.top >= 72 && panel.pos.top <= 672);
});

test('learning highlights the HTTP status and version columns in the visible table', () => {
  const headers = [
    {textContent: 'service.version', getBoundingClientRect: () => ({left: 1100, right: 1260, top: 420})},
    {textContent: 'http.response.status_code', getBoundingClientRect: () => ({left: 1260, right: 1450, top: 420})},
  ];
  const document = {
    querySelectorAll: () => headers,
    createElement: () => ({style: {}, setAttribute() {}, remove() { this.removed = true; }}),
  };
  const Panel = loadClass('../src/ui/coach-panel.js', 'IncidentCoachPanel',
    ['document', 'innerWidth', 'innerHeight'], [document, 1920, 1080]);
  const panel = Object.create(Panel.prototype);
  panel.root = {append() {}};
  panel.showEvidenceHighlights(['service.version', 'http.response.status_code']);
  assert.equal(panel.evidenceHighlights.length, 2);
  assert.match(panel.evidenceHighlights[0].style.cssText, /left:1100px.*width:160px/);
  assert.match(panel.evidenceHighlights[1].style.cssText, /left:1260px.*width:190px/);
  const highlights = [...panel.evidenceHighlights];
  panel.clearEvidenceHighlights();
  assert.ok(highlights.every(highlight => highlight.removed));
});

test('hints stay with their step and disappear before the next card or success card', () => {
  const Panel = loadClass('../src/ui/coach-panel.js', 'IncidentCoachPanel',
    ['requestAnimationFrame'], [callback => callback()]);
  const panel = Object.create(Panel.prototype);
  const nodes = Object.fromEntries([
    '#hint-card', '#hint-label', '#hint-text', '#mode', '#objective', '#pause',
    '#demonstrate', '#incident-info', '#advance', '#hint', '#diagnosis',
    '#phase-eyebrow', '#phase-headline',
  ].map(selector => [selector, {hidden: false, textContent: '', style: {}}]));
  nodes['#stage'] = {hidden: false, offsetWidth: 300, classList: {add() {}, remove() {}}};
  nodes['.progress span'] = {style: {}};
  panel.root = {querySelector: selector => nodes[selector]};
  panel.host = {hidden: true};
  panel.panel = {hidden: true};
  panel.spotlight = {hide() {}};
  panel.clearEvidenceHighlights = () => {};
  panel.renderPhase = () => {};
  panel.resetCountdown = () => {};
  panel.refit = () => {};
  panel.placeAwayFrom = () => {};

  const command = (step_id, step_index) => ({command_id: step_id, step_id, step_index,
    step_count: 2, mode: 'guided', narration: 'Investigate the incident.'});
  panel.showCommand(command('scope', 0), null);
  panel.showHint({step_id: 'scope', level: 2, text: 'Use the date picker.'});
  assert.equal(nodes['#hint-card'].hidden, false);
  assert.equal(nodes['#hint-label'].textContent, 'Hint 2');
  assert.equal(nodes['#hint-text'].textContent, 'Use the date picker.');

  panel.showCommand(command('survey', 1), null);
  assert.equal(nodes['#hint-card'].hidden, true);
  assert.equal(nodes['#hint-text'].textContent, '');
  panel.showHint({step_id: 'scope', level: 2, text: 'Late reply from the old step.'});
  assert.equal(nodes['#hint-card'].hidden, true);
  panel.showHint({step_id: 'survey', level: 1, text: 'Inspect the field.'});
  assert.equal(nodes['#hint-text'].textContent, 'Inspect the field.');

  panel.celebrate('Step complete.');
  clearTimeout(panel.celebrateTimer);
  assert.equal(nodes['#hint-card'].hidden, true);
  panel.showHint({step_id: 'survey', level: 2, text: 'Late reply during confirmation.'});
  assert.equal(nodes['#hint-card'].hidden, true);
});
