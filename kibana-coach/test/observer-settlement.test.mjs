// A learner's action is reported only once Kibana shows its result. An old hit count, a menu that was
// merely opened, or a click whose result never appeared must not be reported as done — the service
// would advance a goal on it. Timings follow live Kibana 9.5.2 (probed 2026-11-12): a Discover search
// POSTs /internal/search/ese ~350-650 ms after Enter and the previous count stays until it returns;
// the document viewer opens ~750 ms after its toggle. Run with: node --test kibana-coach/test/*.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// A page whose elements the test puts in place (by data-test-subj) as Kibana would, over time.
function makePage(pathname = '/s/lab-1/app/discover') {
  const page = {elements: {}, pills: [], storage: new Map(), location: {pathname, search: '', hash: '', href: `http://localhost:5601${pathname}#/`}};
  page.show = (subject, props = {}) => { page.elements[subject] = node(subject, props); };
  page.hide = subject => { delete page.elements[subject]; };
  page.document = {
    querySelector(selector) {
      for (const part of selector.split(',')) {
        const match = part.match(/data-test-subj='([^']+)'/);
        if (match && page.elements[match[1]]) return page.elements[match[1]];
      }
      return null;
    },
    querySelectorAll: selector => (selector.includes('filter-key-') ? page.pills : []),
    addEventListener() {},
    removeEventListener() {},
  };
  page.sessionStorage = {
    getItem: key => page.storage.get(key) ?? null,
    setItem: (key, value) => page.storage.set(key, String(value)),
    removeItem: key => page.storage.delete(key),
  };
  return page;
}

function node(subject, {text = '', value, closest = {}} = {}) {
  const element = {
    textContent: text, value,
    getAttribute: name => (name === 'data-test-subj' ? subject : null),
    getClientRects: () => [{}],
    matches: selector => selector.includes(`'${subject}'`),
    closest: selector => {
      for (const [key, found] of Object.entries(closest)) if (selector.includes(key)) return found;
      return selector.includes('data-test-subj') ? element : null;
    },
    querySelector: () => null,
  };
  return element;
}

function pill(field, value, negate = false) {
  const subject = `filter-badge-1 filter filter-enabled filter-key-${field} filter-value-${value}${negate ? ' filter-negated' : ''}`;
  return node(subject, {text: `${negate ? 'NOT ' : ''}${field}: ${value}`});
}

// Kibana's search requests as kibana-bootstrap.js counts them.
function searches() {
  globalThis.__coachSearches = {started: 0, finished: 0, failed: 0, inFlight: 0};
  const state = globalThis.__coachSearches;
  return {
    start() { state.started += 1; state.inFlight += 1; },
    finish() { state.inFlight -= 1; state.finished += 1; },
  };
}

function observe(page, resolved = {}) {
  const code = fs.readFileSync(new URL('../src/action-observer.js', import.meta.url), 'utf8');
  const Observer = new Function('document', 'location', 'sessionStorage', `${code}\nreturn KibanaActionObserver;`)(page.document, page.location, page.sessionStorage);
  Observer.SEARCH_WAIT_MS = 2500;
  Observer.UI_WAIT_MS = 1500;
  Observer.DOCUMENT_WAIT_MS = 1500;
  Observer.PIVOT_WAIT_MS = 400;
  const reports = [];
  const adapter = {performing: false, resolve: name => resolved[name]?.() ?? null, currentView: () => ({language: 'kql'})};
  const observer = new Observer(adapter, action => reports.push(action));
  return {Observer, observer, reports};
}

test('a submitted query reports the count its own search returned, not the count still on screen', async () => {
  const page = makePage();
  const network = searches();
  page.show('discoverQueryHits', {text: '66,824'});
  const queryBar = node('queryInput', {value: 'http.response.status_code : 503'});
  const {observer, reports} = observe(page, {'kibana.query_bar': () => queryBar});
  observer.onKey({key: 'Enter', target: queryBar});
  // Live 9.5.2: no busy marker this time, and the search only starts after the old 1 s grace.
  await wait(1200);
  assert.equal(reports.length, 0, 'nothing is reported while the old count is all there is');
  network.start();
  await wait(150);
  page.hide('discoverQueryHits');
  page.show('discoverNoResults');
  network.finish();
  await wait(200);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].type, 'query_submitted');
  assert.equal(reports[0].state_after.result_count, 0);
  assert.equal(reports[0].state_after.result_settled, undefined);
});

test('the grid’s updating overlay alone also marks the refetch', async () => {
  const page = makePage();
  searches();
  page.show('discoverQueryHits', {text: '120'});
  const queryBar = node('queryInput', {value: 'service.name : "payments"'});
  const {observer, reports} = observe(page, {'kibana.query_bar': () => queryBar});
  observer.onKey({key: 'Enter', target: queryBar});
  await wait(300);
  page.show('discoverDataGridUpdating');
  await wait(300);
  page.show('discoverQueryHits', {text: '42'});
  page.hide('discoverDataGridUpdating');
  await wait(150);
  assert.equal(reports[0].state_after.result_count, 42);
});

test('a search that never comes back is reported as unsettled, without a count', async () => {
  const page = makePage();
  const network = searches();
  page.show('discoverQueryHits', {text: '66,824'});
  const queryBar = node('queryInput', {value: 'http.response.status_code : 503'});
  const {observer, reports} = observe(page, {'kibana.query_bar': () => queryBar});
  observer.onKey({key: 'Enter', target: queryBar});
  network.start(); // in flight until after the deadline
  await wait(2800);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].state_after.result_settled, false);
  assert.equal('result_count' in reports[0].state_after, false);
});

test('Save on a filter that never appears reports nothing, even with an earlier pill on screen', async () => {
  const page = makePage();
  searches();
  page.pills = [pill('url.path', '/checkout')];
  page.show('discoverQueryHits', {text: '500'});
  const {observer, reports} = observe(page);
  observer.onClick({target: node('saveFilter')});
  await wait(1700);
  assert.deepEqual(reports, []);
});

test('a pill that appears late is reported (not an older one) once its search settles', async () => {
  const page = makePage();
  const network = searches();
  page.pills = [pill('url.path', '/checkout')];
  page.show('discoverQueryHits', {text: '500'});
  const {observer, reports} = observe(page);
  observer.onClick({target: node('saveFilter')});
  await wait(900); // after the old fixed 250 ms read
  page.pills = [pill('url.path', '/checkout'), pill('http.response.status_code', '503')];
  network.start();
  await wait(100);
  page.show('discoverQueryHits', {text: '37'});
  network.finish();
  await wait(200);
  assert.equal(reports.length, 1);
  assert.deepEqual([reports[0].type, reports[0].details.field, reports[0].details.value], ['filter_added', 'http.response.status_code', '503']);
  assert.equal(reports[0].state_after.result_count, 37);
});

test('opening or clicking inside the time picker’s menu is not a window change; a pick is', async () => {
  const page = makePage();
  page.location.href = 'http://localhost:5601/app/discover#/?_g=(time:(from:now-1h,to:now))';
  const {observer, reports} = observe(page);
  observer.onClick({target: node('dateRangePickerControlButton')});
  observer.onClick({target: node('superDatePickerToggleQuickMenuButton')});
  observer.onClick({target: node('superDatePickerQuickMenu')});
  await wait(350);
  assert.deepEqual(reports, []);
  observer.onClick({target: node('superDatePickerCommonlyUsed_Last_1 hour')});
  await wait(350);
  assert.deepEqual(reports.map(report => report.type), ['time_range_changed']);
});

test('a field preview counts once its popover opens; the click that closes it does not', async () => {
  const page = makePage();
  const {observer, reports} = observe(page);
  page.show('fieldPopoverHeader_fieldDisplayName');
  observer.onClick({target: node('field-url.path-showDetails')}); // closes the open popover
  page.hide('fieldPopoverHeader_fieldDisplayName');
  await wait(300);
  observer.onClick({target: node('field-service.name-showDetails')}); // a popover that never renders
  await wait(1700);
  assert.deepEqual(reports, []);
});

test('expanding a document is reported once the viewer is open, with the trace it shows', async () => {
  const page = makePage();
  const firstRowTrace = node('first-trace', {text: 'trace-in-the-first-row'});
  const flyoutTrace = node('tableDocViewRow-trace.id-value', {text: 'trace-of-the-opened-document'});
  const {observer, reports} = observe(page, {
    'kibana.first_trace_value': () => firstRowTrace,
    'kibana.trace_field': () => (page.elements.docViewerFlyout ? flyoutTrace : null),
  });
  observer.onClick({target: node('docTableExpandToggleColumn')});
  await wait(750);
  assert.deepEqual(reports, [], 'nothing before the viewer opens');
  page.show('docViewerFlyout');
  await wait(100);
  assert.deepEqual(reports.map(report => [report.type, report.details.trace_id]), [['trace_opened', 'trace-of-the-opened-document']]);
});

test('an expand click that opens no document reports nothing', async () => {
  const page = makePage();
  const {observer, reports} = observe(page, {'kibana.first_trace_value': () => node('first-trace', {text: 'trace-in-the-first-row'})});
  observer.onClick({target: node('docTableExpandToggleColumn')});
  await wait(1700);
  assert.deepEqual(reports, []);
});

test('a dashboard pivot that never leaves the dashboard is not reported', async () => {
  const page = makePage('/s/lab-1/app/dashboards');
  const {Observer, observer, reports} = observe(page);
  observer.onClick({target: node('embeddablePanelAction-ACTION_OPEN_IN_DISCOVER')});
  assert.deepEqual(reports, [], 'not on the click');
  assert.ok(page.storage.get(Observer.PIVOT_KEY), 'held for the page it leads to');
  await wait(800);
  observer.stop();
  assert.deepEqual(reports, []);
  assert.equal(page.storage.get(Observer.PIVOT_KEY), undefined, 'dropped once it had time to arrive');
});

test('a dashboard pivot is reported by the Discover page it opened, once its search settles', async () => {
  const dashboard = makePage('/s/lab-1/app/dashboards');
  const {Observer, observer} = observe(dashboard);
  observer.onClick({target: node('embeddablePanelAction-ACTION_OPEN_IN_DISCOVER')});
  observer.stop();
  // The adapter keeps the navigation in this tab: a new page, the same tab storage.
  const discover = makePage('/s/lab-1/app/discover');
  discover.storage = dashboard.storage;
  searches();
  discover.show('discoverQueryHits', {text: '1,204'});
  const arrived = observe(discover);
  arrived.observer.start();
  await wait(1300);
  arrived.observer.stop();
  assert.deepEqual(arrived.reports.map(report => [report.type, report.state_after.app, report.state_after.result_count]),
    [['panel_underlying_data_opened', 'discover', 1204]]);
  assert.equal(discover.storage.get(Observer.PIVOT_KEY), undefined);
});

test('an old held pivot is not reported by a later page', async () => {
  const discover = makePage('/s/lab-1/app/discover');
  const {Observer, observer, reports} = observe(discover);
  discover.storage.set(Observer.PIVOT_KEY, JSON.stringify({action: {type: 'panel_underlying_data_opened', details: {}}, from: '/app/dashboards', app: 'dashboards', at: Date.now() - 120000}));
  observer.start();
  await wait(300);
  observer.stop();
  assert.deepEqual(reports, []);
  assert.equal(discover.storage.get(Observer.PIVOT_KEY), undefined);
});

test('a pivot that lands on Kibana’s /app/r redirect is reported from Discover, not from the redirect', async () => {
  const dashboard = makePage('/s/lab-1/app/dashboards');
  const {observer} = observe(dashboard);
  observer.onClick({target: node('embeddablePanelAction-ACTION_OPEN_IN_DISCOVER')});
  observer.stop();
  const redirect = makePage('/s/lab-1/app/r');
  redirect.storage = dashboard.storage;
  searches();
  const arrived = observe(redirect);
  arrived.observer.start();
  await wait(500);
  assert.deepEqual(arrived.reports, [], 'nothing while still on /app/r');
  redirect.location.pathname = '/s/lab-1/app/discover';
  redirect.show('discoverQueryHits', {text: '87'});
  await wait(400);
  arrived.observer.stop();
  assert.deepEqual(arrived.reports.map(report => [report.type, report.state_after.app, report.state_after.result_count]), [['panel_underlying_data_opened', 'discover', 87]]);
});
