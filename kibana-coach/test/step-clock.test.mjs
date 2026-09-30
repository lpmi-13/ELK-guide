import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// The same injectable fake clock as demo-pause.test.mjs.
function makeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
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

// Load the class without starting the coach: the page already "has" a coach host.
function loadClock() {
  const source = fs.readFileSync(new URL('../src/content-script.js', import.meta.url), 'utf8');
  const document = {readyState: 'complete', querySelector: () => ({})};
  return new Function('document', `${source}\nreturn GuidedStepClock;`)(document);
}

function makeStepClock(options = {}) {
  const Clock = loadClock();
  const time = makeClock();
  const state = {paused: false, quiet: true, due: []};
  const clock = new Clock({
    now: time.now, setTimer: time.setTimeout.bind(time), clearTimer: time.clearTimeout.bind(time),
    isPaused: () => state.paused, isQuiet: () => state.quiet, onDue: stepId => state.due.push(stepId), ...options,
  });
  return {clock, time, state};
}

test('the budget is never below 45 seconds and counts active time only', () => {
  const {clock, time, state} = makeStepClock();
  clock.start('scope', 20);
  time.advance(44_000);
  assert.deepEqual(state.due, []);
  time.advance(1_000);
  assert.deepEqual(state.due, ['scope']);

  const paused = makeStepClock();
  paused.clock.start('isolate', 60);
  paused.time.advance(30_000);
  paused.state.paused = true; // tab hidden, briefing open, walkthrough, recovery, success, or a card up
  paused.time.advance(120_000);
  assert.equal(paused.clock.seconds, 30);
  assert.deepEqual(paused.state.due, []);
  paused.state.paused = false;
  paused.time.advance(30_000);
  assert.equal(paused.clock.seconds, 60);
  assert.deepEqual(paused.state.due, ['isolate']);
});

test('a due check-in waits for 5s without input, no open popover and an unfocused query bar', () => {
  const {clock, time, state} = makeStepClock();
  clock.start('survey', 45);
  time.advance(44_000);
  clock.input();
  time.advance(3_000); // past the budget, but the learner moved 3s ago
  assert.deepEqual(state.due, []);
  state.quiet = false; // a popover is open / the query bar has focus
  time.advance(5_000);
  assert.deepEqual(state.due, []);
  state.quiet = true;
  time.advance(500);
  assert.deepEqual(state.due, ['survey']);
  // Only one request is outstanding until the check-in is answered.
  time.advance(60_000);
  assert.deepEqual(state.due, ['survey']);
});

test('Keep going backs off to 1.5x the budget, and two answers end the check-ins for the step', () => {
  const {clock, time, state} = makeStepClock();
  clock.start('isolate', 60);
  time.advance(60_000);
  assert.equal(state.due.length, 1);
  clock.keepGoing();
  time.advance(89_500);
  assert.equal(state.due.length, 1, 'no second card before 1.5x the budget');
  time.advance(500);
  assert.equal(state.due.length, 2);
  clock.keepGoing();
  time.advance(600_000);
  assert.equal(state.due.length, 2);
  // Only a new step resets it.
  clock.start('endpoints', 45);
  time.advance(45_000);
  assert.deepEqual(state.due.slice(2), ['endpoints']);
});

test('a hint allows a fresh budget; a check-in that could not show retries at the next quiet moment', () => {
  const {clock, time, state} = makeStepClock();
  clock.start('scope', 45);
  time.advance(45_000);
  clock.helped();
  time.advance(44_500);
  assert.equal(state.due.length, 1);
  time.advance(500);
  assert.equal(state.due.length, 2);
  clock.retry();
  time.advance(500);
  assert.equal(state.due.length, 3);
});

test('stop ends the clock', () => {
  const {clock, time, state} = makeStepClock();
  clock.start('scope', 45);
  time.advance(10_000);
  assert.equal(clock.seconds, 10);
  clock.stop();
  assert.equal(clock.stepId, null);
  time.advance(100_000);
  assert.deepEqual(state.due, []);
});
