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

async function makeDemo({carried = null} = {}) {
  const clock = makeClock();
  const calls = {countdowns: [], resumes: [], commands: 0, actions: 0, messages: [], phases: [], learning: null, pending: [], updatedTargets: [], checkIns: [], hints: 0,
    recoveries: [], celebrations: [], performed: [], range: {from: 'now-15m', to: 'now'}};
  let coach;
  let client;
  let adapter;
  class Coach {
    constructor() { coach = this; this.paused = false; this.briefing = {active: false}; }
    showRecovery(card) { this.phase = 'recovery'; calls.recoveries.push(card); }
    showRecoveryWorking(headline) { calls.working = headline; }
    celebrate(reason) { calls.celebrations.push(reason); }
    showTarget(_target, activity) { this.phase = 'action'; calls.phases.push(activity); }
    showResult(command, evidence) { this.phase = 'learning'; calls.phases.push('result'); calls.result = {command, evidence}; }
    waitForAdvance() { return new Promise(resolve => { calls.continueResult = resolve; }); }
    setPaused(paused) { this.paused = paused; this.onPause?.(paused); }
    showCommand() { calls.commands++; }
    startCountdown(duration) { calls.countdowns.push(duration); }
    stopCountdown() {}
    resumeCountdown(remaining) { calls.resumes.push(remaining); }
    setAdvancePending(pending) { this.advancePending = pending; calls.pending.push(pending); }
    beginWalkthrough() { this.phase = 'action'; calls.phases.push('action'); }
    beginActionPhase() { this.phase = 'action'; }
    finishCommand() {}
    updateCommandTarget(command, target) { calls.updatedTargets.push({command, target}); }
    toast() {}
    findPopovers() { return []; }
    showCheckIn(card) { calls.checkIns.push(card); }
    revealHint() { calls.hints++; }
  }
  class Adapter {
    constructor() { adapter = this; }
    async initialize() {}
    resolve() { return {}; }
    async resolveAnchor() { return null; }
    async perform(command) { calls.actions++; calls.performed.push(command); return null; }
    async findEvidence() { return {targets: [], columns: []}; }
    closeTransientPopovers() {}
  }
  class Client {
    constructor() { client = this; }
    async connect() { return {session_id: 'test'}; }
    send(message) { calls.messages.push(message); }
    setPaused(paused) { this.send({message_type: paused ? 'pause' : 'resume'}); }
    sendAction(action) { calls.messages.push({...action, step_clock: this.stepClock?.()}); }
    requestCheckIn(step_id) { calls.messages.push({message_type: 'check_in', step_id}); }
    acknowledge() {}
    reportRecovery(step_id, reason_code) { calls.messages.push({message_type: 'recovery_shown', step_id, reason_code}); }
    checkWindow() { calls.messages.push({message_type: 'window_check'}); }
  }
  class Observer {
    static noResultsShown() { return false; }
    start() {} stop() {} rebaseline() {}
    readTimeRange() { return calls.range; }
    timeRangeMinutes() { return 15; }
  }
  const source = fs.readFileSync(new URL('../src/content-script.js', import.meta.url), 'utf8');
  const document = {
    readyState: 'complete',
    querySelector: () => null,
    createElement: () => ({}),
    documentElement: {append() {}},
    addEventListener() {},
  };
  const stored = new Map([['incident-coach:auto-connect', JSON.stringify({session: 'test'})]]);
  if (carried) stored.set('incident-coach:carried-result', JSON.stringify(carried));
  const storage = {
    getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
    removeItem: key => stored.delete(key),
  };
  const window = {};
  const run = new Function('document', 'window', 'sessionStorage', 'IncidentCoachPanel',
    'KibanaAdapter', 'IncidentSessionClient', 'KibanaActionObserver',
    'setTimeout', 'clearTimeout', 'performance', source);
  run(document, window, storage, Coach, Adapter, Client, Observer,
    clock.setTimeout.bind(clock), clock.clearTimeout.bind(clock), clock.performance);
  await Promise.resolve();
  await Promise.resolve();
  return {clock, calls, stored, get coach() { return coach; }, get client() { return client; }, get adapter() { return adapter; }};
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
  assert.equal(demo.calls.countdowns[0], 5000);

  demo.clock.advance(2000);
  demo.coach.setPaused(true);
  demo.clock.advance(20000);
  assert.equal(demo.calls.actions, 0);

  demo.coach.setPaused(false);
  assert.deepEqual(demo.calls.resumes, [3000]);
  await demo.client.onCommand(command); // The service re-sends its pending command on resume.
  assert.equal(demo.calls.commands, 1);
  assert.equal(demo.calls.countdowns.length, 1);
  demo.clock.advance(2999);
  await Promise.resolve();
  assert.equal(demo.calls.actions, 0);
  demo.clock.advance(1);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(demo.calls.actions, 1);
});

test('the demonstration moves from a motivated opening card straight to the action', async () => {
  const demo = await makeDemo();
  await demo.client.onCommand({
    command_id: 'step-with-reason', mode: 'demonstration', type: 'enter_query', target: 'query',
    narration: "I'll filter the failures to find the request pattern behind the spike.",
    reasoning: 'The old separate why card would repeat this motivation.',
    evidence: 'A post-action recap is unnecessary here.',
  });
  demo.coach.advanceCelebration = () => false;
  demo.coach.advanceInfo = () => false;
  demo.adapter.advanceTyping = () => false;
  demo.coach.onAdvance();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(demo.calls.actions, 1);
  assert.deepEqual(demo.calls.countdowns, [5000]);
  assert.deepEqual(demo.calls.phases, []);
});

test('a completed demonstration action keeps its one-second hold, then advances without a recap', async () => {
  const demo = await makeDemo();
  let finished = 0;
  demo.coach.finishCommand = () => { finished++; };
  demo.adapter.perform = async (_command, _coach, {holdAction}) => {
    demo.calls.actions++;
    await holdAction();
    return null;
  };
  await demo.client.onCommand({
    command_id: 'step-hold', mode: 'demonstration', type: 'enter_query', target: 'query',
    narration: 'Read this step', reasoning: '', evidence: 'Result explained',
  });
  await Promise.resolve();
  demo.coach.advanceCelebration = () => false;
  demo.coach.advanceInfo = () => false;
  demo.adapter.advanceTyping = () => false;
  demo.coach.onAdvance(); // Finish the opening explanation.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(demo.calls.actions, 1);
  assert.deepEqual(demo.calls.countdowns.slice(0, 2), [5000, 1000]);
  assert.deepEqual(demo.calls.phases, []);

  demo.clock.advance(500);
  demo.coach.setPaused(true);
  demo.clock.advance(2000);
  assert.deepEqual(demo.calls.phases, []);
  demo.coach.setPaused(false);
  assert.deepEqual(demo.calls.resumes, [500]);
  demo.clock.advance(499);
  await Promise.resolve();
  assert.deepEqual(demo.calls.phases, []);
  demo.clock.advance(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(demo.calls.phases, []);
  assert.equal(finished, 1);
  assert.deepEqual(demo.calls.countdowns, [5000, 1000]);
});

test('Advance during a moving demonstration action continues after the action finishes', async () => {
  const demo = await makeDemo();
  let finishControl;
  let finished = 0;
  demo.coach.finishCommand = () => { finished++; };
  demo.adapter.perform = async (_command, _coach, {holdAction}) => {
    demo.calls.actions++;
    await new Promise(resolve => { finishControl = resolve; });
    await holdAction();
    return null;
  };
  await demo.client.onCommand({
    command_id: 'step-early-advance', mode: 'demonstration', type: 'set_time_range', target: 'time',
    narration: 'Set the time picker', reasoning: '', evidence: 'The wider window now includes the incident.',
  });
  demo.coach.advanceCelebration = () => false;
  demo.coach.advanceInfo = () => false;
  demo.adapter.advanceTyping = () => false;
  demo.coach.onAdvance(); // Opening explanation.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(demo.calls.actions, 1);

  demo.coach.onAdvance(); // The control has not finished yet.
  demo.coach.onAdvance(); // Repeated clicks must not affect the action again.
  assert.deepEqual(demo.calls.pending, [true]);
  finishControl();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, 0);
  assert.deepEqual(demo.calls.countdowns.slice(0, 2), [5000, 1000]);

  demo.clock.advance(1000); // The control's own hold finishes before the queued Advance applies.
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(demo.calls.phases, []);
  assert.deepEqual(demo.calls.countdowns, [5000, 1000]);
  assert.equal(finished, 1);
  assert.equal(demo.coach.advancePending, false);
});

test('repeated Advance clicks during an action hold wait for that hold to finish', async () => {
  const demo = await makeDemo();
  let finished = 0;
  demo.coach.finishCommand = () => { finished++; };
  demo.adapter.perform = async (_command, _coach, {holdAction}) => {
    await holdAction();
    return null;
  };
  await demo.client.onCommand({
    command_id: 'step-holding', mode: 'demonstration', type: 'set_time_range', target: 'time',
    narration: 'Set the time picker', reasoning: '', evidence: 'The wider window now includes the incident.',
  });
  demo.coach.advanceCelebration = () => false;
  demo.coach.advanceInfo = () => false;
  demo.adapter.advanceTyping = () => false;
  demo.coach.onAdvance();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(demo.calls.countdowns.slice(0, 2), [5000, 1000]);

  demo.coach.onAdvance();
  demo.coach.onAdvance();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(demo.calls.phases, []);
  assert.deepEqual(demo.calls.pending, [true]);
  demo.clock.advance(999);
  await Promise.resolve();
  assert.deepEqual(demo.calls.phases, []);
  demo.clock.advance(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(demo.calls.phases, []);
  assert.equal(finished, 1);
  assert.equal(demo.coach.advancePending, false);
});

test('a failed action releases its queued Advance button', async () => {
  const demo = await makeDemo();
  let failControl;
  demo.adapter.perform = async () => new Promise((_resolve, reject) => { failControl = reject; });
  await demo.client.onCommand({
    command_id: 'step-failed', mode: 'demonstration', type: 'set_time_range', target: 'time',
    narration: 'Set the time picker', reasoning: '', evidence: 'The window includes the incident.',
  });
  demo.coach.advanceCelebration = () => false;
  demo.coach.advanceInfo = () => false;
  demo.adapter.advanceTyping = () => false;
  demo.coach.onAdvance();
  await Promise.resolve();
  await Promise.resolve();
  demo.coach.onAdvance();
  assert.equal(demo.coach.advancePending, true);
  failControl(new Error('Picker failed'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(demo.coach.advancePending, false);
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

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(demo.calls.phases, ['action', 'result']);
  // The finding and the reasoning stay separate, so the card can set one under the other.
  assert.equal(demo.calls.result.command.evidence, 'The histogram now shows the range.');
  assert.equal(demo.calls.result.command.reasoning, 'This includes the incident.');
  // Reading the result is never on a timer: nothing moves on until the learner continues.
  assert.deepEqual(demo.calls.countdowns, []);
  demo.clock.advance(60000);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(demo.calls.messages, []);
  demo.calls.continueResult();
  await showing;
  assert.deepEqual(demo.calls.messages.map(message => message.type), ['step_demonstrated']);
});

test('Advance during guided Show me hurries the action, not the result card', async () => {
  const demo = await makeDemo();
  let finishControl;
  demo.adapter.perform = async () => new Promise(resolve => { finishControl = resolve; });
  await demo.client.onCommand({
    command_id: 'guided-early-advance', step_id: 'inspect', mode: 'guided', type: 'expand_document', target: 'result',
    narration: 'Inspect the event', walkthrough: {evidence: 'The event confirms the finding.'},
  });
  demo.coach.advanceCelebration = () => false;
  demo.coach.advanceInfo = () => false;
  demo.adapter.advanceTyping = () => false;
  const showing = demo.coach.onDemonstrate();
  assert.deepEqual(demo.calls.phases, ['action']);

  demo.coach.onAdvance();
  demo.coach.onAdvance();
  assert.deepEqual(demo.calls.pending, [true]);
  finishControl(null);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(demo.calls.phases, ['action', 'result']);
  assert.equal(demo.coach.advancePending, false);
  assert.deepEqual(demo.calls.messages, []);
  demo.calls.continueResult();
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

test('a guided step that runs over its budget gets a gentle check-in that costs nothing', async () => {
  const demo = await makeDemo();
  const command = {command_id: 'guided-isolate', step_id: 'isolate', mode: 'guided', type: 'add_filter',
    target: 'kibana.filter_bar', narration: 'Filter the status code', pace_seconds: 60};
  await demo.client.onCommand(command);
  demo.clock.advance(59_500);
  assert.deepEqual(demo.calls.messages, []);
  demo.clock.advance(500); // no input all along, so the learner is already idle
  assert.deepEqual(demo.calls.messages, [{message_type: 'check_in', step_id: 'isolate'}]);

  demo.client.onCheckIn({message_type: 'check_in', step_id: 'isolate', step_title: 'Filter to the failing status code',
    drift: ['You opened url.path; this step is about the status codes.', 'You filtered on a status code, but not the one that stood out in the top values.']});
  const card = demo.calls.checkIns[0];
  assert.equal(card.title, 'Filter to the failing status code');
  assert.equal(card.drift, 'You filtered on a status code, but not the one that stood out in the top values.');
  assert.deepEqual(card.choices.map(choice => choice.label), ['Keep going', 'Give me a hint', 'Show me']);

  // The clock stands still while the card is up.
  demo.clock.advance(30_000);
  card.choices[0].onSelect();
  const answered = demo.calls.messages[1];
  assert.equal(answered.type, 'check_in_answered');
  assert.deepEqual(answered.details, {step_id: 'isolate', choice: 'keep_going'});
  assert.equal(answered.step_clock.step_id, 'isolate');
  assert.equal(answered.step_clock.seconds_active, 60);
  assert.equal(demo.calls.commands, 2); // back to the step's own card

  // Keep going: nothing more before 1.5x the budget.
  demo.clock.advance(89_000);
  assert.equal(demo.calls.messages.length, 2);
  demo.clock.advance(1_000);
  assert.deepEqual(demo.calls.messages[2], {message_type: 'check_in', step_id: 'isolate'});

  // A re-sent command for the same step keeps its clock; a stale check-in reply is ignored.
  await demo.client.onCommand(command);
  demo.client.onCheckIn({message_type: 'check_in', step_id: 'scope', step_title: 'Set the time window', drift: []});
  assert.equal(demo.calls.checkIns.length, 1);
  demo.client.onCheckIn({message_type: 'check_in', step_id: 'isolate', step_title: 'Filter', drift: []});
  demo.calls.checkIns[1].choices[1].onSelect();
  assert.equal(demo.calls.hints, 1);
  assert.equal(demo.calls.checkIns[1].drift, '');
});

test('a step that opens another page keeps its result for that page instead of telling it here', async () => {
  const demo = await makeDemo();
  const command = {command_id: 'pivot', step_id: 'inspect', mode: 'demonstration', type: 'view_panel_underlying_data', target: 'panel',
    narration: 'Open the records', evidence: 'The records match the chart.'};
  demo.adapter.perform = async () => ({type: 'panel_underlying_data_opened', details: {}, navigate: '/app/r?l=DISCOVER'});
  demo.coach.advanceCelebration = () => false;
  demo.coach.advanceInfo = () => false;
  demo.adapter.advanceTyping = () => false;
  demo.coach.finishCommand = () => {};
  await demo.client.onCommand(command);
  await Promise.resolve();
  demo.coach.onAdvance();
  await new Promise(resolve => setImmediate(resolve));
  // Nothing claims to show the records while the dashboard is still on screen.
  assert.equal(demo.calls.result, undefined);
  assert.equal(JSON.parse(demo.stored.get('incident-coach:carried-result')).evidence, 'The records match the chart.');
  assert.equal(demo.calls.messages.at(-1).type, 'panel_underlying_data_opened');
});

test('the page a step opened tells its result, then runs whatever the service sent meanwhile', async () => {
  const carried = {command_id: 'pivot', step_id: 'inspect', mode: 'demonstration', type: 'view_panel_underlying_data', evidence: 'The records match the chart.'};
  const demo = await makeDemo({carried});
  let finished = 0;
  demo.coach.finishCommand = () => { finished++; };
  const next = {command_id: 'submit', step_id: 'submit', mode: 'guided', target: 'coach.answer', narration: 'Next'};
  await demo.client.onCommand(next);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(demo.calls.result.command.command_id, 'pivot');
  assert.equal(demo.calls.commands, 1); // the carried step's own header, not the next command yet
  await demo.client.onCommand(next); // a resend must not start a second result beat
  assert.equal(demo.calls.commands, 1);
  demo.calls.continueResult();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, 1);
  assert.equal(demo.stored.has('incident-coach:carried-result'), false);
  assert.equal(demo.calls.commands, 2); // now the next command
});

const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

test('a guided window that misses the incident on the scope step is explained at once; the learner chooses again', async () => {
  const demo = await makeDemo();
  demo.client.mode = 'guided';
  await demo.client.onCommand({command_id: 'guided-scope', step_id: 'scope', mode: 'guided', type: 'set_time_range',
    target: 'kibana.time_picker', narration: 'Set the window', restore_state: {}});
  const miss = {outcome: 'dead_end', reason_code: 'window_misses_incident',
    headline: 'Your window, the last 10 minutes, starts at 04:12, after the report at 04:10.',
    detail: 'The report came in 12 minutes ago: time kept moving while you read.'};
  demo.client.onActionResult({action: {type: 'time_range_changed'}, evaluation: miss});
  const card = demo.calls.recoveries.at(-1);
  assert.equal(card.eyebrow, 'Outside the window — choose again');
  assert.equal(card.headline, miss.headline);
  assert.equal(card.detail, miss.detail);
  assert.deepEqual(card.choices.map(choice => choice.label), ['Choose again']);
  assert.deepEqual(demo.calls.messages.at(-1), {message_type: 'recovery_shown', step_id: 'scope', reason_code: 'window_misses_incident'});
  // Nothing is put back: the learner picks the window.
  assert.equal(demo.calls.actions, 0);
  const commands = demo.calls.commands;
  card.choices[0].onSelect();
  assert.equal(demo.calls.commands, commands + 1);
  // Another miss, straight after, gets its own card; a window that reaches completes the step.
  demo.client.onActionResult({action: {type: 'time_range_changed'}, evaluation: miss});
  demo.client.onActionResult({action: {type: 'time_range_changed'}, evaluation: miss});
  assert.equal(demo.calls.recoveries.length, 3);
  demo.client.onActionResult({action: {type: 'time_range_changed'}, evaluation: {outcome: 'accepted', goals_progressed: ['scope'], reason: 'Completed: Set the time window'}});
  assert.deepEqual(demo.calls.celebrations, ['Set the time window']);
});

test('a guided relative window is checked when it is due to slide; a confirmed slide types a fixed start back', async () => {
  const demo = await makeDemo();
  demo.client.mode = 'guided';
  await demo.client.onCommand({command_id: 'guided-isolate', step_id: 'isolate', mode: 'guided', type: 'add_filter',
    target: 'kibana.filter_bar', narration: 'Filter', restore_state: {time: {from: '2026-11-08T04:00:00.000Z', to: 'now'}}});
  const checks = () => demo.calls.messages.filter(message => message.message_type === 'window_check').length;
  const watch = {from: 'now-15m', slides_at: new Date(Date.now() + 60_000).toISOString()};
  demo.client.onActionResult({action: {type: 'time_range_changed'}, evaluation: {outcome: 'observed'}, window_watch: watch});
  demo.clock.advance(59_000);
  assert.equal(checks(), 0);
  demo.clock.advance(3_000);
  assert.equal(checks(), 1);
  // A window changed in the meantime (the watch is for the old one) is not checked.
  demo.client.onActionResult({action: {type: 'time_range_changed'}, evaluation: {outcome: 'observed'}, window_watch: {...watch, slides_at: new Date(Date.now() + 1_000).toISOString()}});
  demo.calls.range = {from: '2026-11-08T04:00:00.000Z', to: 'now'};
  demo.clock.advance(5_000);
  assert.equal(checks(), 1);
  // The service confirms: the card says what happened, and the coach types the fixed start in.
  demo.calls.range = {from: 'now-15m', to: 'now'};
  demo.client.onWindowSlid({message_type: 'window_slid', evaluation: {outcome: 'dead_end', reason_code: 'window_slid_past_incident',
    headline: 'Your window, the last 15 minutes, now starts at 04:04, after the rollout at 04:03.',
    detail: 'A window counted back from now moves with the clock. I’ll set a fixed start of 04:00 so it stays put.',
    incident_reference_at: new Date(Date.now() - 17 * 60_000).toISOString(), window_start_at: new Date(Date.now() - 15 * 60_000).toISOString(),
    restore_time: {from: '2026-11-08T04:00:00.000Z', to: 'now'}}});
  await settle();
  const card = demo.calls.recoveries.at(-1);
  assert.equal(card.eyebrow, 'Window moved on — back on track');
  assert.equal(card.headline, 'Your window, the last 15 minutes, now starts at 04:04, after the rollout at 04:03.');
  demo.clock.advance(16_000);
  await settle();
  assert.deepEqual(demo.calls.performed.at(-1), {type: 'set_time_range', target: 'kibana.time_picker', value: {from: '2026-11-08T04:00:00.000Z', to: 'now'}});
  assert.match(demo.calls.working, /fixed start/);
});
