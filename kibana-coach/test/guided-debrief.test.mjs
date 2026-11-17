import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function loadClass(path, name) {
  const source = fs.readFileSync(new URL(path, import.meta.url), 'utf8');
  return new Function(`${source}\nreturn ${name};`)();
}

// A tiny element stand-in: records innerHTML, class, custom properties and appended children.
function fakeElement() {
  const element = {
    innerHTML: '',
    className: '',
    textContent: '',
    title: '',
    hidden: false,
    children: [],
    properties: {},
    style: {setProperty(name, value) { element.properties[name] = value; }},
    parts: {},
    append(child) { element.children.push(child); },
    querySelector(selector) { return (element.parts[selector] ||= fakeElement()); },
    addEventListener() {},
    showModal() {},
  };
  return element;
}

function renderGuided(feedback) {
  const Debrief = loadClass('../src/ui/debrief.js', 'IncidentDebrief');
  const created = [];
  const originalDocument = globalThis.document;
  globalThis.document = {createElement: () => { const element = fakeElement(); created.push(element); return element; }};
  try {
    new Debrief({append() {}}).show(feedback);
  } finally {
    globalThis.document = originalDocument;
  }
  return {Debrief, dialog: created[0], created};
}

const assistance = {step_count: 5, independent_steps: 3, hints: 1, hinted_steps: 1, demonstrated_steps: 1, shown_steps: 1};

test('guided debrief shows the scored percentage, phase credit, and marked gradient bar', () => {
  const {Debrief, dialog} = renderGuided({scored: true, total: 70, summary: 'Complete.', assistance});
  assert.match(dialog.innerHTML, /Guided practice score<\/strong><strong>70%/);
  assert.match(dialog.innerHTML, /role="progressbar"[^>]*aria-valuenow="70"[^>]*--score:70%/);
  assert.match(dialog.innerHTML, /Per phase: 20% without help · 10% with hints that leave the answer to you · 0% once a hint or Show me gives it/);
  assert.equal((dialog.innerHTML.match(/<i><\/i>/g) || []).length, 6);
  assert.match(dialog.innerHTML, /<span>0%<\/span>.*<span>100%<\/span>/s);
  assert.match(Debrief.styles, /guided-score-unearned[^}]*animation/);
  const Panel = loadClass('../src/ui/coach-panel.js', 'IncidentCoachPanel');
  assert.match(Panel.styles, /guided-score-track[^}]*linear-gradient\(90deg/);
  assert.match(Panel.styles, /guided-score-unearned[^}]*left:var\(--score\)/);
});

test('guided debrief colours its score ring and tier by how much help was used', () => {
  const strong = renderGuided({total: 90, summary: '', assistance}).dialog;
  assert.match(strong.className, /tier-strong/);
  assert.equal(strong.properties['--score-num'], '90');
  assert.match(strong.innerHTML, /class="gd-ring"/);
  assert.match(strong.innerHTML, /Solved independently/);
  assert.match(renderGuided({total: 50, summary: '', assistance}).dialog.className, /tier-steady/);
  assert.match(renderGuided({total: 0, summary: '', assistance}).dialog.className, /tier-guided/);
});

test('guided debrief lists each step with the help it took', () => {
  const {dialog} = renderGuided({
    total: 50,
    summary: '',
    assistance,
    steps: [
      {id: 'scope', title: 'Set the time window', outcome: 'independent'},
      {id: 'isolate', title: 'Filter to the failing status code', outcome: 'hinted'},
      {id: 'inspect', title: 'Check the evidence in one event', outcome: 'shown'},
    ],
  });
  const list = dialog.parts['.gd-steps'];
  assert.deepEqual(list.children.map(item => item.className), ['gd-step outcome-independent', 'gd-step outcome-hinted', 'gd-step outcome-shown']);
  assert.deepEqual(list.children.map(item => item.parts['.gd-step-chip'].textContent), ['On your own', 'With a hint', 'Shown to you']);
  assert.equal(list.children[1].parts['.gd-step-title'].textContent, 'Filter to the failing status code');
  assert.equal(dialog.parts['.gd-steps-section'].hidden, false);
});

test('guided step rows carry an unscored detail line when there is one', () => {
  const {dialog} = renderGuided({
    total: 50,
    summary: '',
    assistance,
    steps: [
      {id: 'scope', title: 'Set the time window', outcome: 'independent', detail: '32s'},
      {id: 'isolate', title: 'Filter to the failing status code', outcome: 'hinted',
        detail: '1m 05s · needed a check-in · recovered from a dead end: missing colon'},
      {id: 'inspect', title: 'Check the evidence in one event', outcome: 'shown'},
    ],
  });
  const details = dialog.parts['.gd-steps'].children.map(item => item.parts['.gd-step-detail']);
  assert.deepEqual(details.map(detail => detail.textContent), ['32s', '1m 05s · needed a check-in · recovered from a dead end: missing colon', '']);
  assert.deepEqual(details.map(detail => detail.hidden), [false, false, true]);
});

test('a challenge debrief lists its detours, one line each, with any explanation', () => {
  const {dialog, created} = renderGuided({
    total: 72, summary: 'ok', components: {}, assistance: {hints: 0, demonstrated_steps: 0}, reference_route: [],
    step_detours: [{id: 'isolate', title: 'Filter to the failing status code', dead_ends: ['search with no results'],
      drift: ['You filtered on a status code, but not the one that stood out in the top values.']},
    {id: 'scope', title: 'Set the time window', dead_ends: ['window missed the incident'],
      notes: ['Your window, the last 15 minutes, started at 04:12 when you chose it, after the report at 04:10.']}],
  });
  assert.equal(dialog.parts['.debrief-detours'].hidden, false);
  const items = created.filter(element => element.parts.strong);
  assert.equal(items[0].parts.strong.textContent, 'Filter to the failing status code');
  assert.deepEqual(items[0].children.map(line => line.textContent),
    ['Dead end: search with no results', 'You filtered on a status code, but not the one that stood out in the top values.']);
  assert.deepEqual(items[1].children.map(line => line.textContent),
    ['Dead end: window missed the incident', 'Your window, the last 15 minutes, started at 04:12 when you chose it, after the report at 04:10.']);
});

test('a finished debrief offers keep exploring or close and return to the main menu', () => {
  const Debrief = loadClass('../src/ui/debrief.js', 'IncidentDebrief');
  const created = [];
  const originalDocument = globalThis.document;
  globalThis.document = {createElement: () => { const element = fakeElement(); created.push(element); return element; }};
  let returned = 0;
  try {
    const debrief = new Debrief({append() {}});
    debrief.show({total: 70, summary: '', assistance});
    // Before the panel offers a way back, the guided debrief just closes.
    assert.match(created[0].innerHTML, /<button class="debrief-keep" autofocus>Done<\/button>/);
    assert.doesNotMatch(created[0].innerHTML, /debrief-return/);
    debrief.onReturnToMenu = () => { returned += 1; };
    debrief.show({total: 70, summary: '', assistance});
    debrief.showDemonstration({title: 'Demo', answer: {conclusion: 'Orders fails.'}, checks: []});
  } finally {
    globalThis.document = originalDocument;
  }
  const [guided, demonstration] = created.filter(element => /debrief-return/.test(element.innerHTML));
  assert.match(guided.innerHTML, /<button class="debrief-keep" autofocus>Keep exploring<\/button>/);
  // A plain dialog scrolls, so its footer doesn't take focus (the dialog opens at the top).
  assert.match(demonstration.innerHTML, /<button class="debrief-keep">Keep exploring<\/button>.*Close investigation &amp; return to main menu/s);
  demonstration.parts['.debrief-return'].onclick();
  assert.equal(returned, 1);
});

test('the time-up notice says the data is gone and leads to the main menu', () => {
  const Debrief = loadClass('../src/ui/debrief.js', 'IncidentDebrief');
  const created = [];
  const originalDocument = globalThis.document;
  globalThis.document = {createElement: () => { const element = fakeElement(); created.push(element); return element; }};
  try {
    const debrief = new Debrief({append() {}});
    debrief.onReturnToMenu = () => {};
    debrief.showTimeUp('14:32');
  } finally {
    globalThis.document = originalDocument;
  }
  const [notice] = created;
  assert.match(notice.className, /incident-time-up/);
  assert.match(notice.parts.p.textContent, /closed at 14:32, and its data has been removed/);
  // Staying is offered but not focused: the way on is the main menu.
  assert.match(notice.innerHTML, /<button class="debrief-keep">Stay on this page<\/button>.*data-choice="return-to-menu" autofocus>Return to main menu<\/button>/s);
});

test('Keep exploring tells the panel; the time-up notice\'s Stay on this page does not', () => {
  const Debrief = loadClass('../src/ui/debrief.js', 'IncidentDebrief');
  const created = [];
  const originalDocument = globalThis.document;
  globalThis.document = {createElement: () => { const element = fakeElement(); created.push(element); return element; }};
  let exploring = 0;
  try {
    const debrief = new Debrief({append() {}});
    debrief.onReturnToMenu = () => {};
    debrief.onKeepExploring = () => { exploring += 1; };
    debrief.showDemonstration({title: 'Demo', answer: {conclusion: 'Orders fails.'}, checks: []});
    debrief.showTimeUp('14:32');
  } finally {
    globalThis.document = originalDocument;
  }
  const [summary, notice] = created.filter(element => /debrief-keep/.test(element.innerHTML));
  summary.parts['.debrief-keep'].onclick();
  assert.equal(exploring, 1);
  assert.equal(notice.parts['.debrief-keep'].onclick, undefined);
});
