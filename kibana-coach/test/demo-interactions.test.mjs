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
  const detail = {textContent: '', hidden: true};
  const actions = {hidden: true, replaceChildren() {}};
  panel.root = {querySelector: selector => ({'#stage': stage, '#phase-headline': headline, '#phase-detail': detail, '#phase-why': {hidden: true}, '#phase-why-text': {textContent: ''}, '#phase-eyebrow': eyebrow, '#advance': advance, '#stage-actions': actions})[selector]};
  panel.resetCountdown = () => {};
  panel.showTarget = () => {};
  panel.refit = () => {};
  panel.spotlight = {hide() {}};
  const calls = [];
  let finishMove;
  panel.cursor = {
    reveal: async () => calls.push('reveal'),
    moveTo: () => { calls.push('move'); return new Promise(resolve => { finishMove = resolve; }); },
    click: () => calls.push('click'),
    hide() {},
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

test('the shared cursor path clears the completed target before the timed hold', async () => {
  const Adapter = loadClass('../src/kibana-adapter.js', 'KibanaAdapter');
  const adapter = new Adapter();
  const calls = [];
  let releaseHold;
  adapter.holdAction = () => {
    calls.push('hold');
    return new Promise(resolve => { releaseHold = resolve; });
  };
  const coach = {
    showTarget: () => calls.push('card'),
    clearActionTarget: () => calls.push('clear highlight'),
    cursor: {
      reveal: async () => calls.push('reveal'),
      moveTo: async () => calls.push('move'),
      click: () => calls.push('cursor click'),
    },
  };
  const target = {click: () => calls.push('control click')};
  let finished = false;
  const action = adapter.pointAt(target, coach, 30, new AbortController().signal, 'Open the picker.', {activate: true})
    .then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['card', 'reveal', 'card', 'move', 'cursor click', 'control click', 'clear highlight', 'hold']);
  assert.equal(finished, false);
  releaseHold();
  await action;
  assert.equal(finished, true);
});

test('the cursor reacquires a time control replaced while it was moving', async () => {
  const Adapter = loadClass('../src/kibana-adapter.js', 'KibanaAdapter');
  const adapter = new Adapter();
  const calls = [];
  const oldTarget = {isConnected: true, click: () => calls.push('stale click')};
  const replacement = {isConnected: true, click: () => calls.push('live click')};
  adapter.waitFor = async name => {
    assert.equal(name, 'kibana.time_picker');
    return replacement;
  };
  const coach = {
    showTarget: target => calls.push(target === oldTarget ? 'show stale' : 'show live'),
    clearActionTarget() {},
    cursor: {
      reveal: async () => {},
      moveTo: async target => {
        calls.push(target === oldTarget ? 'move stale' : 'move live');
        if (target === oldTarget) oldTarget.isConnected = false;
      },
      click: () => calls.push('cursor click'),
    },
  };
  await adapter.pointAt(oldTarget, coach, 1, new AbortController().signal, 'Open the time picker.',
    {activate: true, targetName: 'kibana.time_picker'});
  assert.deepEqual(calls, ['show live', 'show stale', 'move stale', 'show live', 'move live', 'cursor click', 'live click']);
});

test('a picker redrawn after its first click is reopened and set through every visible control', async () => {
  const Adapter = loadClass('../src/kibana-adapter.js', 'KibanaAdapter', ['Event'],
    [class { constructor(type) { this.type = type; } }]);
  const adapter = new Adapter();
  adapter.currentTimeRange = () => ({from: 'now-15m', to: 'now'});
  const toggle = {};
  const custom = {};
  const number = {};
  const unit = {options: [{textContent: 'minutes ago', value: 'm_past'}], dispatchEvent() {}};
  const apply = {};
  const calls = [];
  let openings = 0;
  let customOpen = false;
  adapter.resolve = name => customOpen ? ({'kibana.time_value': number, 'kibana.time_unit': unit,
    'kibana.time_apply': apply})[name] || null : null;
  adapter.waitFor = async name => {
    if (name === 'kibana.time_picker') return toggle;
    if (name === 'kibana.time_custom_range') {
      if (openings < 2) throw new Error('Picker was replaced during loading');
      return custom;
    }
    return ({'kibana.time_value': number, 'kibana.time_unit': unit})[name];
  };
  adapter.pointAt = async (_target, _coach, _scale, _signal, activity) => {
    calls.push(activity);
    if (activity === 'Open the time picker.') openings++;
    if (activity === 'Choose Custom range.') customOpen = true;
  };
  adapter.typeValue = async (_input, value) => { calls.push(`Type ${value}`); };
  adapter.holdAction = async () => { calls.push('hold'); };

  const result = await adapter.setTimeRange({value: {from: 'now-10m', to: 'now'}}, toggle, {}, 1,
    new AbortController().signal);
  assert.equal(result.state_after.time_from, 'now-10m');
  assert.deepEqual(calls, [
    'Open the time picker.', 'Open the time picker.', 'Choose Custom range.',
    'Click the number box under Start date and type 10.', 'Type 10',
    'Choose “minutes ago” as the unit.', 'hold', 'Apply the Last 10 minutes range.',
  ]);
});

test('typing clears its target after the value is committed and before the hold', async () => {
  const EventClass = class { constructor(type) { this.type = type; } };
  const Adapter = loadClass('../src/kibana-adapter.js', 'KibanaAdapter',
    ['KeyboardEvent', 'Event'], [EventClass, EventClass]);
  const adapter = new Adapter();
  const calls = [];
  adapter.setNativeValue = (input, value) => { input.value = value; };
  adapter.holdAction = async () => { calls.push('hold'); };
  const input = {value: '', focus() {}, dispatchEvent: event => calls.push(event.type)};
  await adapter.typeValue(input, '5', new AbortController().signal,
    {clearActionTarget: () => calls.push('clear highlight')});
  assert.equal(input.value, '5');
  assert.deepEqual(calls, ['keydown', 'keyup', 'change', 'clear highlight', 'hold']);
});

test('clearing an action target prevents the old highlight from reappearing', () => {
  const Panel = loadClass('../src/ui/coach-panel.js', 'IncidentCoachPanel');
  const panel = Object.create(Panel.prototype);
  const calls = [];
  const oldTarget = {id: 'old'};
  const nextTarget = {id: 'next'};
  panel.activeTarget = oldTarget;
  panel.spotlightRevealed = true;
  panel.spotlight = {hide: () => calls.push('hide spotlight'), show: target => calls.push(`show ${target.id}`)};
  panel.cursor = {hide: () => calls.push('hide cursor')};
  panel.placeAwayFrom = () => {};
  panel.clearActionTarget();
  assert.equal(panel.activeTarget, null);
  assert.equal(panel.spotlightRevealed, false);
  panel.showTarget(nextTarget);
  assert.equal(panel.activeTarget, nextTarget);
  assert.equal(panel.spotlightRevealed, true);
  assert.deepEqual(calls, ['hide spotlight', 'hide cursor', 'show next']);
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

test('typing over the time count never leaves the box empty, so Kibana never flips it to "from now"', async () => {
  const Adapter = loadClass('../src/kibana-adapter.js', 'KibanaAdapter', ['KeyboardEvent'], [class {}]);
  const adapter = new Adapter();
  const values = [];
  adapter.setNativeValue = (_element, value) => values.push(value);
  adapter.wait = async () => {};
  const element = {focus() {}, dispatchEvent() {}};
  await adapter.typeValue(element, '15', new AbortController().signal, null, {clearFirst: false});
  assert.deepEqual(values.slice(0, 2), ['1', '15']);
  values.length = 0;
  await adapter.typeValue(element, '15', new AbortController().signal);
  assert.equal(values[0], ''); // an ordinary field still clears first
});

test('a named target is the row that says so, not the first row, and an exact match wins', () => {
  const row = text => ({textContent: text, getClientRects: () => [{}]});
  const rows = [row('HTTP 2xx POST /checkout/retry checkout 3,700 ms'), row('POST /checkout'), row('POST payments/authorize checkout 3,400 ms')];
  const Adapter = loadClass('../src/kibana-adapter.js', 'KibanaAdapter', ['document'], [{querySelectorAll: () => rows}]);
  const adapter = new Adapter();
  adapter.registry = {targets: {'kibana.trace_span': ['row']}};
  assert.equal(adapter.namedCandidate('kibana.trace_span', 'POST /checkout'), rows[1]);
  assert.equal(adapter.namedCandidate('kibana.trace_span', 'payments/authorize'), rows[2]);
  assert.equal(adapter.namedCandidate('kibana.trace_span', 'nothing'), null);
  assert.equal(adapter.targetNaming('kibana.trace_span', 'nothing', 'fallback'), 'fallback');
});

test('a dashboard filter pill is found by value when the field is not known', () => {
  const pill = subject => ({getAttribute: () => subject});
  const pills = [pill('filter-key-service.name filter-value-orders'), pill('filter-key-panel.metric.keyword filter-value-failedtransactions')];
  const Adapter = loadClass('../src/kibana-adapter.js', 'KibanaAdapter', ['document'], [{querySelectorAll: () => pills}]);
  assert.equal(new Adapter().findFilterPill(null, 'failed transactions'), pills[1]);
  assert.equal(new Adapter().findFilterPill('service.name', 'orders'), pills[0]);
});

test('a start date is typed into the date box as a learner would, then confirmed in the URL', async () => {
  const EventClass = class { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } };
  const Adapter = loadClass('../src/kibana-adapter.js', 'KibanaAdapter', ['KeyboardEvent'], [EventClass]);
  const adapter = new Adapter();
  const start = new Date(2026, 10, 7, 14, 0);
  const iso = start.toISOString();
  let applied = {from: 'now-15m', to: 'now'};
  adapter.currentTimeRange = () => applied;
  const calls = [];
  const input = {dispatchEvent: event => { calls.push(`key ${event.key}`); applied = {from: iso, to: 'now'}; }};
  adapter.waitFor = async name => (name === 'kibana.time_input' ? input : null);
  adapter.pointAt = async (_target, _coach, _scale, _signal, activity) => { calls.push(activity); };
  adapter.typeValue = async (_input, value) => { calls.push(`type ${value}`); };
  adapter.wait = async () => {};

  assert.equal(adapter.absoluteStart({from: 'now-15m'}), null);
  assert.equal(adapter.typedStart(start), 'Nov 7 14:00');
  const result = await adapter.setTimeRange({value: {from: iso, to: 'now'}}, {}, {}, 1, new AbortController().signal);
  assert.deepEqual(calls, ['Open the date box.', 'Type the start, “Nov 7 14:00 to now”, and press Enter.', 'type Nov 7 14:00 to now', 'key Enter']);
  assert.deepEqual(result, {type: 'time_range_changed', details: {from: iso, to: 'now'}, state_after: {time_from: iso, time_to: 'now'}});
});

test('the briefing states each moment as a clock time beside how long ago it was', () => {
  const Briefing = loadClass('../src/ui/incident-briefing.js', 'IncidentBriefing');
  const briefing = Object.create(Briefing.prototype);
  const noticed = new Date(Date.now() - 12 * 60_000);
  const rollout = new Date(Date.now() - 17 * 60_000);
  const clock = moment => `${String(moment.getHours()).padStart(2, '0')}:${String(moment.getMinutes()).padStart(2, '0')}`;
  assert.deepEqual(briefing.timedFacts({noticed_at: noticed.toISOString(), timed_facts: [{text: 'The rollout began at {time} ({ago}).', at: rollout.toISOString()}]}), [
    `Noticed at ${clock(noticed)} (12 minutes ago).`,
    `The rollout began at ${clock(rollout)} (17 minutes ago).`,
  ]);
});
