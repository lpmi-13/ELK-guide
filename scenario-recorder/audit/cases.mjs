// The audit's learner-driven cases: guided dead-end recovery, and replay across tabs. Here the audit
// acts in Kibana the way a learner would (a window typed into the date box, a query, a pill removed)
// and checks that the coach describes what happened and puts it right without claiming the step done.
import {api, config, deleteRun, evaluate, manifest, runState, sleep} from './harness.mjs';
import {LearnerTab} from './session.mjs';

// Kibana 9.5.2 controls, verified 2026-11-12: the date box opens from its control button and takes a
// typed range on Enter; a pill is removed from its own popover.
async function typeWindow(page, text) {
  await page.locator("[data-test-subj='dateRangePickerControlButton']").click();
  const input = page.locator("[data-test-subj='dateRangePickerInput']");
  await input.fill(text);
  await input.press('Enter');
}

async function removeFirstPill(page) {
  await page.locator("[data-test-subj*='filter-key-']").first().click();
  await page.locator("[data-test-subj='deleteFilter']").click();
}

async function query(page, text) {
  const bar = page.locator("[data-test-subj='queryInput']");
  await bar.click();
  await bar.fill(text);
  await bar.press('Enter');
}

// One guided step done by Show me, its result read, then Continue.
async function showMe(tab) {
  const state = await tab.waitFor(current => tab.current && /what to do/i.test(current.eyebrow) && current.buttons.demonstrate, {label: 'a guided step card'});
  const command = tab.current;
  command.showMe = true;
  command.coachActs = true;
  await tab.click('#demonstrate', 'Show me');
  await tab.waitFor(() => command.resultChecked || tab.current !== command, {timeout: 120000, label: `the result of ${command.message.step_id}`});
  if (tab.current === command) await tab.click('#advance', 'Continue').catch(() => {});
  void state;
  return command;
}

function lastEvaluation(tab, predicate = () => true) {
  return tab.messages.filter(message => message.message_type === 'action_result' && predicate(message)).at(-1)?.evaluation || null;
}

// A dead end is explained at once, says what happened, isn't taken as the step done, and is put right.
async function expectRecovery(tab, {name, eyebrow, mentions, act, resolve}) {
  const {record} = tab;
  const step = tab.current;
  const before = tab.messages.length;
  await act();
  const card = await tab.waitFor(state => eyebrow.test(state.eyebrow) || state.stage?.includes('success'), {timeout: 30000, label: `the ${name} card`}).catch(() => null);
  if (!card) return record.fail('no_recovery_card', `${name}: the coach did not explain the dead end`);
  await record.screenshot(tab.page, `recovery-${name}`);
  if (card.stage?.includes('success')) record.fail('recovery_claimed_success', `${name}: the coach announced new evidence for a dead end`);
  if (mentions && !mentions.test(`${card.headline} ${card.detail}`)) record.fail('recovery_text_inaccurate', `${name}: the card does not say what happened: "${card.headline}"`);
  // Nothing else on the panel may contradict the card (a "restored, carry on" left from an earlier recovery).
  const settledCard = await tab.poll();
  if (/restored|carry on/i.test(settledCard.status?.text || '')) record.fail('stale_status', `${name}: the status line still says "${settledCard.status.text}" under a new dead end`);
  const progressed = tab.messages.slice(before).filter(message => message.message_type === 'action_result').flatMap(message => message.evaluation?.goals_progressed || []);
  if (progressed.includes(step.message.step_id)) record.fail('recovery_claimed_success', `${name}: the dead end completed ${step.message.step_id}`);
  if (tab.current !== step) record.fail('recovery_moved_on', `${name}: the step changed during a dead end`);
  await resolve(card);
  const settled = await tab.waitFor(state => !state.stage?.includes('recovery'), {timeout: 45000, label: `the ${name} recovery to finish`}).catch(() => null);
  if (!settled) record.fail('recovery_stuck', `${name}: the recovery card never cleared`);
  return settled;
}

export async function recoveryCase(tab, deadline) {
  const {page, record} = tab;
  await tab.beginBriefing();
  await tab.waitFor(state => tab.current && /what to do/i.test(state.eyebrow), {label: 'the scope step'});
  if (tab.current.message.type !== 'set_time_range') record.note(`the first guided step is ${tab.current.message.type}, not a time window`);
  // A relative window on the scope step that misses the incident: choose again, nothing restored.
  await expectRecovery(tab, {
    name: 'window-misses', eyebrow: /outside the window/i, mentions: /\d{1,2}:\d{2}/,
    act: () => typeWindow(page, 'Last 1 minute'),
    resolve: () => page.locator('#adaptive-incident-coach #stage-actions button', {hasText: 'Choose again'}).click(),
  });
  const missed = lastEvaluation(tab, message => message.action?.type === 'time_range_changed');
  if (missed && missed.reason_code !== 'window_misses_incident') record.fail('recovery_text_inaccurate', `the service called the missed window ${missed.reason_code}`);
  await showMe(tab);
  // A search with no results on the next step: explained, then reset.
  await tab.waitFor(state => /what to do/i.test(state.eyebrow), {label: 'the step after the window'});
  await expectRecovery(tab, {
    name: 'empty-search', eyebrow: /no results/i, mentions: /status_code|999|query|no match|isn.t|not/i,
    act: () => query(page, 'http.response.status_code is 999'),
    resolve: async card => {
      const reset = page.locator('#adaptive-incident-coach #stage-actions button', {hasText: 'Reset search'});
      if (card.choices.includes('Reset search')) await reset.click();
    },
  });
  const restored = await tab.waitFor(state => !state.page.noResults && state.page.hits, {timeout: 30000, label: 'results after the reset'}).catch(() => null);
  if (!restored) record.fail('recovery_not_restored', 'empty-search: the search was not put back');
  // Show me through the steps that earn a filter.
  while (!(await tab.poll()).page.pills.length && Date.now() < deadline) await showMe(tab);
  await tab.waitFor(state => /what to do/i.test(state.eyebrow), {label: 'the step after the filter'});
  // The earned pill removed: explained, then put back.
  await expectRecovery(tab, {
    name: 'filter-removed', eyebrow: /earned filter removed/i, mentions: /without/i,
    act: () => removeFirstPill(page),
    resolve: async () => {},
  });
  const pill = await tab.waitFor(state => state.page.pills.length, {timeout: 30000, label: 'the pill to come back'}).catch(() => null);
  if (!pill) record.fail('recovery_not_restored', 'filter-removed: the earned filter was not put back');
  // A window that no longer reaches the incident after the scope step: explained, fixed start typed back.
  await sleep(1500);
  await expectRecovery(tab, {
    name: 'window-shifted', eyebrow: /outside the window|window moved on/i, mentions: /\d{1,2}:\d{2}/,
    act: () => typeWindow(page, 'Last 1 minute'),
    resolve: async () => {},
  });
  const fixed = await tab.waitFor(state => /time:\(from:'?\d{4}-/.test(decodeURIComponent(state.page.url)), {timeout: 45000, label: 'a fixed start'}).catch(() => null);
  if (!fixed) record.fail('recovery_not_restored', 'window-shifted: the coach did not put a fixed start back');
  // Finish with Show me; the debrief records the dead ends.
  while (Date.now() < deadline) {
    const state = await tab.poll();
    if (state.debrief) {
      if (!/dead end/i.test(state.debrief.text)) record.fail('debrief_missing_dead_ends', 'the guided debrief does not mention the dead ends');
      return state;
    }
    if (tab.current && !tab.current.showMe && /what to do/i.test(state.eyebrow)) await showMe(tab);
    else await sleep(400);
  }
  throw new Error('guided recovery did not reach its debrief in time');
}

// ------------------------------------------------------------------------------------------------
// Replay across tabs

async function startFromLauncher(context, launcher, title, key, mode) {
  await launcher.locator('.scenario-card', {has: launcher.locator('strong', {hasText: title})}).first().click();
  await launcher.locator('#mode-trigger').click();
  await launcher.locator(`#mode-option-${mode}`).click();
  await launcher.locator('#scenario-key').fill(key);
  const created = launcher.waitForResponse(response => response.url().endsWith('/api/runs') && response.request().method() === 'POST');
  const [tab] = await Promise.all([context.waitForEvent('page'), launcher.locator('#start').click()]);
  const body = await (await created).json();
  await launcher.locator('#start:not([disabled])').waitFor({timeout: 240000}).catch(() => {});
  return {page: tab, runId: body.run?.run_id, sessionId: body.session?.session_id, body};
}

async function binding(page) {
  return evaluate(page, () => {
    try { return JSON.parse(sessionStorage.getItem('incident-coach:auto-connect') || 'null'); } catch (_error) { return null; }
  });
}

export async function replayCase(context, record, spec) {
  const launcher = await context.newPage();
  await launcher.goto(config.launcher, {waitUntil: 'domcontentloaded'});
  const instructions = launcher.locator('#dismiss-instructions');
  if (await instructions.isVisible().catch(() => false)) await instructions.click();
  await launcher.locator('#coach-runtime.online').waitFor({timeout: 30000});
  const entry = (await api('/api/catalog')).body.scenarios.find(item => item.id === spec.scenario);
  const keyA = `${spec.key}-a`.slice(0, 40);
  const keyB = `${spec.key}-b`.slice(0, 40);
  const tabs = [];
  try {
    for (const key of [keyA, keyB, keyA]) {
      const started = await startFromLauncher(context, launcher, entry.title, key, spec.mode);
      await started.page.waitForURL(url => url.href.startsWith(config.kibana), {timeout: 240000});
      tabs.push({...started, key});
    }
    const manifests = await Promise.all(tabs.map(item => manifest(item.runId)));
    const [first, other, repeat] = manifests;
    if (JSON.stringify(first.parameters) !== JSON.stringify(repeat.parameters)) record.fail('replay_parameters_changed', 'the repeated key did not reproduce the incident');
    if (first.run_id === repeat.run_id || first.space_id === repeat.space_id) record.fail('replay_reused_run', 'the repeated key reused a run id or Space');
    if (JSON.stringify(first.parameters) === JSON.stringify(other.parameters)) record.note('the two keys happened to choose the same parameters');
    for (const [index, item] of tabs.entries()) {
      const bound = await binding(item.page);
      if (bound?.session !== item.sessionId || bound?.runId !== item.runId) record.fail('tab_not_bound', `tab ${index + 1} is bound to ${bound?.session}/${bound?.runId}, not its own session`);
      if (!item.page.url().includes(`/s/${manifests[index].space_id}/`)) record.fail('tab_wrong_space', `tab ${index + 1} is not in its run's Space`);
    }
    // A refreshed tab stays bound to its own session.
    await tabs[0].page.reload({waitUntil: 'domcontentloaded'});
    await sleep(4000);
    const rebound = await binding(tabs[0].page);
    if (rebound?.session !== tabs[0].sessionId) record.fail('refresh_lost_binding', 'a refreshed tab lost its session');
    // Cleaning up one run ends that tab's session only.
    await deleteRun(tabs[1].runId);
    await tabs[1].page.reload({waitUntil: 'domcontentloaded'});
    const ended = new LearnerTab(context, record, spec);
    ended.page = tabs[1].page;
    const endedState = await ended.waitFor(state => state.choices?.includes('Return to the launcher'), {timeout: 90000, label: 'the cleaned-up tab to end'}).catch(() => null);
    if (!endedState) record.fail('no_return_path', 'the cleaned-up run\'s tab did not offer the way back');
    else await record.screenshot(tabs[1].page, 'replay-ended-tab');
    for (const index of [0, 2]) {
      const live = new LearnerTab(context, record, spec);
      live.page = tabs[index].page;
      const state = await live.waitFor(current => current.briefing || current.panelVisible, {timeout: 60000, label: `tab ${index + 1}'s coach`}).catch(() => null);
      if (!state) record.fail('replay_tab_broken', `tab ${index + 1} lost its coach after another run was cleaned up`);
      else if (state.choices?.includes('Return to the launcher')) record.fail('replay_tab_broken', `tab ${index + 1} ended with another tab's run`);
      if (await runState(tabs[index].runId) !== 'READY' && await runState(tabs[index].runId) !== 'INVESTIGATING') record.fail('replay_tab_broken', `tab ${index + 1}'s run is no longer live`);
    }
    // A preparation that fails stays on the preparation page with a way back.
    const failing = launcher.waitForResponse(response => response.url().endsWith('/api/runs') && response.request().method() === 'POST');
    await launcher.locator('#scenario-key').fill(`${spec.key}-x`.slice(0, 40));
    const [prep] = await Promise.all([context.waitForEvent('page'), launcher.locator('#start').click()]);
    const doomed = await (await failing).json();
    await deleteRun(doomed.run?.run_id);
    const halted = await prep.locator('#back:not([hidden]) a').waitFor({timeout: 30000}).then(() => true).catch(() => false);
    if (!halted) record.fail('failed_preparation_no_return', 'a stopped preparation offered no way back to the launcher');
    if (!prep.url().startsWith(config.launcher)) record.fail('failed_preparation_left', `a stopped preparation left the preparation page: ${prep.url()}`);
    const message = await prep.locator('#msg').innerText().catch(() => '');
    if (/\{|validators|run-[0-9a-f]/.test(message)) record.fail('internal_identifier', `the preparation failure shows internal detail: ${message}`);
    await record.screenshot(prep, 'preparation-stopped');
    if (halted) {
      await prep.locator('#return').click();
      await prep.waitForURL(url => url.pathname === '/' && url.href.startsWith(config.launcher), {timeout: 15000}).catch(() => record.fail('failed_preparation_no_return', 'Return to the launcher did not open it'));
    }
  } finally {
    for (const item of tabs) await deleteRun(item.runId);
  }
}
