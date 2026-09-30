import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../src/kibana-adapter.js', import.meta.url), 'utf8');
const QueryExplainer = new Function('location', `${source}\nreturn QueryExplainer;`)({});
const fields = ['@timestamp', 'http.response.status_code', 'url.path', 'service.name', 'message', 'event.outcome'];
const explain = (query, resultCount = null) => QueryExplainer.explain(query, fields, {resultCount});

test('missing_colon: a field linked to its value with is / = / == / equals', () => {
  for (const query of ['http.response.status_code is 503', 'http.response.status_code = 503',
    'http.response.status_code == 503', 'http.response.status_code equals 503', 'http.response.status_code=503']) {
    const result = explain(query, 0);
    assert.equal(result?.kind, 'missing_colon', query);
    assert.equal(result.fix, 'http.response.status_code: 503', query);
    assert.equal(result.message, `Kibana searched every field for the text ‘${query}’. KQL links a field to a value with a colon.`);
  }
});

test('missing_colon keeps the rest of the query, quoted values and negation', () => {
  assert.equal(explain('service.name: payments and url.path is "/api/pay"').fix, 'service.name: payments and url.path: "/api/pay"');
  assert.equal(explain('not http.response.status_code is 200').fix, 'not http.response.status_code: 200');
  // Text inside quotes is a value, not a field link.
  assert.equal(explain('message: "service.name is down"', 3), null);
  // Unknown words followed by "is" are ordinary free text, not a field.
  assert.equal(explain('checkout is slow', 0), null);
});

test('unknown_field suggests the closest field and a fix', () => {
  const result = explain('http.response.status: 503', 0);
  assert.equal(result.kind, 'unknown_field');
  assert.equal(result.suggestion, 'http.response.status_code');
  assert.equal(result.message, 'No field named http.response.status in this data view. Did you mean http.response.status_code?');
  assert.equal(result.fix, 'http.response.status_code: 503');
  const unrelated = explain('zzzzzz: 1', 0);
  assert.equal(unrelated.kind, 'unknown_field');
  assert.equal(unrelated.fix, undefined);
  // Keyword multi-fields and wildcards are fine.
  assert.equal(explain('service.name.keyword: payments', 4), null);
  assert.equal(explain('http.*: 503', 4), null);
});

test('value_absent names the field and value that matched nothing', () => {
  const result = explain('http.response.status_code: 599', 0);
  assert.equal(result.kind, 'value_absent');
  assert.equal(result.field, 'http.response.status_code');
  assert.equal(result.value, '599');
  assert.equal(result.message, "No http.response.status_code values of ‘599’ in this window. Check the field's Top values.");
  assert.equal(explain('url.path: "/api/nothing"', 0).value, '/api/nothing');
});

test('free_text_luck is only a note on a search that found documents', () => {
  const result = explain('503', 42);
  assert.equal(result.kind, 'free_text_luck');
  assert.equal(result.message, 'This worked, but it searches every field for 503. Naming the field says what you mean.');
  assert.equal(explain('503', 0), null);
  assert.equal(explain('503', null), null);
});

test('correct queries stay silent', () => {
  for (const query of ['http.response.status_code: 503', 'http.response.status_code >= 500',
    'not http.response.status_code: 200', 'service.name: payments and not message: "timeout"',
    '@timestamp > "2026-09-30T10:00:00"', '']) {
    assert.equal(explain(query, 12), null, query);
  }
});

test('without a field list, only dotted names count as fields', () => {
  assert.equal(QueryExplainer.explain('http.response.status_code is 503', [], {resultCount: 0}).kind, 'missing_colon');
  assert.equal(QueryExplainer.explain('madeup: 1', [], {resultCount: 0}).kind, 'value_absent');
});
