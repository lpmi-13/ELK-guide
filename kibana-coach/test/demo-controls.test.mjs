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
