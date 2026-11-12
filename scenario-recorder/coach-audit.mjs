#!/usr/bin/env node
// Real-coach browser audit. Starts each case from the launcher (scenario, mode, fixed key, viewport),
// lets the built-in coach operate Kibana, and checks what a learner sees: each declared action is
// visibly performed and then shown, the card keeps off what it talks about, the debrief matches the
// run's manifest and the controller run is COMPLETED. It never calls the coach's adapter, never sends
// on the learning socket and never submits the reference answer; it clicks only what a learner would.
// recorder.mjs stays the reference recording tool; this is the acceptance test.
//
//   node coach-audit.mjs --mvp                                    # the first gate (see LOCAL_TEST_PLAN.md)
//   node coach-audit.mjs --scenario rare-error-signature --mode guided --viewport 1280x800
//   node coach-audit.mjs --mvp --case robustness --case recovery --case replay
//   node coach-audit.mjs --all --surface dashboard                # the manual catalog sweep, by surface
//
// Each case writes recordings/audit/<run>/<case>/: summary.json, events.jsonl, step screenshots, and
// on failure dom.html, coach.html and trace.zip (open with `npx playwright show-trace`).
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {INSTRUMENT, Record, api, config, deleteRun, manifest, playwright, runState, sleep} from './audit/harness.mjs';
import {LearnerTab} from './audit/session.mjs';
import {recoveryCase, replayCase} from './audit/cases.mjs';

const MVP = ['http-error-regression', 'rare-error-signature'];

function parseArgs(argv) {
  const options = {scenarios: [], modes: [], viewports: [], speeds: [], cases: [], surface: null, all: false, headed: false, out: null, key: null, timeout: 20};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === '--scenario') options.scenarios.push(next());
    else if (arg === '--mvp') options.scenarios.push(...MVP);
    else if (arg === '--all') options.all = true;
    else if (arg === '--surface') options.surface = next();
    else if (arg === '--mode') options.modes.push(next());
    else if (arg === '--viewport') options.viewports.push(next());
    else if (arg === '--speed') options.speeds.push(next());
    else if (arg === '--case') options.cases.push(next());
    else if (arg === '--key') options.key = next();
    else if (arg === '--out') options.out = next();
    else if (arg === '--timeout') options.timeout = Number(next());
    else if (arg === '--headed') options.headed = true;
    else if (arg === '--help') { console.log(argv0Help()); process.exit(0); }
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

function argv0Help() {
  return 'usage: coach-audit.mjs [--mvp | --scenario ID ... | --all [--surface S]] [--mode demonstration|guided|challenge ...]\n' +
    '  [--viewport 1440x900 ...] [--speed normal|advance ...] [--case flow|robustness|recovery|replay ...] [--key KEY] [--out DIR] [--headed]';
}

export function fixedKey(scenario, suffix = '') {
  return `audit-${scenario}${suffix}`.slice(0, 40).replace(/-$/, '').padEnd(10, '0');
}

// ------------------------------------------------------------------------------------------------
// Mode drivers

async function demonstrate(tab, speed, deadline) {
  await tab.beginBriefing();
  let lastAdvance = 0;
  while (Date.now() < deadline) {
    const state = await tab.poll();
    if (state.debrief) return state;
    tab.assertProgress(state);
    const advance = state.buttons?.advance;
    // Advance while the coach acts can land on the result card that replaces it a moment later (and skip
    // it); the robustness case presses it there deliberately. Here it speeds the reading beats only.
    const acting = /doing it now/i.test(state.eyebrow);
    if (advance && !advance.disabled && state.panelVisible && Date.now() - lastAdvance > 900 && !tab.resultPending()) {
      if (advance.text === 'Continue' || (speed === 'advance' && !acting)) {
        lastAdvance = Date.now();
        await tab.click('#advance', advance.text).catch(() => {});
      }
    }
    await sleep(350);
  }
  throw new Error('the demonstration did not reach its summary in time');
}

async function guide(tab, deadline) {
  await tab.beginBriefing();
  let lastClick = 0;
  while (Date.now() < deadline) {
    const state = await tab.poll();
    if (state.debrief) return state;
    tab.assertProgress(state);
    const command = tab.current;
    const advance = state.buttons?.advance;
    if (command && !command.showMe && command.message.mode === 'guided' && !['request_answer', 'request_diagnosis'].includes(command.message.type)
        && state.buttons?.demonstrate && !state.buttons.demonstrate.disabled && /what to do/i.test(state.eyebrow) && Date.now() - lastClick > 900) {
      command.showMe = true;
      command.coachActs = true;
      lastClick = Date.now();
      await tab.click('#demonstrate', 'Show me');
    } else if (advance?.text === 'Continue' && state.stage?.includes('result') && !tab.resultPending() && Date.now() - lastClick > 900) {
      lastClick = Date.now();
      await tab.click('#advance', 'Continue').catch(() => {});
    } else if (state.choices.includes('Keep going')) {
      await tab.page.locator('#adaptive-incident-coach #stage-actions button', {hasText: 'Keep going'}).click().catch(() => {});
    }
    await sleep(350);
  }
  throw new Error('guided practice did not reach its debrief in time');
}

// A challenge reveals nothing of the reference route and gives no live verdict. The audit acts as a
// learner who searches once and then answers without knowing the answer (never the reference answer).
async function challenge(tab, deadline) {
  await tab.beginBriefing();
  const opening = await tab.waitFor(state => state.panelVisible && state.diagnosisForm, {label: 'the challenge answer form'});
  const record = tab.record;
  if (opening.objective !== 'Your investigation') record.fail('challenge_reveals_route', `the challenge heading names a step: ${opening.objective}`);
  if (opening.spotlight || opening.rings.length) record.fail('challenge_reveals_route', 'the challenge highlights a control or evidence');
  if (opening.buttons.hint || opening.buttons.demonstrate) record.fail('challenge_reveals_route', 'the challenge offers Hint or Show me');
  if (/step \d+ of \d+/i.test(opening.modeLine)) record.fail('challenge_reveals_route', `the challenge shows progress: ${opening.modeLine}`);
  await record.screenshot(tab.page, 'challenge-opening');
  const bar = tab.page.locator("[data-test-subj='queryInput']");
  if (await bar.isVisible().catch(() => false)) {
    await bar.click();
    await bar.fill('event.outcome : "failure"');
    await bar.press('Enter');
    const result = await tab.waitFor(() => tab.messages.some(message => message.message_type === 'action_result'), {timeout: 30000, label: 'the recorded search'}).catch(() => null);
    const evaluations = tab.messages.filter(message => message.message_type === 'action_result').map(message => message.evaluation?.outcome);
    if (!result) record.fail('challenge_action_unrecorded', 'the learner\'s search was never recorded');
    else if (evaluations.some(outcome => outcome !== 'recorded')) record.fail('challenge_live_feedback', `the challenge told the learner how an action went: ${evaluations.join(', ')}`);
    const after = await tab.waitFor(state => state.stage?.includes('success') || state.stage?.includes('recovery'), {timeout: 4000, label: 'no verdict'}).catch(() => null);
    if (after) record.fail('challenge_live_feedback', `the challenge showed a live verdict card: ${after.eyebrow}`);
  }
  for (const field of await tab.page.locator('#adaptive-incident-coach #diagnosis input, #adaptive-incident-coach #diagnosis textarea').all()) {
    await field.fill('unknown');
  }
  await tab.click('#diagnosis button[type="submit"]', 'Submit answer');
  return tab.waitFor(state => state.debrief, {timeout: Math.max(5000, deadline - Date.now()), label: 'the challenge debrief'});
}

// ------------------------------------------------------------------------------------------------
// The end of a run: debrief, run state, manifest, and dismiss/reopen

function plain(value) {
  return typeof value === 'string' && value && !value.includes('${') ? value : null;
}

// The distinctive parts of a fact — numbers, clock times, names — each of which the debrief must show,
// whatever words join them ("16:24–16:30" is shown as "between 16:24 and 16:30").
function factTokens(value) {
  return [...new Set(String(value).toLowerCase().match(/\d+(?:[.:]\d+)*|[a-z][\w.@/-]{3,}/g) || [])]
    .filter(token => !['between', 'with', 'from', 'that', 'this', 'than', 'only', 'their'].includes(token));
}

function missingTokens(value, text) {
  const shown = text.toLowerCase();
  // "requests/second" may read "requests per second": each part of a slashed token is enough.
  const present = token => shown.includes(token) || (token.includes('/') && token.split('/').filter(part => part.length > 2).every(part => shown.includes(part)));
  return factTokens(value).filter(token => !present(token));
}

async function checkCompletion(tab, state) {
  const {record} = tab;
  const {mode, runId, sessionId} = tab.run;
  await record.screenshot(tab.page, 'debrief');
  let final = '';
  for (let attempt = 0; attempt < 20 && final !== 'COMPLETED'; attempt += 1) {
    final = await runState(runId);
    if (final !== 'COMPLETED') await sleep(500);
  }
  if (final !== 'COMPLETED') record.fail('run_not_completed', `the debrief appeared but the controller run is ${final}`);
  const feedback = (await api(`/api/sessions/${sessionId}/feedback`)).body || {};
  const runManifest = await manifest(runId);
  record.spec.seed = runManifest.seed;
  record.spec.parameters = runManifest.parameters || null;
  const truth = runManifest.scenario.truth.answers || {};
  const shown = state.debrief.text.toLowerCase();
  const expected = {};
  if (mode === 'demonstration') {
    // The summary is a compact recap by design: its "Problem found" is the run's conclusion, which names
    // the finding; the scope is not repeated there.
    for (const field of ['finding', 'conclusion']) expected[field] = feedback.demonstration_summary?.answer?.[field];
  } else if (mode === 'challenge') {
    for (const item of feedback.answer_review || []) if (['finding', 'scope'].includes(item.id)) expected[item.id] = item.expected;
  }
  for (const [field, value] of Object.entries(expected)) {
    if (plain(truth[field]) && value !== truth[field]) record.fail('debrief_not_from_manifest', `the debrief's ${field} (${value}) is not the run's (${truth[field]})`);
    const missing = value ? missingTokens(value, shown) : [];
    if (missing.length) record.fail('debrief_missing_fact', `the debrief does not show the run's ${field} (${value}): missing ${missing.join(', ')}`);
  }
  if (mode === 'guided' && !/guided-debrief/.test(state.debrief.className)) record.fail('wrong_debrief', 'guided practice did not end on its scored debrief');
  // Dismiss it, then open it again from the panel.
  await tab.page.locator('#adaptive-incident-coach dialog.incident-debrief .dialog-close').first().click();
  const closed = await tab.waitFor(current => !current.debrief, {timeout: 10000, label: 'the debrief to close'}).catch(() => null);
  if (!closed) return record.fail('debrief_not_dismissable', 'the debrief could not be closed');
  if (!closed.buttons['review-feedback']) return record.fail('debrief_not_reopenable', 'after closing the debrief there is no Review feedback');
  await tab.click('#review-feedback', 'Review feedback');
  const reopened = await tab.waitFor(current => current.debrief, {timeout: 15000, label: 'the debrief to reopen'}).catch(() => null);
  if (!reopened) record.fail('debrief_not_reopenable', 'Review feedback did not open the debrief again');
  else if (expected.finding && missingTokens(expected.finding, reopened.debrief.text).length) record.fail('debrief_not_reopenable', 'the reopened debrief lost the finding');
  return null;
}

// ------------------------------------------------------------------------------------------------
// Robustness: Pause, Advance while acting, a hidden tab, a reload, a service outage, an expired session

async function robustness(tab, deadline) {
  const {record, page} = tab;
  // The learning socket goes through a pass-through route, so the audit can drop it as an outage would.
  const routes = [];
  await page.routeWebSocket(/incident-coach\/learning/, socket => {
    socket.connectToServer();
    routes.push(socket);
  });
  await page.reload({waitUntil: 'domcontentloaded'});
  await tab.beginBriefing();
  // Pause freezes the opening reading beat; resuming continues the same command.
  const goal = await tab.waitFor(state => state.countdown && !state.countdown.working && /what i/i.test(state.eyebrow) && state.buttons.pause, {label: 'a reading beat'});
  const command = tab.current?.message.command_id;
  await tab.click('#pause', 'Pause');
  await sleep(600);
  const frozen = (await tab.poll()).countdown?.width;
  await sleep(2500);
  const still = await tab.poll();
  if (Math.abs((still.countdown?.width ?? 0) - (frozen ?? 0)) > 2) record.fail('pause_not_frozen', `the countdown kept moving while paused (${frozen} → ${still.countdown?.width})`);
  if (tab.current?.message.command_id !== command) record.fail('pause_changed_command', 'pausing changed the command on screen');
  await tab.click('#pause', 'Resume');
  await sleep(1500);
  const resumed = await tab.poll();
  if (tab.current?.message.command_id === command && resumed.eyebrow === goal.eyebrow && Math.abs((resumed.countdown?.width ?? 0) - (still.countdown?.width ?? 0)) <= 2) {
    record.fail('resume_stuck', 'the countdown did not continue after Resume');
  }
  // Advance while the coach acts waits for the action, and the result is still shown.
  const acting = await tab.waitFor(state => /doing it now/i.test(state.eyebrow) && state.buttons.advance && !state.buttons.advance.disabled, {label: 'the coach acting', interval: 150});
  const actingCommand = tab.current;
  await tab.click('#advance', 'Advance (while acting)');
  const pending = await tab.poll();
  if (!pending.buttons.advance?.disabled && acting.buttons.advance?.text === pending.buttons.advance?.text && /doing it now/i.test(pending.eyebrow)) {
    record.note('Advance during the action showed no pending state (the action may have just finished)');
  }
  await tab.waitFor(state => state.stage?.includes('result') || tab.current !== actingCommand, {label: 'the result after Advance'});
  if (tab.current === actingCommand && !actingCommand.resultSeen) record.fail('advance_skipped_result', 'Advance during the action skipped its result card');
  await tab.waitFor(() => actingCommand.resultChecked, {timeout: 10000, label: 'the result card'}).catch(() => {});
  await tab.click('#advance', 'Continue').catch(() => {});
  // A hidden tab: the coach carries on with the same step and reports no error.
  const hiddenStep = (await tab.waitFor(state => state.panelVisible && tab.current && tab.current !== actingCommand, {label: 'the next step'}), tab.current.message.step_id);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', {configurable: true, get: () => true});
    Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'hidden'});
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await sleep(3000);
  await page.evaluate(() => {
    delete document.hidden;
    delete document.visibilityState;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const visible = await tab.poll();
  if (visible.status?.error) record.fail('hidden_tab_error', `after the tab was hidden the coach showed: ${visible.status.text}`);
  // A reload: the same step resumes, without the briefing again.
  const before = tab.current.message.step_id;
  if (before !== hiddenStep && tab.commands.size < 2) record.note(`the step moved on while hidden (${hiddenStep} → ${before})`);
  const sentBefore = tab.messages.length;
  await page.reload({waitUntil: 'domcontentloaded'});
  // Wait for what the reconnected session sends first: the same step's command, not a new briefing.
  const first = await tab.waitFor(() => tab.messages.slice(sentBefore).find(message => ['command', 'incident_briefing', 'complete', 'failed'].includes(message.message_type)),
    {timeout: 90000, label: 'the coach after a reload'}).then(() => tab.messages.slice(sentBefore).find(message => ['command', 'incident_briefing', 'complete', 'failed'].includes(message.message_type)));
  if (first.message_type === 'incident_briefing') record.fail('reload_rebriefed', 'a reload showed the incident briefing again');
  else if (first.message_type !== 'command') record.fail('reload_changed_step', `after a reload the session sent ${first.message_type}`);
  else if (first.step_id !== before) record.fail('reload_changed_step', `after a reload the coach was on ${first.step_id}, not ${before}`);
  await tab.waitFor(state => state.panelVisible, {timeout: 30000, label: 'the coach card after a reload'}).catch(() => record.fail('reload_no_coach', 'the coach did not come back after a reload'));
  // A service outage: the socket drops and reconnects are refused (the browser goes offline, so the
  // coach's check on the session can't reach the service either). The coach must say it is retrying,
  // escalate while it can't connect, offer Retry now, complete nothing meanwhile, and carry on after.
  tab.expectErrors = true;
  tab.interrupted = true;
  await tab.context.setOffline(true);
  for (const socket of routes.splice(0)) await socket.close({code: 1011, reason: 'audit: outage'}).catch(() => {});
  const away = await tab.waitFor(state => /reconnecting|not answering/i.test(state.status?.text || ''), {timeout: 20000, label: 'the reconnect status'}).catch(() => null);
  if (!away) record.fail('no_retry_path', 'a dropped learning connection showed no reconnecting status');
  const escalated = await tab.waitFor(state => /not answering/i.test(state.status?.text || ''), {timeout: 20000, label: 'the escalated status'}).catch(() => null);
  if (!escalated) record.fail('no_retry_path', 'refused reconnects never said the service is not answering');
  const retryButton = page.locator('#adaptive-incident-coach #status .status-action');
  if (!(await retryButton.isVisible().catch(() => false))) record.fail('no_retry_path', 'the reconnect status offers no Retry now');
  await record.screenshot(page, 'outage');
  const during = await runState(tab.run.runId);
  if (during === 'COMPLETED') record.fail('outage_completed_run', 'the run completed during the outage');
  await tab.context.setOffline(false);
  if (await retryButton.isVisible().catch(() => false)) await retryButton.click();
  const recovered = await tab.waitFor(state => !/reconnecting|not answering/i.test(state.status?.text || ''), {timeout: 30000, label: 'the reconnection'}).catch(() => null);
  if (!recovered) record.fail('no_recovery_after_outage', 'the coach did not reconnect after the service returned');
  const carriedOn = await tab.waitFor(state => state.panelVisible && /what i|doing it now|what this shows/i.test(state.eyebrow), {timeout: 30000, label: 'the demonstration after the outage'}).catch(() => null);
  if (!carriedOn) record.fail('no_recovery_after_outage', 'the demonstration did not carry on after reconnecting');
  tab.expectErrors = false;
  tab.networkFailures.length = 0;
  // An expired session: the run is cleaned up; after a reload the coach offers the way back.
  await deleteRun(tab.run.runId);
  tab.networkFailures.length = 0;
  await page.reload({waitUntil: 'domcontentloaded'});
  const ended = await tab.waitFor(state => /session ended/i.test(state.eyebrow) || state.choices.includes('Return to the launcher'), {timeout: 60000, label: 'the session-ended card'}).catch(() => null);
  if (!ended) {
    record.fail('no_return_path', 'after its run was cleaned up the coach did not offer the way back');
  } else {
    await record.screenshot(page, 'session-ended');
    tab.networkFailures.length = 0;
    await page.locator('#adaptive-incident-coach #stage-actions button', {hasText: 'Return to the launcher'}).click();
    await page.waitForURL(url => url.href.startsWith(config.launcher), {timeout: 30000}).catch(() => record.fail('no_return_path', 'Return to the launcher did not open the launcher'));
  }
  void deadline;
}

// ------------------------------------------------------------------------------------------------
// Running cases

async function runCase(browser, spec, root) {
  const name = [spec.case, spec.scenario, spec.mode, spec.viewport, spec.speed].filter(Boolean).join('_');
  const record = new Record(path.join(root, name), spec);
  await record.open();
  const [width, height] = spec.viewport.split('x').map(Number);
  const context = await browser.newContext({viewport: {width, height}, timezoneId: 'UTC', locale: 'en-US'});
  await context.addInitScript(INSTRUMENT);
  await context.tracing.start({screenshots: true, snapshots: true});
  const tab = new LearnerTab(context, record, spec);
  const deadline = Date.now() + spec.timeoutMinutes * 60000;
  console.log(`\n▶ ${name}`);
  let crashed = null;
  const started = Date.now();
  try {
    if (spec.case === 'replay') {
      await replayCase(context, record, spec);
    } else {
      await tab.launch();
      if (spec.case === 'robustness') await robustness(tab, deadline);
      else if (spec.case === 'recovery') await checkCompletion(tab, await recoveryCase(tab, deadline));
      else {
        const state = spec.mode === 'demonstration' ? await demonstrate(tab, spec.speed, deadline)
          : spec.mode === 'guided' ? await guide(tab, deadline) : await challenge(tab, deadline);
        tab.finish();
        await checkCompletion(tab, state);
      }
    }
  } catch (error) {
    crashed = error;
    record.fail('case_error', error.message.split('\n')[0]);
  } finally {
    tab.finish();
    if (record.findings.length) await record.snapshot(tab.page || context.pages().at(-1), context);
    else await context.tracing.stop().catch(() => {});
    await deleteRun(tab.run?.runId);
    await context.close().catch(() => {});
  }
  const summary = await record.save({name, run_id: tab.run?.runId || null, seconds: Math.round((Date.now() - started) / 1000), error: crashed?.message || null});
  console.log(`${summary.passed ? '✓' : '✗'} ${name} (${summary.seconds}s, ${summary.findings.length} findings)`);
  return summary;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const catalog = (await api('/api/catalog')).body;
  if (!catalog?.scenarios) throw new Error(`the learning service at ${config.learning} is not answering`);
  const capabilities = (await api('/api/capabilities')).body?.capabilities || {};
  const fs = await import('node:fs');
  const packs = JSON.parse(fs.readFileSync(path.join(config.repo, 'learning', 'catalog.json'), 'utf8')).scenarios
    .filter(item => item.classification === 'core' && (item.required_capabilities || []).every(capability => capabilities[capability]));
  let scenarios = options.scenarios.length ? options.scenarios : options.all ? packs.map(item => item.id) : MVP;
  if (options.surface) scenarios = scenarios.filter(id => packs.find(item => item.id === id)?.surface === options.surface);
  const modes = options.modes.length ? options.modes : ['demonstration'];
  const viewports = options.viewports.length ? options.viewports : (options.all ? ['1440x900'] : ['1440x900', '1280x800']);
  const speeds = options.speeds.length ? options.speeds : (options.all ? ['advance'] : ['normal', 'advance']);
  const cases = options.cases.length ? options.cases : ['flow'];
  const specs = [];
  for (const kind of cases) {
    for (const scenario of kind === 'replay' ? [scenarios[0]] : scenarios) {
      const caseModes = kind === 'robustness' ? ['demonstration'] : kind === 'recovery' || kind === 'replay' ? ['guided'] : modes;
      for (const mode of caseModes) {
        for (const viewport of kind === 'flow' ? viewports : [viewports[0]]) {
          for (const speed of kind === 'flow' && mode === 'demonstration' ? speeds : [null]) {
            specs.push({case: kind, scenario, mode, viewport, speed, key: options.key || fixedKey(scenario), timeoutMinutes: options.timeout});
          }
        }
      }
    }
  }
  const root = path.resolve(options.out || path.join(config.repo, 'recordings', 'audit', new Date().toISOString().replace(/[:.]/g, '-')));
  await mkdir(root, {recursive: true});
  const {chromium} = playwright();
  const browser = await chromium.launch({headless: !options.headed, channel: process.env.PW_CHANNEL || undefined});
  const results = [];
  try {
    for (const spec of specs) results.push(await runCase(browser, spec, root));
  } finally {
    await browser.close();
  }
  const failed = results.filter(item => !item.passed);
  await writeFile(path.join(root, 'summary.json'), JSON.stringify({cases: results.map(({name, passed, seconds, findings, notes, run_id}) => ({name, passed, seconds, run_id, findings, notes}))}, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} cases passed. Artifacts: ${root}`);
  for (const item of failed) for (const finding of item.findings) console.log(`  ${item.name}: ${finding.code}: ${finding.message}`);
  process.exitCode = failed.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 2;
  });
}
