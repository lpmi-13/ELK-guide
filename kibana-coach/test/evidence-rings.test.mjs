// Evidence rings around page elements: elements next to each other share one ring around them all.
// Run with: node --test kibana-coach/test/*.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../src/ui/coach-panel.js', import.meta.url), 'utf8');
const Panel = new Function(`${source}\nreturn IncidentCoachPanel;`)();
const rect = (left, top, width, height) => ({left, top, width, height, right: left + width, bottom: top + height});

test('touching rows share one ring around them all, drawn by the first', () => {
  // The inspect step's pinned doc-viewer rows: one under the other, sharing a 1px border (and the third
  // row a little lower, as when a long field name wraps).
  const boxes = Panel.ringBoxes([rect(1400, 380, 480, 31), rect(1400, 410, 480, 31), rect(1400, 444, 480, 31)]);
  assert.deepEqual(boxes, [{left: 1395, top: 375, right: 1885, bottom: 480}, null, null]);
});

test('elements side by side share one ring across', () => {
  assert.deepEqual(Panel.ringBoxes([rect(100, 50, 80, 20), rect(184, 50, 80, 20)]), [{left: 95, top: 45, right: 269, bottom: 75}, null]);
});

test('a primary ring keeps its own colour beside ordinary ones', () => {
  const boxes = Panel.ringBoxes([rect(0, 0, 100, 20), rect(0, 20, 100, 20), rect(0, 40, 100, 20)], 5, 8, ['', 'primary', '']);
  assert.equal(boxes.filter(Boolean).length, 3);
});

test('rings far apart, rings around overlapping elements, and missing elements are left alone', () => {
  const [a, b, missing] = Panel.ringBoxes([rect(0, 0, 100, 20), rect(0, 200, 100, 20), null]);
  assert.deepEqual(a, {left: -5, top: -5, right: 105, bottom: 25});
  assert.deepEqual(b, {left: -5, top: 195, right: 105, bottom: 225});
  assert.equal(missing, null);
  const [outer, inner] = Panel.ringBoxes([rect(0, 0, 300, 200), rect(20, 20, 100, 40)]);
  assert.deepEqual([outer, inner], [{left: -5, top: -5, right: 305, bottom: 205}, {left: 15, top: 15, right: 125, bottom: 65}]);
});

// Each ring's live element, by registry name (or "pill" for a filter pill).
async function ringed(command, text) {
  const source = fs.readFileSync(new URL('../src/kibana-adapter.js', import.meta.url), 'utf8');
  const Adapter = new Function('location', `${source}\nreturn KibanaAdapter;`)({pathname: '/s/lab/app/discover'});
  const adapter = new Adapter();
  adapter.resolve = name => ({name});
  adapter.waitForTargets = async () => {};
  adapter.resultsSettled = async () => {};
  adapter.findFilterPill = () => ({name: 'pill'});
  const {targets} = await adapter.findEvidence(command, undefined, ...(text === undefined ? [] : [text]));
  return targets.map(target => target()?.name);
}

test('the hit count is ringed beside the chart, query or pill only when the card mentions it', async () => {
  const window = {type: 'set_time_range', value: {}};
  // The discover-time-window cards talk about the bars, never the number above them.
  assert.deepEqual(await ringed({...window, evidence: 'The histogram now starts at 22:14, just before the taller bars.'}), ['kibana.histogram']);
  assert.deepEqual(await ringed({...window, evidence: 'The histogram and hit count now start at 22:14.'}), ['kibana.histogram', 'kibana.result_count']);
  // A goal card is judged by its own line, not by the result card that follows it.
  const goal = {...window, evidence_focus: {kind: 'histogram'}, evidence: 'The hit count drops.'};
  assert.deepEqual(await ringed(goal, 'Looking at the histogram, I can see the bars rise.'), ['kibana.histogram']);
  const filter = {type: 'add_filter', value: {field: 'http.response.status_code', value: '503'}};
  assert.deepEqual(await ringed({...filter, evidence: 'The hit count dropped to just the 503 responses.'}), ['pill', 'kibana.result_count']);
  assert.deepEqual(await ringed({...filter, evidence: 'Both releases stay, and the legacy pool is gone.'}), ['pill']);
  assert.deepEqual(await ringed({type: 'enter_kql', evidence: 'The query keeps failed requests.'}), ['kibana.query_bar']);
});

test('field statistics marks only the requested primary row for the special ring', async () => {
  const source = fs.readFileSync(new URL('../src/kibana-adapter.js', import.meta.url), 'utf8');
  const Adapter = new Function('location', `${source}\nreturn KibanaAdapter;`)({pathname: '/app/discover'});
  const adapter = new Adapter();
  adapter.evidenceTargets = async focus => focus.fields.map(field => () => ({field}));
  const evidence = await adapter.findEvidence({type: 'show_field_statistics', value: {}, evidence_focus: {
    kind: 'field_cardinality', fields: ['service.name', 'service.version', 'host.name'], primary_field: 'service.name',
  }});
  assert.equal(evidence.primaryTargetIndex, 0);
  assert.equal(evidence.targets.length, 3);
  assert.match(Panel.styles, /incident-evidence-highlight\.primary \{[^}]*--ring:#0879a5/);
  const rendered = [];
  const panel = Object.create(Panel.prototype);
  panel.evidenceHighlights = [];
  panel.root = {append(highlight) { rendered.push(highlight); }};
  panel.refreshEvidenceHighlights = () => {};
  const originalDocument = globalThis.document;
  globalThis.document = {createElement: () => ({style: {setProperty() {}}, addEventListener() {}, setAttribute() {}, remove() {}})};
  try {
    panel.showEvidenceHighlights(evidence.columns, evidence.targets, evidence.fields, evidence.primaryTargetIndex);
  } finally {
    globalThis.document = originalDocument;
  }
  assert.deepEqual(rendered.map(highlight => highlight.className.includes(' primary')), [true, false, false]);
});

// The spotlight on the control the coach acts on arrives the way the evidence rings do.
function makeSpotlight() {
  const source = fs.readFileSync(new URL('../src/ui/spotlight.js', import.meta.url), 'utf8');
  const element = {
    style: {}, classes: new Set(), entrances: 0,
    classList: {
      add: name => { element.classes.add(name); if (name === 'entering') element.entrances += 1; },
      remove: name => element.classes.delete(name),
    },
    setAttribute() {},
    addEventListener(type, listener) { element[`on${type}`] = listener; },
    get offsetWidth() { return 0; },
  };
  Object.defineProperty(element.style, 'cssText', {set(value) {
    for (const part of value.split(';')) { const [key, val] = part.split(':'); element.style[key] = val; }
  }});
  const Spotlight = new Function('document', `${source}\nreturn IncidentSpotlight;`)({createElement: () => element});
  return {spotlight: new Spotlight({append() {}}), element};
}
const control = (left, top, width = 120, height = 32) => ({getBoundingClientRect: () => ({left, top, width, height})});

test('the action spotlight plays the ring entrance when it arrives on a control, not as it follows one', () => {
  const {spotlight, element} = makeSpotlight();
  const dateBox = control(1400, 100);
  spotlight.show(dateBox);
  assert.equal(element.entrances, 1);
  spotlight.show(dateBox); // a scroll or mutation re-places it
  assert.equal(element.entrances, 1);
  spotlight.show(control(1400.5, 100)); // the same control, re-rendered in place
  assert.equal(element.entrances, 1);
  spotlight.show(control(1200, 100, 400)); // on to the date input
  assert.equal(element.entrances, 2);
  element.onanimationend({animationName: 'ring-pulse'});
  assert.equal(element.classes.has('entering'), false);
  spotlight.hide();
  spotlight.show(control(1200, 100, 400)); // shown again after a beat without it
  assert.equal(element.entrances, 3);
});

test('the spotlight and the evidence rings share one ring and one entrance', () => {
  const styles = Panel.styles;
  for (const rule of ['::before { border:3px solid var(--ring)', '.entering { animation:ring-flash', '.entering::before { animation:ring-close', '.entering::after {']) {
    assert.ok(styles.includes(`:is(.incident-spotlight,.incident-evidence-highlight)${rule}`), rule);
  }
  assert.doesNotMatch(styles, /\.incident-spotlight \{[^}]*border:/);
});
