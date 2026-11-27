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

test('queued Advance is visibly disabled until the action finishes', () => {
  const Panel = loadClass('../src/ui/coach-panel.js', 'IncidentCoachPanel');
  const panel = Object.create(Panel.prototype);
  const advance = {disabled: false, textContent: 'Advance', title: ''};
  panel.root = {querySelector: () => advance};
  panel.setAdvancePending(true);
  assert.equal(advance.disabled, true);
  assert.match(advance.textContent, /when ready/);
  panel.setAdvancePending(false);
  assert.equal(advance.disabled, false);
  assert.equal(advance.textContent, 'Advance');
});

test('the coach can be dragged and stays clear of a newly added column', () => {
  let frame, requested = 0;
  const header = {
    classList: {add() {}, remove() {}},
    setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {},
  };
  const column = {textContent: 'service.version', getBoundingClientRect: () => ({left: 1420, right: 1580, top: 300, width: 160})};
  const Panel = loadClass('../src/ui/coach-panel.js', 'IncidentCoachPanel',
    ['innerWidth', 'innerHeight', 'document', 'requestAnimationFrame', 'cancelAnimationFrame'],
    [1920, 1080, {querySelectorAll: () => [column]}, callback => { frame = callback; return ++requested; }, () => {}]);
  const panel = Object.create(Panel.prototype);
  panel.root = {querySelector: () => header};
  panel.panel = {hidden: false, style: {}, getBoundingClientRect: () => ({left: 18, top: 72, width: 468, height: 390})};
  panel.findFlyout = () => null;
  panel.applyPosition = () => {};
  panel.pos = {left: 18, top: 72};
  panel.evidenceFields = [];
  panel.evidenceTargets = [];

  panel.startDrag({button: 0, pointerId: 1, clientX: 40, clientY: 100, target: {closest: () => null}, preventDefault() {}});
  panel.moveDrag({pointerId: 1, clientX: 1400, clientY: 480});
  panel.moveDrag({pointerId: 1, clientX: 1442, clientY: 500});
  assert.equal(requested, 1);
  frame();
  assert.deepEqual(panel.pos, {left: 1420, top: 472});
  panel.evidenceField = 'service.version';
  panel.endDrag({pointerId: 1});
  // Off the column (its keep-out runs 24px either side of the header, down to the bottom), and right
  // beside it rather than across the screen.
  assert.ok(panel.pos.left + 468 <= 1420 - 24, `card at ${panel.pos.left} covers the column`);
  assert.ok(panel.pos.left + 468 >= 1420 - 24 - 40, `card at ${panel.pos.left} is far from the column`);
  assert.ok(panel.pos.top >= 72 && panel.pos.top <= 672);
});

test('learning highlights the HTTP status and version columns in the visible table', () => {
  const headers = [
    {textContent: 'service.version', getBoundingClientRect: () => ({left: 1100, right: 1260, top: 420})},
    {textContent: 'http.response.status_code', getBoundingClientRect: () => ({left: 1260, right: 1450, top: 420})},
  ];
  const document = {
    querySelectorAll: () => headers,
    createElement: () => ({style: {setProperty(name, value) { this[name] = value; }}, addEventListener() {}, setAttribute() {}, remove() { this.removed = true; }}),
  };
  const Panel = loadClass('../src/ui/coach-panel.js', 'IncidentCoachPanel',
    ['document', 'innerWidth', 'innerHeight'], [document, 1920, 1080]);
  const panel = Object.create(Panel.prototype);
  panel.root = {append() {}};
  panel.showEvidenceHighlights(['service.version', 'http.response.status_code']);
  assert.equal(panel.evidenceHighlights.length, 2);
  assert.deepEqual([panel.evidenceHighlights[0].style.left, panel.evidenceHighlights[0].style.width], ['1100px', '160px']);
  assert.deepEqual([panel.evidenceHighlights[1].style.left, panel.evidenceHighlights[1].style.width], ['1260px', '190px']);
  // Each ring makes its entrance once, a beat after the one before; placing it keeps that delay.
  assert.ok(panel.evidenceHighlights.every(highlight => /\bentering\b/.test(highlight.className)));
  assert.deepEqual(panel.evidenceHighlights.map(highlight => highlight.style['--ring-delay']), ['0ms', '110ms']);
  const highlights = [...panel.evidenceHighlights];
  panel.clearEvidenceHighlights();
  assert.ok(highlights.every(highlight => highlight.removed));
});

test('the coach keeps off every ringed result column, and off any flyout, not just the document viewer', () => {
  const column = field => ({textContent: field, getBoundingClientRect: () => ({left: 1200, right: 1400, top: 430, width: 200})});
  const flyout = {getBoundingClientRect: () => ({left: 720, top: 96, right: 1440, bottom: 900, width: 720, height: 804})};
  let flyouts = [];
  const document = {querySelectorAll: selector => selector.includes('columnheader') ? [column('http.response.status_code')] : selector.includes('euiFlyout') ? flyouts : []};
  const Panel = loadClass('../src/ui/coach-panel.js', 'IncidentCoachPanel',
    ['innerWidth', 'innerHeight', 'document'], [1440, 900, document]);
  const panel = Object.create(Panel.prototype);
  panel.panel = {hidden: false, style: {}, getBoundingClientRect: () => ({left: 954, top: 400, width: 468, height: 390})};
  panel.applyPosition = () => {};
  panel.pos = {left: 954, top: 400};
  panel.evidenceTargets = [];
  panel.evidenceFields = ['http.response.status_code'];
  panel.placeAwayFrom(null);
  // Clear of the ringed column (header to bottom, 24px either side) and beside it.
  assert.ok(panel.pos.left + 468 <= 1176 && panel.pos.left + 468 >= 1136, `card at ${panel.pos.left}`);

  panel.evidenceFields = [];
  flyouts = [flyout];
  assert.equal(panel.findFlyout().left, 720);
  panel.pos = {left: 954, top: 400};
  panel.placeAwayFrom(null);
  // Off the flyout, and right beside it: what the step is about is in there. It leaves the lead ring
  // (64px) clear at the flyout's edge, where its own controls (a document's pins) are used next.
  assert.ok(panel.pos.left + 468 <= 720 - 64 && panel.pos.left + 468 >= 720 - 64 - 30, `card at ${panel.pos.left}`);
});

test('a field the card or its step names keeps its result column clear, though only the evidence is ringed', () => {
  const header = field => ({textContent: field, getBoundingClientRect: () => ({left: 300, right: 460, top: 330, bottom: 360, width: 160})});
  const document = {querySelectorAll: selector => selector.includes('columnheader') ? [header('service.name')] : []};
  const Panel = loadClass('../src/ui/coach-panel.js', 'IncidentCoachPanel', ['innerWidth', 'innerHeight', 'document'], [1440, 900, document]);
  const panel = Object.create(Panel.prototype);
  panel.panel = {hidden: false, style: {}, getBoundingClientRect: () => ({width: 468, height: 300})};
  panel.applyPosition = () => {};
  panel.evidenceTargets = [];
  panel.evidenceFields = [];
  // The card talks about a document row for service.name; it sits over the top of that field's column.
  panel.namedFields = ['service.name'];
  panel.pos = {left: 120, top: 150};
  panel.placeAwayFrom(null);
  const covers = pos => pos.left < 460 + 24 && pos.left + 468 > 300 - 24 && pos.top + 300 > 330 - 24;
  assert.ok(!covers(panel.pos), `card at ${JSON.stringify(panel.pos)} covers the service.name column`);
  // The field a step acts on is protected the same way, from the moment its card appears.
  assert.deepEqual(Panel.commandFields({value: {field: 'service.name', value: 'orders'}}), ['service.name']);
  assert.deepEqual(Panel.commandFields({value: {fields: ['host.name', 'service.version']}}), ['host.name', 'service.version']);
  assert.deepEqual(Panel.commandFields({value: {field: '@timestamp', direction: 'asc'}}), []);
  assert.deepEqual(Panel.commandFields({value: 'service.name: orders'}), []);
});

test('a result card moves beside the data it talks about only when that saves a long look across the screen', () => {
  const Panel = loadClass('../src/ui/coach-panel.js', 'IncidentCoachPanel', ['innerWidth', 'innerHeight', 'document'], [1440, 900, {querySelectorAll: () => []}]);
  const panel = Object.create(Panel.prototype);
  panel.panel = {hidden: false, style: {}, getBoundingClientRect: () => ({width: 468, height: 300})};
  panel.applyPosition = () => {};
  panel.findFlyout = () => null;
  panel.evidenceFields = [];
  // A filter pill far away is a control, not data to read: the card doesn't move for it unasked.
  const pill = {closest: () => null};
  const row = {closest: selector => (selector.includes('.euiFlyout') ? {} : null)};
  let element = pill;
  panel.evidenceTargets = [() => element];
  let rings = [{left: 900, right: 1400, top: 400, bottom: 430}];
  panel.evidenceTargetRects = () => rings;
  panel.pos = {left: 18, top: 72};
  panel.seekFocus = true;
  panel.placeAwayFrom(null);
  assert.deepEqual({...panel.pos}, {left: 18, top: 72});
  panel.seekFocus = false;
  // Pinned rows in a document flyout on the right; the card rests clear of them in the far-left corner.
  element = row;
  panel.placeAwayFrom(null);
  assert.deepEqual({...panel.pos}, {left: 18, top: 72}); // Clear, so it stays: no hop on every scroll.
  panel.seekFocus = true;
  panel.placeAwayFrom(null);
  assert.ok(panel.pos.left + 468 <= 900 - 16 && panel.pos.left + 468 >= 900 - 16 - 20, `card at ${JSON.stringify(panel.pos)}`);
  // Already close: it stays put, so Continue stays under the pointer.
  const settled = {...panel.pos};
  rings = [{left: 900, right: 1400, top: 520, bottom: 550}];
  panel.placeAwayFrom(null);
  assert.deepEqual({...panel.pos}, settled);
});

test('the coach buttons sit right under its header, above the step text, so Advance keeps its place', async () => {
  const {readFileSync} = await import('node:fs');
  const source = readFileSync(new URL('../src/ui/coach-panel.js', import.meta.url), 'utf8');
  const markup = source.slice(source.indexOf('<aside'), source.indexOf('</aside>'));
  const order = ['</header>', 'class="actions"', 'class="progress"', 'class="step-line"', 'id="stage"'].map(part => markup.indexOf(part));
  assert.ok(order.every(index => index >= 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('hints stay with their step and Advance moves through a success card', () => {
  const Panel = loadClass('../src/ui/coach-panel.js', 'IncidentCoachPanel',
    ['requestAnimationFrame'], [callback => callback()]);
  const panel = Object.create(Panel.prototype);
  const nodes = Object.fromEntries([
    '#hint-card', '#hint-label', '#hint-text', '#mode', '#objective', '#pause',
    '#demonstrate', '#incident-info', '#advance', '#hint', '#diagnosis', '#review-feedback',
    '#phase-eyebrow', '#phase-headline', '#phase-detail', '#phase-why', '#phase-why-text',
  ].map(selector => [selector, {hidden: false, textContent: '', style: {}, classList: {add() {}, remove() {}}}]));
  nodes['#stage-actions'] = {hidden: true, replaceChildren() {}};
  nodes['#stage'] = {hidden: false, offsetWidth: 300, classList: {add() {}, remove() {}}};
  nodes['.progress'] = {hidden: false};
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
  assert.equal(panel.advanceCelebration(), true);
  panel.showCommand(command('isolate', 1), null);
  assert.equal(nodes['#objective'].textContent, 'isolate');
  assert.equal(panel.celebrating, false);

  panel.celebrate('Filter applied.');
  panel.showCommand(command('endpoints', 1), null);
  assert.equal(nodes['#objective'].textContent, 'isolate');
  assert.equal(panel.advanceCelebration(), true);
  assert.equal(nodes['#objective'].textContent, 'endpoints');
  assert.equal(panel.advanceCelebration(), false);
});

test('a demonstration\'s opening card spotlights nothing; the control lights up as the action starts', async () => {
  const Panel = loadClass('../src/ui/coach-panel.js', 'IncidentCoachPanel',
    ['requestAnimationFrame'], [callback => callback()]);
  const panel = Object.create(Panel.prototype);
  const node = () => ({hidden: false, textContent: '', style: {}, classList: {add() {}, remove() {}, contains: () => false}});
  const nodes = {};
  panel.root = {querySelector: selector => (nodes[selector] ??= node())};
  panel.host = {hidden: true};
  panel.panel = {hidden: true};
  const spotlit = [];
  panel.spotlight = {show: target => spotlit.push(target), hide() {}};
  panel.cursor = {hide() {}};
  for (const name of ['clearEvidenceHighlights', 'renderPhase', 'resetCountdown', 'startWorking', 'refit']) panel[name] = () => {};
  const placedAwayFrom = [];
  panel.placeAwayFrom = target => placedAwayFrom.push(target);

  const addFilter = {id: 'add-filter-button'};
  panel.showCommand({command_id: 'isolate', step_id: 'isolate', step_index: 2, step_count: 6, mode: 'demonstration',
    narration: 'I\'ll filter to 503 so the remaining requests show where the failures happened.'}, addFilter);
  assert.deepEqual(spotlit, []); // the goal card is read with nothing lit
  assert.equal(panel.activeTarget, addFilter);
  assert.deepEqual(placedAwayFrom, [addFilter]); // but the card keeps clear of the control
  assert.equal(panel.spotlightRevealed, false); // so a scroll or mutation re-placing the card doesn't light it either

  // The action: the card settles first (nothing is moving in this stub), then the control lights up and
  // the cursor sets off for it.
  await panel.showTarget(addFilter, 'Open Add filter.');
  assert.deepEqual(spotlit, [addFilter]);

  // Guided Show me after a Hint lit the control: the walkthrough starts dark, like a demonstration.
  let hidden = 0;
  panel.spotlight.hide = () => { hidden += 1; };
  panel.spotlightRevealed = true;
  panel.beginWalkthrough({command_id: 'isolate', step_id: 'isolate', mode: 'guided', narration: ''});
  assert.equal(panel.spotlightRevealed, false);
  assert.ok(hidden >= 1);
  assert.deepEqual(spotlit, [addFilter]);
});

test('a result card folds its reasoning when no corner clears the evidence, and a learner\'s choice stands', () => {
  const Panel = loadClass('../src/ui/coach-panel.js', 'IncidentCoachPanel', [], []);
  const panel = Object.create(Panel.prototype);
  const why = {hidden: true, open: true};
  const text = {textContent: ''};
  panel.root = {querySelector: selector => ({'#phase-why': why, '#phase-why-text': text})[selector]};
  let refits = 0;
  panel.refit = () => { refits += 1; };
  panel.reasoningOpen = null;

  // No reasoning on this card (a demonstration, or a step without one): nothing to show or fold.
  panel.setReasoning('');
  assert.equal(why.hidden, true);
  assert.equal(panel.foldReasoning(), false);

  panel.setReasoning('Why the step is done.');
  assert.equal(why.hidden, false);
  assert.equal(why.open, true);
  assert.equal(text.textContent, 'Why the step is done.');
  assert.equal(panel.foldReasoning(), true);
  assert.equal(why.open, false);
  assert.equal(refits, 1);
  assert.equal(panel.foldReasoning(), false); // Already folded, so placement can't retry forever.

  // The next card starts open again.
  panel.setReasoning('The next step.');
  assert.equal(why.open, true);

  // A learner who opened it keeps it open, even where it covers something: they asked to read it.
  panel.reasoningOpen = true;
  assert.equal(panel.foldReasoning(), false);
  assert.equal(why.open, true);

  // A learner who closed it keeps it closed on later cards.
  panel.reasoningOpen = false;
  panel.setReasoning('A later step.');
  assert.equal(why.open, false);

  // Using the toggle holds the card still for that beat; the next beat is placed normally again.
  panel.keepPlace = true;
  panel.dragging = null;
  panel.panel = {hidden: false};
  panel.placeAwayFrom(null); // Would throw on this bare stub if it went on to place the card.
  panel.setReasoning('The beat after that.');
  assert.equal(panel.keepPlace, false);
});

test('a result card leads with its first sentence and sets the rest quieter', () => {
  const Panel = loadClass('../src/ui/coach-panel.js', 'IncidentCoachPanel', [], []);
  assert.deepEqual(Panel.splitFinding('Every entity is coloured by CPU. checkout-03 reads far above its peers.'),
    ['Every entity is coloured by CPU.', 'checkout-03 reads far above its peers.']);
  // A paragraph break is a sentence break too, and the rest keeps its own.
  assert.deepEqual(Panel.splitFinding('Columns pair 2.4.1 with HTTP 500.\n\nThat is the regression. It started here.'),
    ['Columns pair 2.4.1 with HTTP 500.', 'That is the regression. It started here.']);
  // Dots inside versions, field names and paths don't end a sentence.
  assert.deepEqual(Panel.splitFinding('Read http.response.status_code on /api/v1.2 for version 2.4.1.'),
    ['Read http.response.status_code on /api/v1.2 for version 2.4.1.', '']);
});

function placementPanel({height, rings}) {
  const bar = {getBoundingClientRect: () => ({left: 0, right: 1440, top: 146, bottom: 281, width: 1440, height: 135})};
  const document = {querySelectorAll: selector => (selector.includes('globalQueryBar') ? [bar] : [])};
  const Panel = loadClass('../src/ui/coach-panel.js', 'IncidentCoachPanel', ['document', 'innerWidth', 'innerHeight'], [document, 1440, 900]);
  const panel = Object.create(Panel.prototype);
  panel.size = height;
  panel.panel = {hidden: false, getBoundingClientRect: () => ({width: 468, height: panel.size})};
  panel.findFlyout = () => null;
  panel.findPopovers = () => [];
  panel.evidenceColumnRects = () => [];
  panel.evidenceTargetRects = () => rings;
  panel.applyPosition = () => {};
  panel.folds = 0;
  panel.foldReasoning = () => false;
  return panel;
}

test('the card moves off a thin ringed row even if that puts it over the query bar', () => {
  // A short card fits in the bottom corner, where it covers fewer pixels of the row than the top corner
  // does of the bar, but it hides the row's name. What the step is about comes first.
  const panel = placementPanel({height: 315, rings: [{left: 321, right: 1423, top: 559, bottom: 583}]});
  panel.pos = {left: 18, top: 567};
  panel.foldReasoning = () => { panel.folds += 1; return false; };
  panel.placeAwayFrom(null);
  // Above the row (its keep-out runs 16px around it), over as little of the query bar as that allows.
  assert.ok(panel.pos.top + 315 <= 559 - 16, `card at ${JSON.stringify(panel.pos)} covers the row`);
  assert.equal(panel.pos.top, 559 - 16 - 10 - 315);
  // Only the query bar is left under the card, which is no reason to hide the reasoning.
  assert.equal(panel.folds, 0);
});

test('a small ring counts for as much as a large one when no corner is clear', () => {
  // A wide chart along the top and a small count under it: clipping the chart's edge beats hiding the count.
  const panel = placementPanel({height: 360, rings: [
    {left: 302, right: 1440, top: 236, bottom: 562},
    {left: 316, right: 460, top: 600, bottom: 632},
  ]});
  panel.pos = {left: 18, top: 522};
  panel.placeAwayFrom(null);
  // Clipping the chart's edge beats hiding the count: the card is off the count's ring.
  const count = {left: 300, right: 476, top: 584, bottom: 648};
  const hidesCount = panel.pos.left < count.right && panel.pos.left + 468 > count.left && panel.pos.top < count.bottom && panel.pos.top + 360 > count.top;
  assert.ok(!hidesCount, `card at ${JSON.stringify(panel.pos)} hides the count`);
});

test('the reasoning folds when that is what clears the evidence, and the shorter card is then placed', () => {
  const panel = placementPanel({height: 463, rings: [{left: 321, right: 1423, top: 530, bottom: 554}]});
  panel.pos = {left: 18, top: 419};
  panel.foldReasoning = () => {
    if (panel.size !== 463) return false;
    panel.size = 356;
    return true;
  };
  panel.placeAwayFrom(null);
  assert.equal(panel.size, 356);
  assert.ok(panel.pos.top + 356 <= 530 - 16, `card at ${JSON.stringify(panel.pos)} covers the row`);
});
