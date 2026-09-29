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
  const calls = {countdowns: [], resumes: [], commands: 0, actions: 0, messages: [], phases: [], learning: null, updatedTargets: []};
  let coach;
  let client;
  let adapter;
  class Coach {
    constructor() { coach = this; this.paused = false; }
    setPaused(paused) { this.paused = paused; this.onPause?.(paused); }
    showCommand() { calls.commands++; }
    startCountdown(duration) { calls.countdowns.push(duration); }
    stopCountdown() {}
    resumeCountdown(remaining) { calls.resumes.push(remaining); }
    showLearning(command) { calls.phases.push('learning'); calls.learning = command; }
    beginWalkthrough() { calls.phases.push('action'); }
    beginActionPhase() {}
    finishCommand() {}
    updateCommandTarget(command, target) { calls.updatedTargets.push({command, target}); }
    toast() {}
  }
  class Adapter {
    constructor() { adapter = this; }
    async initialize() {}
    resolve() { return {}; }
    async resolveAnchor() { return null; }
    async perform() { calls.actions++; return null; }
  }
  class Client {
    constructor() { client = this; }
    async connect() { return {session_id: 'test'}; }
    send(message) { calls.messages.push(message); }
    sendAction(action) { calls.messages.push(action); }
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
  return {clock, calls, get coach() { return coach; }, get client() { return client; }, get adapter() { return adapter; }};
}

test('guided steps render before waiting for an unavailable Kibana anchor', async () => {
  const demo = await makeDemo();
  const command = {command_id: 'guided-isolate', step_id: 'isolate', mode: 'guided',
    target: 'kibana.filter_bar', narration: 'Filter the status code'};
  demo.adapter.resolve = () => null;
  demo.adapter.registry = {targets: {}};
  let waits = 0;
  demo.adapter.waitFor = () => { waits++; return new Promise(() => {}); };

  await demo.client.onCommand(command);
  assert.equal(demo.calls.commands, 1);
  assert.equal(waits, 0);

  let resolveTarget;
  const next = {...command, command_id: 'guided-survey', step_id: 'survey', target: 'kibana.field_list'};
  demo.adapter.registry.targets['kibana.field_list'] = ['[data-test-subj="fieldList"]'];
  demo.adapter.waitFor = () => new Promise(resolve => { resolveTarget = resolve; });
  await demo.client.onCommand(next);
  assert.equal(demo.calls.commands, 2);
  resolveTarget({id: 'field-list'});
  await Promise.resolve();
  assert.deepEqual(demo.calls.updatedTargets, [{command: next, target: {id: 'field-list'}}]);
});

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

test('guided Show me starts the action on the click and explains the result afterward', async () => {
  const demo = await makeDemo();
  const command = {
    command_id: 'guided-1', step_id: 'scope', mode: 'guided', type: 'set_time_range', target: 'time',
    narration: 'Set the time range', walkthrough: {
      narration: 'First I will set the time range.',
      reasoning: 'This includes the incident.',
      evidence: 'The histogram now shows the range.',
    },
  };
  await demo.client.onCommand(command);
  const showing = demo.coach.onDemonstrate();
  assert.deepEqual(demo.calls.phases, ['action']);
  assert.equal(demo.calls.actions, 1);
  assert.deepEqual(demo.calls.countdowns, []);

  await Promise.resolve();
  assert.deepEqual(demo.calls.phases, ['action', 'learning']);
  assert.equal(demo.calls.learning.evidence,
    'This includes the incident.\n\nThe histogram now shows the range.');
  assert.equal(demo.calls.countdowns.length, 1);
  demo.clock.advance(demo.calls.countdowns[0]);
  await showing;
  assert.deepEqual(demo.calls.messages.map(message => message.type), ['step_demonstrated']);
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
