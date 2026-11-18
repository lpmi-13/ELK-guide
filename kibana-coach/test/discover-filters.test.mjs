// The Discover filter commands beyond Add filter: a Top value's + / −, a pill's Include / Exclude
// results, and "Filter for field present". Fixtures use the 9.5.2 test subjects verified live.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const visible = () => [{}];

function loadDiscover(document) {
  const source = fs.readFileSync(new URL('../src/adapters/discover.js', import.meta.url), 'utf8');
  globalThis.KibanaApplicationAdapters = [];
  return new Function('document', 'location', `${source}\nreturn globalThis.KibanaApplicationAdapters.find(item => item.name === 'discover');`)(document, {href: '', pathname: '/app/discover'});
}

// A host that records what the coach pointed at, and how.
function makeHost(extra = {}) {
  const pointed = [];
  return {
    pointed,
    pointAt: async (target, _coach, _scale, _signal, activity, options = {}) => { pointed.push({target, activity, options}); },
    settle: async () => {},
    wait: async () => {},
    ...extra,
  };
}

// The authentication.rejection_reason Top values popover, already open.
function topValuesPopover(field, values) {
  const buckets = values.map(value => {
    const plus = {subject: `plus-${field}-${value}`, getClientRects: visible};
    const minus = {subject: `minus-${field}-${value}`, getClientRects: visible};
    return {
      plus, minus,
      querySelector: selector => selector.includes('formattedFieldValue') ? {textContent: value}
        : selector.includes("^='plus-'") ? plus : selector.includes("^='minus-'") ? minus : null,
    };
  });
  return {
    buckets,
    getClientRects: visible,
    querySelector: selector => selector.includes('fieldPopoverHeader_fieldDisplayName') ? {textContent: field} : null,
    querySelectorAll: () => buckets,
  };
}

test('filter_top_value clicks the − next to the value in its open Top values and reports the excluding filter', async () => {
  const field = 'authentication.rejection_reason';
  const popover = topValuesPopover(field, ['token_reuse', 'bad_password']);
  const discover = loadDiscover({querySelectorAll: () => [popover], querySelector: () => null});
  const host = makeHost();
  const result = await discover.perform({type: 'filter_top_value', value: {field, value: 'token_reuse', negate: true}}, host, {}, {});
  assert.equal(host.pointed.length, 1, 'the popover was already open, so the only move is the −');
  assert.equal(host.pointed[0].target, popover.buckets[0].minus);
  assert.equal(host.pointed[0].activity, 'Click the − next to token_reuse to filter it out.');
  assert.equal(host.pointed[0].options.activate, true);
  assert.deepEqual(result, {type: 'filter_added', details: {field, value: 'token_reuse', negate: true}, state_after: {}});
});

test('set_filter_inclusion opens the pill and chooses Include results', async () => {
  const pill = {getAttribute: () => 'filter-badge-1 filter filter-enabled filter-key-authentication.rejection_reason.keyword filter-value-token_reuse filter-negated filter-id-0'};
  const option = {textContent: 'Include results', getClientRects: visible};
  const discover = loadDiscover({querySelectorAll: () => [], querySelector: selector => (selector.includes('negateFilter') ? option : null)});
  const host = makeHost({findFilterPill: () => pill});
  const result = await discover.perform({type: 'set_filter_inclusion', value: {field: 'authentication.rejection_reason', value: 'token_reuse', include: true}}, host, {}, {});
  assert.deepEqual(host.pointed.map(move => [move.target, move.activity]), [
    [pill, 'Click the authentication.rejection_reason pill to open its menu.'],
    [option, 'Choose “Include results”.'],
  ]);
  assert.deepEqual(result.details, {field: 'authentication.rejection_reason', value: 'token_reuse', negate: false});
  assert.equal(result.type, 'filter_changed');
});

test('set_filter_inclusion only points at a pill that already includes its value', async () => {
  const pill = {getAttribute: () => 'filter-badge-1 filter filter-enabled filter-key-service.name filter-value-payments filter-id-0'};
  const discover = loadDiscover({querySelectorAll: () => [], querySelector: () => null});
  const host = makeHost({findFilterPill: () => pill});
  await discover.perform({type: 'set_filter_inclusion', value: {field: 'service.name', value: 'payments', include: true}}, host, {}, {});
  assert.equal(host.pointed.length, 1);
  assert.equal(host.pointed[0].options.showClick, false);
  assert.match(host.pointed[0].activity, /already keeps payments/);
});

test('filter_field_present clicks "Filter for field present" in the open popover and reports an exists filter', async () => {
  const popover = topValuesPopover('error.type', ['LedgerRoundingError']);
  const present = {getClientRects: visible};
  const discover = loadDiscover({
    querySelectorAll: () => [popover],
    querySelector: selector => (selector.includes("discoverFieldListPanelAddExistFilter-error.type") ? present : null),
  });
  const host = makeHost();
  const result = await discover.perform({type: 'filter_field_present', value: {field: 'error.type'}}, host, {}, {});
  assert.equal(host.pointed.length, 1);
  assert.equal(host.pointed[0].target, present);
  assert.match(host.pointed[0].activity, /Filter for field present/);
  assert.deepEqual(result.details, {field: 'error.type', value: 'exists', type: 'exists', negate: false});
});

test('show_field_statistics switches to Field statistics and waits for its table', async () => {
  const tab = {getClientRects: visible};
  const loaded = {getClientRects: visible};
  let switched = false;
  const discover = loadDiscover({
    querySelectorAll: () => [],
    querySelector: selector => selector.includes('dscViewModeFieldStatsButton') ? tab
      : selector.includes('dataVisualizerTable-loaded') ? (switched ? loaded : null)
        : selector.includes('dataVisualizerTableContainer') ? (switched ? loaded : null) : null,
  });
  const host = makeHost({pointAt: async (target, _coach, _scale, _signal, activity) => { host.pointed.push({target, activity}); switched = true; }});
  const result = await discover.perform({type: 'show_field_statistics', value: {fields: ['service.name', 'trace.id']}}, host, {}, {});
  assert.equal(host.pointed[0].target, tab);
  assert.match(host.pointed[0].activity, /Field statistics/);
  assert.deepEqual(result, {type: 'field_statistics_opened', details: {view: 'field_statistics'}, state_after: {}});
  // Already showing: nothing to click.
  const again = makeHost();
  await discover.perform({type: 'show_field_statistics', value: {}}, again, {}, {});
  assert.equal(again.pointed.length, 0);
});
