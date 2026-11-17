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
