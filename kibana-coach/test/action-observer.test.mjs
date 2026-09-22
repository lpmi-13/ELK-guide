// DOM-fixture tests for the runtime observer's filter / column / auto-refresh capture.
// The learner performs an action in real Kibana and the coach observes it, so this parsing
// is the critical path for Guided and Solo. Run with: node --test kibana-coach/test
//
// These fixtures encode Kibana's documented filter-pill shape; they guard the parsing logic,
// not the live selectors, which still need confirmation against a running Kibana 9.5.2
// (see NEXT_STEPS_INTERMEDIATE_PLAN.md Part 1).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function element({subject = '', text = '', value, gridColumn} = {}) {
  const node = {
    getAttribute: name => (name === 'data-test-subj' ? subject : name === 'aria-label' ? text : null),
    textContent: text,
    value,
  };
  node.closest = selector => {
    if (selector.includes('data-gridcell-column-id')) return gridColumn ? {getAttribute: () => gridColumn} : null;
    if (selector.includes('data-test-subj')) return subject ? node : null;
    return null;
  };
  return node;
}

// A minimal document/location the observer can read. Tests set `pills` and `bySubject`.
function makeDom() {
  const dom = {pills: [], bySubject: {}};
  const document = {
    querySelectorAll: () => dom.pills,
    querySelector: selector => {
      const match = selector.match(/data-test-subj='([^']+)'/);
      return match ? dom.bySubject[match[1]] || null : null;
    },
  };
  return {dom, document};
}

// Load the observer in this realm (not a vm sandbox) so the objects it builds share this
// realm's prototypes and compare with deepStrictEqual. `document`/`location` are injected as
// locals; the file's trailing globalThis assignment is harmless.
function loadObserver(document, location = {pathname: '/app/discover', hash: '', href: ''}) {
  const code = fs.readFileSync(new URL('../src/action-observer.js', import.meta.url), 'utf8');
  const factory = new Function('document', 'location', 'setTimeout', `${code}\nreturn KibanaActionObserver;`);
  return factory(document, location, setTimeout);
}

function makeObserver(document, location) {
  const Observer = loadObserver(document, location);
  const reports = [];
  const adapter = {performing: false, resolve: () => null};
  const observer = new Observer(adapter, event => reports.push(event));
  return {observer, reports};
}

test('readFilterPills captures field, value, and negate from the real 9.5.2 pill data-test-subj', () => {
  const {dom, document} = makeDom();
  const {observer} = makeObserver(document);
  // Exact data-test-subj strings captured from Kibana 9.5.2 via Playwright (harvest pass).
  dom.pills = [
    element({subject: 'filter-badge-42 filter filter-enabled filter-key-authentication.rejection_reason filter-value-expired_nonce filter-unpinned filter-id-0', text: 'authentication.rejection_reason: expired_nonce'}),
    // Top-value filter-out applies the .keyword multi-field; the scenario names the base field.
    element({subject: 'filter-badge-1300192327 filter filter-enabled filter-key-service.name.keyword filter-value-catalog filter-unpinned filter-negated filter-id-0', text: 'NOT service.name.keyword: catalog'}),
    // Add-filter popover uses the raw field name.
    element({subject: 'filter-badge-1044241758 filter filter-enabled filter-key-url.path filter-value-/checkout filter-unpinned filter-negated filter-id-0', text: 'NOT url.path: /checkout'}),
  ];
  assert.deepEqual(observer.readFilterPills(), [
    {field: 'authentication.rejection_reason', value: 'expired_nonce', negate: false},
    {field: 'service.name', value: 'catalog', negate: true},
    {field: 'url.path', value: '/checkout', negate: true},
  ]);
});

test('readFilterPills falls back to the pill text when structured tokens are absent', () => {
  const {dom, document} = makeDom();
  const {observer} = makeObserver(document);
  dom.pills = [element({subject: 'filterItem', text: 'NOT service.name: "payments"'})];
  assert.deepEqual(observer.readFilterPills(), [{field: 'service.name', value: 'payments', negate: true}]);
});

test('a top-value filter-out (minus-<field>-<value>) reports filter_added with the negated pill', async () => {
  const {dom, document} = makeDom();
  const {observer, reports} = makeObserver(document);
  dom.pills = [element({subject: 'filter-badge-99 filter filter-enabled filter-key-event.outcome.keyword filter-value-success filter-negated filter-id-0', text: 'NOT event.outcome: success'})];
  observer.onClick({target: element({subject: 'minus-event.outcome-success'})});
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(reports.length, 1);
  assert.equal(reports[0].type, 'filter_added');
  assert.deepEqual(reports[0].state_after.filters, [{field: 'event.outcome', value: 'success', negate: true}]);
  assert.equal(reports[0].details.negate, true);
});

test('fieldToggle add/remove is disambiguated by the button aria-label', () => {
  const {document} = makeDom();
  const {observer, reports} = makeObserver(document);
  // Same data-test-subj for both directions in 9.5.2; the aria-label distinguishes them.
  observer.onClick({target: element({subject: 'fieldToggle-service.version', text: 'Add field as column'})});
  observer.onClick({target: element({subject: 'fieldToggle-service.version', text: 'Remove field from table'})});
  assert.deepEqual(reports.map(report => report.type), ['column_added', 'column_removed']);
  assert.equal(reports[0].details.field, 'service.version');
  assert.equal(reports[1].details.field, 'service.version');
});

test('readTimeRange parses the applied window from the _g global state in the URL', () => {
  const {document} = makeDom();
  const href = "http://localhost:5601/s/lab-1/app/discover#/view/incident-investigation?_g=(time:(from:now-15m,to:now))&_a=(query:(language:kuery))";
  const {observer} = makeObserver(document, {pathname: '/app/discover', href});
  assert.deepEqual(observer.readTimeRange(), {from: 'now-15m', to: 'now', source: 'global_state'});
  assert.equal(observer.timeRangeMinutes('now-15m', 'now'), 15);
  assert.equal(observer.timeRangeMinutes('now-1h', 'now'), 60);
});

test('captureTimeRange reports the real window with its look-back minutes', () => {
  const {document} = makeDom();
  const href = "http://localhost:5601/app/discover#/?_g=(time:(from:now-15m,to:now))";
  const {observer, reports} = makeObserver(document, {pathname: '/app/discover', href});
  observer.captureTimeRange(true);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].type, 'time_range_changed');
  assert.equal(reports[0].details.from, 'now-15m');
  assert.equal(reports[0].details.from_minutes, 15);
  assert.equal(reports[0].state_after.time_from, 'now-15m');
});

test('a superDatePickerApplyTimeButton click captures the window after the URL settles', async () => {
  const {document} = makeDom();
  const href = "http://localhost:5601/app/discover#/?_g=(time:(from:now-30m,to:now))";
  const {observer, reports} = makeObserver(document, {pathname: '/app/discover', href});
  observer.onClick({target: element({subject: 'superDatePickerApplyTimeButton'})});
  await new Promise(resolve => setTimeout(resolve, 320));
  assert.equal(reports.length, 1);
  assert.equal(reports[0].type, 'time_range_changed');
  assert.equal(reports[0].details.from_minutes, 30);
});

test('clicking a date-picker preset (Last 15 minutes) captures the window even when it equals the default', async () => {
  const {document} = makeDom();
  // Discover opens at now-15m; the learner clicks the "Last 15 minutes" preset, so the URL never
  // changes. The poll can't see that, so the click must force a capture (verified 9.5.2 subject).
  const href = "http://localhost:5601/s/lab-1/app/discover#/?_g=(time:(from:now-15m,to:now))";
  const {observer, reports} = makeObserver(document, {pathname: '/app/discover', href});
  observer.lastTimeSignature = 'now-15m|now'; // baseline already adopted (no change on click)
  observer.onClick({target: element({subject: 'dateRangePickerPresetItem-Last_15_minutes'})});
  await new Promise(resolve => setTimeout(resolve, 320));
  assert.equal(reports.length, 1);
  assert.equal(reports[0].type, 'time_range_changed');
  assert.equal(reports[0].details.from, 'now-15m');
  assert.equal(reports[0].details.from_minutes, 15);
});

test('switching to the Custom range / Calendar tab does not report a window on its own', async () => {
  const {document} = makeDom();
  const href = "http://localhost:5601/app/discover#/?_g=(time:(from:now-15m,to:now))";
  const {observer, reports} = makeObserver(document, {pathname: '/app/discover', href});
  observer.onClick({target: element({subject: 'dateRangePickerCustomRangeNavItem'})});
  observer.onClick({target: element({subject: 'dateRangePickerCalendarNavItem'})});
  await new Promise(resolve => setTimeout(resolve, 320));
  assert.equal(reports.length, 0);
});

test('the time-range poll ignores the initial load and only reports a real change', () => {
  const {document} = makeDom();
  const loc = {pathname: '/app/discover', href: ''};
  const {observer, reports} = makeObserver(document, loc);
  observer.captureTimeRange(false); // no window yet on load -> nothing to report
  assert.equal(reports.length, 0);
  loc.href = "http://x/app/discover#/?_g=(time:(from:now-15m,to:now))"; // app populates the default
  observer.captureTimeRange(false); // just adopting the baseline, still no report
  assert.equal(reports.length, 0);
  loc.href = "http://x/app/discover#/?_g=(time:(from:now-30m,to:now))"; // learner changes it
  observer.captureTimeRange(false);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].details.from, 'now-30m');
});

test('a refresh-interval interaction reports auto_refresh_changed', async () => {
  const {dom, document} = makeDom();
  const {observer, reports} = makeObserver(document);
  dom.bySubject['superDatePickerRefreshIntervalInput'] = element({value: '10'});
  dom.bySubject['superDatePickerToggleRefreshButton'] = element({text: 'Pause'});
  observer.onClick({target: element({subject: 'superDatePickerToggleRefreshButton'})});
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(reports.length, 1);
  assert.equal(reports[0].type, 'auto_refresh_changed');
  assert.equal(reports[0].details.interval, '10');
});

test('opening a field preview popover reports field_statistics_opened with the field name', () => {
  // Surveying a field's distribution is a first-class step (status-code / endpoint surveys), so the
  // observer must name WHICH field a learner previewed. Kibana 9.5.2 uses the field row's "Preview"
  // button `field-<field>-showDetails` inside the `dscFieldListPanelField-<field>` wrapper.
  const {document} = makeDom();
  const {observer, reports} = makeObserver(document);
  observer.onClick({target: element({subject: 'field-http.response.status_code-showDetails'})});
  observer.onClick({target: element({subject: 'dscFieldListPanelField-url.path'})});
  assert.equal(reports.length, 2);
  assert.deepEqual(reports.map(report => report.type), ['field_statistics_opened', 'field_statistics_opened']);
  assert.equal(reports[0].details.field, 'http.response.status_code');
  assert.equal(reports[1].details.field, 'url.path');
});

test('a non-field control click is not mistaken for a field preview', () => {
  const {document} = makeDom();
  const {observer, reports} = makeObserver(document);
  observer.onClick({target: element({subject: 'dateRangePickerCustomRangeNavItem'})});
  observer.onClick({target: element({subject: 'someUnrelatedButton'})});
  assert.equal(reports.length, 0);
});
