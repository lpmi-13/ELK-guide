import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// Load the adapter file with an injected `location`, returning the rison codec and adapter class.
function loadAdapter(location) {
  const source = fs.readFileSync(new URL('../src/kibana-adapter.js', import.meta.url), 'utf8');
  return new Function('location', `${source}\nreturn {KibanaRison, KibanaAdapter};`)(location);
}

// Exactly what Kibana 9.5.2 put in the URL after the learner submitted `status_code is 503`.
const deadEndHash = "#/view/abc?_g=(filters:!(),refreshInterval:(pause:!t,value:60000),time:(from:now-15m,to:now))"
  + "&_a=(columns:!('@timestamp',service.name),dataSource:(dataViewId:'930ca85b-2b16',type:dataView),filters:!(),interval:auto,"
  + "query:(language:kuery,query:'http.response.status_code%20is%20503'),sort:!(!('@timestamp',desc)))";

test('rison round-trips Kibana URL state, quoting what must be quoted', () => {
  const {KibanaRison} = loadAdapter({});
  const text = "(a:!(1,-2.5,!t,!f,!n),b:'it!'s a !!test',c:now-10m,d:'@timestamp',e:'',f:())";
  const value = KibanaRison.parse(text);
  assert.deepEqual(value, {a: [1, -2.5, true, false, null], b: "it's a !test", c: 'now-10m', d: '@timestamp', e: '', f: {}});
  assert.equal(KibanaRison.encode(value), text);
});

test('restoreDiscoverState replaces the dead-end query and filters, keeping the window by default', () => {
  const location = {pathname: '/s/lab/app/discover', hash: deadEndHash};
  const {KibanaRison, KibanaAdapter} = loadAdapter(location);
  const state = {baseline_time: {from: 'now-1h', to: 'now'}, time: {from: 'now-10m', to: 'now'}, query: null,
    filters: [{field: 'http.response.status_code', value: '503', negate: false}]};
  assert.equal(new KibanaAdapter().restoreDiscoverState(state), true);
  const params = Object.fromEntries(location.hash.split('?')[1].split('&').map(part => {
    const at = part.indexOf('=');
    return [part.slice(0, at), KibanaRison.parse(decodeURIComponent(part.slice(at + 1)))];
  }));
  assert.ok(location.hash.startsWith('#/view/abc?'));
  assert.deepEqual(params._a.query, {language: 'kuery', query: ''});
  assert.deepEqual(params._a.columns, ['@timestamp', 'service.name']);
  assert.equal(params._a.filters.length, 1);
  assert.deepEqual(params._a.filters[0].meta, {alias: null, disabled: false, index: '930ca85b-2b16', key: 'http.response.status_code', negate: false, params: {query: '503'}, type: 'phrase'});
  assert.deepEqual(params._a.filters[0].query, {match_phrase: {'http.response.status_code': '503'}});
  assert.deepEqual(params._g.time, {from: 'now-15m', to: 'now'});

  new KibanaAdapter().restoreDiscoverState(state, {includeTime: true});
  const global = KibanaRison.parse(decodeURIComponent(location.hash.match(/_g=([^&]*)/)[1]));
  assert.deepEqual(global.time, {from: 'now-10m', to: 'now'});
});

test('restoreDiscoverState leaves pages without Discover URL state alone', () => {
  const location = {pathname: '/s/lab/app/dashboards', hash: '#/view/x'};
  const {KibanaAdapter} = loadAdapter(location);
  assert.equal(new KibanaAdapter().restoreDiscoverState({}), false);
  assert.equal(location.hash, '#/view/x');
});
