// Evidence rings around page elements: rows that sit close together get rings that meet halfway
// instead of overlapping. Run with: node --test kibana-coach/test/*.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../src/ui/coach-panel.js', import.meta.url), 'utf8');
const Panel = new Function(`${source}\nreturn IncidentCoachPanel;`)();
const rect = (left, top, width, height) => ({left, top, width, height, right: left + width, bottom: top + height});
const overlap = (a, b) => Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);

test('rings around two touching rows meet halfway, a gap apart, and keep their outer padding', () => {
  // The inspect step's pinned doc-viewer rows: one directly under the other, sharing a 1px border.
  const [upper, lower] = Panel.ringBoxes([rect(1400, 380, 480, 31), rect(1400, 410, 480, 31)]);
  assert.equal(overlap(upper, lower), false);
  assert.equal(lower.top - upper.bottom, 4);
  assert.deepEqual([upper.left, upper.top, upper.right], [1395, 375, 1885]);
  assert.deepEqual([lower.left, lower.right, lower.bottom], [1395, 1885, 446]);
});

test('rings around elements side by side meet halfway across', () => {
  const [left, right] = Panel.ringBoxes([rect(100, 50, 80, 20), rect(184, 50, 80, 20)]);
  assert.equal(overlap(left, right), false);
  assert.equal(right.left - left.right, 4);
  assert.deepEqual([left.top, left.bottom, right.top, right.bottom], [45, 75, 45, 75]);
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
