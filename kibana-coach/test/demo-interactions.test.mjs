import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function loadClass(path, name, globals = [], values = []) {
  const source = fs.readFileSync(new URL(path, import.meta.url), 'utf8');
  return new Function(...globals, `${source}\nreturn ${name};`)(...values);
}

test('an already selected time window stays in a blue note until Advance', async () => {
  const Adapter = loadClass('../src/kibana-adapter.js', 'KibanaAdapter');
  const Panel = loadClass('../src/ui/coach-panel.js', 'IncidentCoachPanel');
  const adapter = new Adapter();
  adapter.currentTimeRange = () => ({from: 'now-15m', to: 'now'});
  const panel = Object.create(Panel.prototype);
  const classes = new Set(['acting']);
  const stage = {
    classList: {
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
      remove: name => classes.delete(name),
      add: name => classes.add(name),
    },
    offsetWidth: 300,
  };
  const headline = {textContent: ''};
  const eyebrow = {textContent: '', hidden: false};
  const advance = {title: ''};
  panel.root = {querySelector: selector => ({'#stage': stage, '#phase-headline': headline, '#phase-eyebrow': eyebrow, '#advance': advance})[selector]};
  panel.resetCountdown = () => {};
  panel.showTarget = () => {};
  panel.refit = () => {};
  const calls = [];
  let finishMove;
  panel.cursor = {
    reveal: async () => calls.push('reveal'),
    moveTo: () => { calls.push('move'); return new Promise(resolve => { finishMove = resolve; }); },
    click: () => calls.push('click'),
  };
  const toggle = {click: () => calls.push('activate')};
  const command = {value: {from: 'now-15m', to: 'now'}};
  const result = adapter.setTimeRange(command, toggle, panel, 1, new AbortController().signal);
  let settled = false;
  result.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(panel.phase, 'info');
  assert.equal(eyebrow.textContent, 'Note');
  assert.match(headline.textContent, /already the last 15 minutes/);
  assert.equal(classes.has('acting'), false);
  assert.deepEqual(calls, ['reveal', 'move']);
  assert.equal(settled, false);
  assert.equal(panel.advanceInfo(), true);
  await Promise.resolve();
  assert.equal(settled, false); // Advance during the cursor motion waits for the pointer to land.
  finishMove();
  assert.equal((await result).state_after.time_from, 'now-15m');
  assert.equal(panel.advanceInfo(), false);
  assert.deepEqual(calls, ['reveal', 'move']);
});

test('stopping a note clears its Advance wait', async () => {
  const Panel = loadClass('../src/ui/coach-panel.js', 'IncidentCoachPanel');
  const panel = Object.create(Panel.prototype);
  const controller = new AbortController();
  const wait = panel.waitForAdvance(controller.signal);
  controller.abort();
  await assert.rejects(wait, {name: 'AbortError'});
  assert.equal(panel.advanceInfo(), false);
});

test('an already selected time window uses a timed note and continues without Advance', async () => {
  const Adapter = loadClass('../src/kibana-adapter.js', 'KibanaAdapter');
  const adapter = new Adapter();
  adapter.currentTimeRange = () => ({from: 'now-15m', to: 'now'});
  const calls = [];
  const panel = {
    showInfo: (_target, text) => calls.push(`note:${text}`),
    startCountdown: duration => calls.push(`countdown:${duration}`),
    cursor: {reveal: async () => calls.push('reveal'), moveTo: async () => calls.push('move')},
  };
  adapter.readBeat = async text => {
    panel.startCountdown(10);
    await new Promise(resolve => setTimeout(resolve, 10));
    calls.push(`read:${text}`);
  };
  const result = await adapter.setTimeRange(
    {value: {from: 'now-15m', to: 'now'}}, {}, panel, 1, new AbortController().signal);
  assert.equal(result.state_after.time_from, 'now-15m');
  assert.deepEqual(calls.map(call => call.split(':')[0]), ['reveal', 'note', 'countdown', 'move', 'read']);
});

test('the shared cursor path reveals clipped controls before moving to them', async () => {
  const Cursor = loadClass('../src/ui/cursor.js', 'IncidentCursor',
    ['innerWidth', 'innerHeight', 'getComputedStyle', 'matchMedia'],
    [1200, 800, () => ({overflowX: 'hidden', overflowY: 'auto'}), () => ({matches: true})]);
  Cursor.wait = async () => {};
  const cursor = Object.create(Cursor.prototype);
  const styles = {};
  cursor.element = {
    classList: {add() {}},
    style: {setProperty: (name, value) => { styles[name] = value; }, set transform(value) { styles.transform = value; }},
  };
  const parent = {parentElement: null, getBoundingClientRect: () => ({left: 0, top: 100, right: 240, bottom: 500})};
  let top = 650; // In the viewport, but clipped by the field-list scroller.
  let scrolled = null;
  const target = {
    parentElement: parent,
    getBoundingClientRect: () => ({left: 20, top, width: 20, height: 20}),
    scrollIntoView: options => { scrolled = options; top = 300; },
  };
  await cursor.reveal(target);
  await cursor.moveTo(target);
  assert.deepEqual(scrolled, {block: 'center', inline: 'nearest', behavior: 'instant'});
  assert.equal(styles.transform, 'translate(30px,310px)');

  let viewportTop = 900;
  const offscreen = {
    parentElement: null,
    getBoundingClientRect: () => ({left: 500, top: viewportTop, width: 20, height: 20}),
    scrollIntoView: () => { viewportTop = 400; },
  };
  await cursor.reveal(offscreen);
  await cursor.moveTo(offscreen);
  assert.equal(styles.transform, 'translate(510px,410px)');
});

test('the pointer moves over a scroller before a smooth scroll reveals the control', async () => {
  let now = 0;
  let top = 650;
  let scrolling = false;
  const events = [];
  const Cursor = loadClass('../src/ui/cursor.js', 'IncidentCursor',
    ['innerWidth', 'innerHeight', 'getComputedStyle', 'matchMedia', 'performance'],
    [1200, 800, () => ({overflowX: 'hidden', overflowY: 'auto'}), () => ({matches: false}), {now: () => now}]);
  Cursor.wait = async duration => {
    now += duration;
    if (scrolling && duration === 32) top = Math.max(300, top - 50);
  };
  const cursor = Object.create(Cursor.prototype);
  cursor.element = {
    classList: {add() {}},
    style: {
      setProperty() {},
      set transform(value) { events.push(value); },
    },
  };
  const parent = {parentElement: null, getBoundingClientRect: () => ({left: 0, top: 100, right: 240, bottom: 500})};
  const target = {
    parentElement: parent,
    getBoundingClientRect: () => ({left: 20, top, width: 20, height: 20}),
    scrollIntoView: options => { events.push(`scroll:${options.behavior}`); scrolling = true; },
  };
  await cursor.reveal(target);
  await cursor.moveTo(target);
  assert.deepEqual(events, ['translate(30px,300px)', 'scroll:smooth', 'translate(30px,310px)']);
  assert.equal(top, 300);
});
