import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function makeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    performance: {now: () => now},
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, {callback, at: now + delay});
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    advance(milliseconds) {
      const until = now + milliseconds;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > until) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = until;
    },
  };
}

async function makeDemo() {
  const clock = makeClock();
  const calls = {countdowns: [], resumes: [], commands: 0, actions: 0, messages: []};
  let coach;
  let client;
  class Coach {
    constructor() { coach = this; this.paused = false; }
    setPaused(paused) { this.paused = paused; this.onPause?.(paused); }
    showCommand() { calls.commands++; }
    startCountdown(duration) { calls.countdowns.push(duration); }
    stopCountdown() {}
    resumeCountdown(remaining) { calls.resumes.push(remaining); }
    showLearning() {}
    beginActionPhase() {}
    finishCommand() {}
    toast() {}
  }
  class Adapter {
    async initialize() {}
    async resolveAnchor() { return null; }
    async perform() { calls.actions++; return null; }
  }
  class Client {
    constructor() { client = this; }
    async connect() { return {session_id: 'test'}; }
    send(message) { calls.messages.push(message); }
    acknowledge() {}
  }
  class Observer { start() {} stop() {} }
  const source = fs.readFileSync(new URL('../src/content-script.js', import.meta.url), 'utf8');
  const document = {
    readyState: 'complete',
    querySelector: () => null,
    createElement: () => ({}),
    documentElement: {append() {}},
  };
  const storage = {getItem: () => JSON.stringify({session: 'test'})};
  const window = {};
  const run = new Function('document', 'window', 'sessionStorage', 'IncidentCoachPanel',
    'KibanaAdapter', 'IncidentSessionClient', 'KibanaActionObserver',
    'setTimeout', 'clearTimeout', 'performance', source);
  run(document, window, storage, Coach, Adapter, Client, Observer,
    clock.setTimeout.bind(clock), clock.clearTimeout.bind(clock), clock.performance);
  await Promise.resolve();
  await Promise.resolve();
  return {clock, calls, get coach() { return coach; }, get client() { return client; }};
}

test('pause freezes a reading beat; resume continues its remaining time without replaying the command', async () => {
  const demo = await makeDemo();
  const command = {
    command_id: 'step-1', mode: 'demonstration', type: 'enter_query', target: 'query',
    narration: 'Read this step', reasoning: '', evidence: '',
  };
  await demo.client.onCommand(command);
  await Promise.resolve();
  assert.equal(demo.calls.countdowns[0], 16500);

  demo.clock.advance(5000);
  demo.coach.setPaused(true);
  demo.clock.advance(20000);
  assert.equal(demo.calls.actions, 0);

  demo.coach.setPaused(false);
  assert.deepEqual(demo.calls.resumes, [11500]);
  await demo.client.onCommand(command); // The service re-sends its pending command on resume.
  assert.equal(demo.calls.commands, 1);
  assert.equal(demo.calls.countdowns.length, 1);
  demo.clock.advance(11499);
  await Promise.resolve();
  assert.equal(demo.calls.actions, 0);
  demo.clock.advance(1);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(demo.calls.actions, 1);
});

test('the countdown bar continues from its frozen width for the remaining duration', () => {
  const source = fs.readFileSync(new URL('../src/ui/coach-panel.js', import.meta.url), 'utf8');
  const Panel = new Function('getComputedStyle', `${source}\nreturn IncidentCoachPanel;`)(
    () => ({width: '25px'}));
  const fill = {style: {}, offsetWidth: 25};
  const bar = {
    hidden: false,
    classList: {remove() {}, contains: () => false},
    querySelector: () => fill,
  };
  const panel = Object.create(Panel.prototype);
  panel.root = {querySelector: () => bar};
  panel.startCountdown(1000);
  panel.stopCountdown();
  assert.equal(fill.style.width, '25px');
  panel.resumeCountdown(750);
  assert.equal(fill.style.transition, 'width 750ms linear');
  assert.equal(fill.style.width, '100%');
});
