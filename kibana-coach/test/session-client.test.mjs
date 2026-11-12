// The session client's handling of a session that ends or a service that goes away: an ended run or
// an unknown session stops automation and offers the launcher; a service that is merely unreachable
// is retried, visibly, with a way to retry at once. Run with: node --test kibana-coach/test/*.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function harness({probe = {status: 200, body: {available: true}}} = {}) {
  const sockets = [];
  const timers = [];
  const storage = new Map();
  class FakeSocket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
    open() { this.readyState = 1; this.onopen?.(); }
    drop() { this.readyState = 3; this.onclose?.(); }
    deliver(message) { this.onmessage?.({data: JSON.stringify(message)}); }
  }
  const fetches = [];
  const fetch = async (url, options) => {
    fetches.push({url, options});
    if (probe === 'unreachable') throw new TypeError('Failed to fetch');
    return {status: probe.status, ok: probe.status < 400, json: async () => probe.body};
  };
  const sessionStorage = {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)};
  const setTimeout = (callback, delay) => { timers.push({callback, delay}); return timers.length; };
  const code = fs.readFileSync(new URL('../src/session-client.js', import.meta.url), 'utf8');
  const Client = new Function('WebSocket', 'fetch', 'sessionStorage', 'location', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    `${code}\nreturn IncidentSessionClient;`)(FakeSocket, fetch, sessionStorage, {protocol: 'http:', hostname: 'localhost'},
    setTimeout, () => {}, () => 0, () => {});
  const client = new Client({server: 'http://localhost:5601/incident-coach/learning', session: 'session-1', token: 't', runId: 'run-1', mode: 'guided'});
  const events = {failed: [], status: [], errors: [], complete: 0};
  client.onFailed = message => events.failed.push(message);
  client.onStatus = (message, retry) => events.status.push({message, retry});
  client.onError = message => events.errors.push(message);
  client.onComplete = () => { events.complete += 1; };
  return {client, sockets, timers, fetches, events};
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('a failed message stops the client and reports the way back to the launcher', async () => {
  const {client, sockets, timers, events} = harness();
  await client.connect();
  sockets[0].open();
  sockets[0].deliver({message_type: 'failed', session_id: 'session-1', reason: 'aborted', error: 'This investigation has ended.', launcher_url: 'http://localhost:8090/'});
  assert.equal(events.failed.length, 1);
  assert.equal(events.failed[0].launcher_url, 'http://localhost:8090/');
  assert.equal(client.stopped, true);
  // The service closes the socket after a failure; a stopped client does not reconnect.
  sockets[0].drop();
  await settle();
  assert.equal(timers.length, 0);
  assert.equal(sockets.length, 1);
});

test('a socket that never opens for a session the service no longer knows ends the session', async () => {
  const {client, sockets, timers, fetches, events} = harness({probe: {status: 404, body: {error: 'session not found', launcher_url: 'http://localhost:8090/'}}});
  await client.connect();
  sockets[0].drop();
  await settle();
  assert.match(fetches[0].url, /\/incident-coach\/learning\/api\/sessions\/session-1$/);
  assert.equal(fetches[0].options.headers.Authorization, 'Bearer t');
  assert.deepEqual(events.failed.map(message => [message.reason, message.launcher_url]), [['missing', 'http://localhost:8090/']]);
  assert.equal(timers.length, 0, 'no reconnect is scheduled for an ended session');
});

test('an unreachable service is retried with a growing pause and a Retry now action', async () => {
  const {client, sockets, timers, events} = harness({probe: 'unreachable'});
  await client.connect();
  sockets[0].drop();
  await settle();
  assert.equal(events.failed.length, 0);
  assert.equal(timers[0].delay, 1500);
  assert.equal(typeof events.status.at(-1).retry, 'function');
  // Retry now opens a socket at once; when that one drops too, the next pause is longer.
  events.status.at(-1).retry();
  assert.equal(sockets.length, 2);
  sockets[1].drop();
  await settle();
  assert.equal(timers.at(-1).delay, 3000);
  assert.match(events.status.at(-1).message, /not answering/);
  // Once it is back, the status clears and the pause resets.
  timers.at(-1).callback();
  sockets[2].open();
  assert.equal(events.status.at(-1).message, '');
  sockets[2].drop();
  assert.equal(timers.at(-1).delay, 1500);
});

test('a dropped socket that had been open reconnects without asking whether the session ended', async () => {
  const {client, sockets, fetches, timers} = harness();
  await client.connect();
  sockets[0].open();
  sockets[0].drop();
  await settle();
  assert.equal(fetches.length, 0);
  assert.equal(timers.length, 1);
});

test('status and acknowledgement messages are accepted silently; errors and completion reach the coach', async () => {
  const {client, sockets, events} = harness();
  await client.connect();
  sockets[0].open();
  sockets[0].deliver({message_type: 'status', paused: true});
  sockets[0].deliver({message_type: 'acknowledged', command_id: 'c-1'});
  sockets[0].deliver({message_type: 'error', error: 'action sequence must increase monotonically'});
  sockets[0].deliver({message_type: 'complete', session_id: 'session-1'});
  assert.deepEqual(events.errors, ['action sequence must increase monotonically']);
  assert.equal(events.complete, 1);
  assert.equal(events.failed.length, 0);
});

test('pause and resume go to the service as their own messages', async () => {
  const {client, sockets} = harness();
  await client.connect();
  sockets[0].open();
  client.setPaused(true);
  client.setPaused(false);
  assert.deepEqual(sockets[0].sent.map(message => message.message_type), ['pause', 'resume']);
});

test('an action observed while the socket is reconnecting is sent, in order, once it is open again', async () => {
  const {client, sockets, timers} = harness();
  await client.connect();
  sockets[0].open();
  sockets[0].drop();
  await settle();
  client.sendAction({type: 'panel_underlying_data_opened', details: {panel: 'Failures by service'}});
  client.sendAction({type: 'column_added', details: {field: 'trace.id'}});
  assert.throws(() => client.requestHint(), /not connected/, 'only observed actions wait for the socket');
  timers.at(-1).callback();
  sockets[1].open();
  assert.deepEqual(sockets[1].sent.map(message => [message.action.type, message.action.sequence]), [['panel_underlying_data_opened', 1], ['column_added', 2]]);
});
