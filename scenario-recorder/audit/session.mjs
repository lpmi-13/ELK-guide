// One learner tab, from the launcher to the coach's debrief: starting a run the way a learner does,
// then watching the real coach — every message it receives, every click and keystroke on the page, the
// card, pointer, spotlight and evidence rings on screen — and checking each beat as it happens.
import {INSTRUMENT, KNOWN_SILENT_FAILURES, READ_COACH, api, appOf, config, evaluate, insideViewport, overlapShare, sleep} from './harness.mjs';

const ANSWER_COMMANDS = new Set(['request_answer', 'request_diagnosis', 'show_debrief', 'orient']);
const INTERNAL_TEXT = [/\$\{[^}]*\}/, /\brun-[0-9a-f]{8,}/, /\blab-[0-9a-f]{8,}/, /\bsession-[0-9a-f]{8,}/, /\b(?:truth|param|var)\.[a-z_]+/];

// The card may cover at most this share of what it must keep clear (a control in use, ringed evidence,
// a flyout, a Kibana notice) for longer than COVER_GRACE_MS (a card still gliding into place, or moving
// off a flyout that just opened under it, is not judged).
const COVER_LIMIT = 0.25;
const COVER_GRACE_MS = 1500;
// Steps whose action is to read what is on screen: the coach points, and pressing anything would be wrong.
const READ_STEPS = [command => command.message.type === 'inspect_field' && command.message.target === 'kibana.esql_first_result'];

export class LearnerTab {
  constructor(context, record, spec) {
    this.context = context;
    this.record = record;
    this.spec = spec;
    this.page = null;
    this.run = null;
    this.commands = new Map();
    this.current = null;
    this.messages = [];
    this.lastState = null;
    this.covering = new Map();
    this.networkFailures = [];
  }

  // ----------------------------------------------------------------------------------------------
  // Starting a run

  // Through the launcher, as a learner: pick the card, the mode and the key, then Start; the
  // preparation tab becomes the Kibana tab. Packs the launcher doesn't list (another track) are started
  // through the same API call and handoff the launcher makes.
  async launch() {
    const {scenario, mode, key} = this.spec;
    const catalog = (await api('/api/catalog')).body;
    const entry = catalog?.scenarios?.find(item => item.id === scenario);
    if (entry) return this.launchFromLauncher(entry, mode, key);
    this.record.note(`${scenario} is not on the launcher's track; started through the launcher's API call and handoff`);
    return this.launchByHandoff(scenario, mode, key);
  }

  async launchFromLauncher(entry, mode, key) {
    const launcher = await this.context.newPage();
    this.launcherPage = launcher;
    await launcher.goto(config.launcher, {waitUntil: 'domcontentloaded'});
    const instructions = launcher.locator('#dismiss-instructions');
    if (await instructions.isVisible().catch(() => false)) await instructions.click();
    await launcher.locator('#coach-runtime.online').waitFor({timeout: 30000});
    const card = launcher.locator('.scenario-card', {has: launcher.locator('strong', {hasText: entry.title})}).first();
    await card.click();
    const cardText = await card.innerText();
    this.checkWording('launcher card', cardText, {packIds: false});
    await launcher.locator('#mode-trigger').click();
    await launcher.locator(`#mode-option-${mode}`).click();
    await launcher.locator('#scenario-key').fill(key);
    const created = launcher.waitForResponse(response => response.url().endsWith('/api/runs') && response.request().method() === 'POST', {timeout: 60000});
    const [prep] = await Promise.all([this.context.waitForEvent('page', {timeout: 30000}), launcher.locator('#start').click()]);
    const response = await created;
    const body = await response.json();
    if (!response.ok()) throw new Error(`the launcher's start failed (${response.status()}): ${JSON.stringify(body)}`);
    this.run = {runId: body.run.run_id, sessionId: body.session.session_id, token: body.session.connection_token, mode};
    await this.watch(prep);
    await prep.waitForLoadState('domcontentloaded');
    const preparing = await evaluate(prep, () => document.body.innerText).catch(() => '');
    if (preparing) this.checkWording('preparation page', preparing);
    await this.record.screenshot(prep, 'preparing');
    await prep.waitForURL(url => url.href.startsWith(config.kibana), {timeout: 240000});
    this.page = prep;
    return this.run;
  }

  async launchByHandoff(scenario, mode, key) {
    const {status, body} = await api('/api/runs', {method: 'POST', body: {scenario, mode, scenario_key: key}});
    if (status !== 202) throw new Error(`could not start ${scenario} (${status}): ${JSON.stringify(body)}`);
    this.run = {runId: body.run.run_id, sessionId: body.session.session_id, token: body.session.connection_token, mode};
    const deadline = Date.now() + 240000;
    let ready = null;
    while (Date.now() < deadline) {
      ready = (await api(`/api/runs/${this.run.runId}`)).body;
      if (ready?.state === 'READY') break;
      if (['FAILED', 'ABORTED'].includes(ready?.state)) throw new Error(`run ${ready.state}: ${ready.error}`);
      await sleep(1500);
    }
    if (ready?.state !== 'READY') throw new Error('run never became ready');
    const target = new URL(ready.investigation_url, config.kibana);
    const separator = target.hash.indexOf('?');
    const route = separator >= 0 ? target.hash.slice(0, separator) : target.hash;
    const parameters = new URLSearchParams(separator >= 0 ? target.hash.slice(separator + 1) : '');
    parameters.set('incident_coach_server', `${target.origin}/incident-coach/learning`);
    parameters.set('incident_coach_session', body.session.session_id);
    parameters.set('incident_coach_token', body.session.connection_token);
    parameters.set('incident_coach_run', body.run.run_id);
    parameters.set('incident_coach_mode', mode);
    target.hash = `${route}?${parameters}`;
    const page = await this.context.newPage();
    await this.watch(page);
    await page.goto(target.href, {waitUntil: 'domcontentloaded'});
    this.page = page;
    return this.run;
  }

  async watch(page) {
    page.on('requestfailed', request => {
      const failure = request.failure()?.errorText || '';
      if (/ERR_ABORTED|NS_BINDING_ABORTED/.test(failure)) return; // Kibana cancels superseded searches
      this.networkFailures.push({url: request.url(), failure});
    });
    page.on('response', response => {
      const url = response.url();
      if (response.status() >= 500 || (response.status() >= 400 && /incident-coach\/learning/.test(url))) {
        this.networkFailures.push({url, status: response.status()});
      }
    });
    page.on('pageerror', error => this.record.event({kind: 'pageerror', message: String(error.message).slice(0, 300)}));
  }

  // ----------------------------------------------------------------------------------------------
  // Watching

  // Drain the page's events, read the coach, and check this moment. Returns the coach state.
  async poll() {
    const drain = () => evaluate(this.page, () => window.__audit?.drain() || []).catch(() => []);
    const events = await drain();
    const state = await evaluate(this.page, READ_COACH);
    // Drain again: a message that arrived between the two reads is what put this state on screen.
    events.push(...await drain());
    for (const event of events) await this.observe(event);
    await this.inspect(state);
    this.lastState = state;
    return state;
  }

  async observe(event) {
    await this.record.event(event);
    if (event.kind === 'ws_in') {
      const message = event.message;
      this.messages.push(message);
      if (message.message_type === 'command') await this.startCommand(message);
      if (message.message_type === 'action_result' && this.current && message.evaluation) this.current.results.push(message.evaluation);
      return;
    }
    if (!this.current) return;
    if ((event.kind === 'click' || event.kind === 'input' || event.kind === 'enter') && event.target && !event.target.inCoach) {
      this.current[event.kind === 'click' ? 'clicks' : 'inputs'].push({subject: event.target.subject, text: event.target.text, value: event.value, trusted: event.trusted, path: event.path});
    }
    if (event.kind === 'pointer_click') this.current.pointerClicks.push({subject: event.target?.subject, text: event.target?.text});
  }

  async startCommand(message) {
    if (this.commands.has(message.command_id)) {
      this.current = this.commands.get(message.command_id);
      this.current.resent += 1;
      return;
    }
    let value = null;
    try { value = message.value ? JSON.parse(message.value) : null; } catch (_error) { value = message.value; }
    this.current = {
      message, value, startedAt: Date.now(), clicks: [], inputs: [], pointerClicks: [], cursorSeen: false, cursorOutside: false, resultSeen: false,
      rings: 0, resultChecks: null, results: [], apps: new Set(), resent: 0, showMe: false, coachActs: message.mode === 'demonstration',
    };
    this.commands.set(message.command_id, this.current);
    const label = `step-${(message.step_index ?? 0) + 1}-${message.step_id}-${message.mode}`;
    const shot = this.page ? await this.record.screenshot(this.page, label) : null;
    this.record.steps.push({command_id: message.command_id, step_id: message.step_id, step_title: message.step_title, type: message.type, mode: message.mode,
      url: this.lastState?.page?.url || null, narration: message.narration, screenshot: shot});
    console.log(`  step ${(message.step_index ?? 0) + 1}/${message.step_count} ${message.step_id} (${message.type})`);
  }

  // A step the coach performed (a demonstration step, or a guided Show me) must have visibly acted in
  // Kibana, pointed at what it used, and ended on a result card ringing its evidence.
  finishCommand(command) {
    const {message} = command;
    const step = `${message.step_id} (${message.type})`;
    if (!command.coachActs || ANSWER_COMMANDS.has(message.type)) return;
    const reading = READ_STEPS.some(test => test(command));
    if (!reading && !command.clicks.length && !command.inputs.length && !command.pointerClicks.length) {
      this.record.fail('no_visible_action', `${step}: the coach reported the step without a visible click or keystroke in Kibana`);
    }
    if (!command.cursorSeen) this.record.fail('no_pointer', `${step}: no pointer was shown while the coach acted`);
    if (command.cursorOutside) this.record.fail('pointer_outside_viewport', `${step}: the pointer went outside the viewport`);
    if (!command.resultSeen) this.record.fail('no_result_card', `${step}: no result card explained what the action showed`);
    else if (!command.rings) this.record.fail('result_rings_nothing', `${step}: the result card ringed nothing on the page`);
    for (const problem of command.resultChecks || []) this.record.fail('result_not_on_screen', `${step}: ${problem}`);
    if (command.apps.size > 1 && !command.resultOnDestination) this.record.fail('pivot_result_not_on_destination', `${step}: the step changed pages but its result was not explained on the destination page`);
  }

  async inspect(state) {
    const command = this.current;
    if (state.page?.unableToLoad) this.record.fail('kibana_crashed', `Kibana shows "Unable to load page" at ${state.page.url}`);
    if (!state.present) return;
    // The coach's visible text and where it points, each time the card changes.
    const card = JSON.stringify([state.eyebrow, state.headline, state.detail, state.choices, state.status?.text, Boolean(state.debrief)]);
    if (card !== this.lastCard) {
      this.lastCard = card;
      this.lastChangeAt = Date.now();
      await this.record.event({kind: 'coach', step: command?.message.step_id || null, url: state.page.url, eyebrow: state.eyebrow, headline: state.headline,
        detail: state.detail, choices: state.choices, status: state.status, cursor: state.cursor, spotlight: state.spotlight, rings: state.rings, panel: state.panel});
    }
    if (state.status?.error && state.status.text && !this.expectErrors) this.record.fail('coach_error', `the coach reported an error: ${state.status.text}`);
    if (command) {
      command.apps.add(appOf(state.page.url));
      if (state.cursor) {
        command.cursorSeen = true;
        if (!insideViewport(state.cursor, state.page.viewport)) command.cursorOutside = true;
      }
    }
    // A result card belongs to the step it names: a step that opened another page tells its result there,
    // after the next step's command has already arrived.
    const owner = [...this.commands.values()].reverse().find(item => state.objective && item.message.step_title === state.objective) || command;
    if (owner) {
      const command = owner;
      if (state.stage?.includes('result') && state.buttons.advance?.text === 'Continue') {
        if (!command.resultSeen) {
          command.resultSeen = true;
          command.resultAt = Date.now();
          command.resultApp = appOf(state.page.url);
          command.resultOnDestination = command.apps.size > 1 && command.resultApp === appOf(state.page.url);
        }
        command.rings = Math.max(command.rings, state.rings.length);
        if (Date.now() - command.resultAt > 1200 && !command.resultChecked) {
          command.resultChecked = true;
          command.resultChecks = this.resultProblems(command, state);
          this.checkWording(`result card for ${command.message.step_id}`, `${state.eyebrow}\n${state.headline}\n${state.detail}`);
          await this.record.screenshot(this.page, `result-${command.message.step_id}`);
        }
      }
    }
    this.checkCovering(state);
  }

  // Does Kibana show what the step claims, now that its result card is up?
  resultProblems(command, state) {
    const problems = [];
    const {message, value} = command;
    const url = decodeURIComponent(state.page.url);
    if (state.page.busy) problems.push('the result card was shown while Discover was still searching');
    if (message.type === 'set_time_range' && value?.from && appOf(state.page.url) === 'discover' && !url.includes(value.from)) problems.push(`the window does not start at ${value.from}`);
    if (message.type === 'enter_kql' && typeof value === 'string' && state.page.queryBar !== null && state.page.queryBar.trim() !== value.trim()) problems.push(`the query bar shows ${JSON.stringify(state.page.queryBar)}, not ${JSON.stringify(value)}`);
    if (message.type === 'add_filter' && value?.value !== undefined && !state.page.pills.some(text => text.includes(String(value.value)))) problems.push(`no filter pill for ${value.field}: ${value.value}`);
    if (message.type === 'expand_document' && !state.page.documentOpen) problems.push('no document is open');
    if (message.type === 'sort_column' && value?.field && !url.includes(`'${value.field}',${value.direction || 'asc'}`) && !url.includes(`${value.field},${value.direction || 'asc'}`)) problems.push(`the table is not sorted by ${value.field}`);
    if (['enter_kql', 'add_filter'].includes(message.type) && state.page.noResults) problems.push('the search the step ran shows no results');
    return problems;
  }

  // A result card that is up but not yet read and checked (the drivers wait for it before Continue).
  resultPending() {
    return [...this.commands.values()].some(item => item.resultSeen && !item.resultChecked);
  }

  // The card must stay off the control in use, the rings, a flyout and Kibana's notices.
  checkCovering(state) {
    if (!state.panelVisible || !state.panel || state.briefing || state.debrief) {
      this.covering.clear();
      return;
    }
    const targets = [];
    if (state.spotlight) targets.push(['the highlighted control', state.spotlight]);
    state.rings.forEach((ring, index) => targets.push([`evidence ring ${index + 1}`, ring]));
    state.page.flyouts.forEach((flyout, index) => targets.push([`flyout ${index + 1}`, flyout]));
    state.page.toasts.forEach(toast => targets.push([`the Kibana notice "${toast.text.slice(0, 60)}"`, toast.box]));
    const now = new Map();
    for (const [name, box] of targets) {
      const share = overlapShare(state.panel, box);
      if (share <= COVER_LIMIT) continue;
      const key = `${name}|${JSON.stringify(box)}`;
      const since = this.covering.get(key)?.since ?? Date.now();
      if (Date.now() - since > COVER_GRACE_MS) {
        this.record.fail('card_covers_target', `the coach card covers ${Math.round(share * 100)}% of ${name} (${this.current?.message.step_id || 'no step'}, ${state.eyebrow || 'card'})`);
      }
      now.set(key, {since});
    }
    this.covering = now;
  }

  checkWording(where, text, {packIds = true} = {}) {
    for (const pattern of INTERNAL_TEXT) {
      const match = text.match(pattern);
      if (match) this.record.fail('internal_identifier', `${where} shows an internal identifier: ${match[0]}`);
    }
    if (packIds && this.spec.scenario && new RegExp(`(^|[^\\w-])${this.spec.scenario}([^\\w-]|$)`).test(text)) {
      this.record.fail('internal_identifier', `${where} shows the pack id ${this.spec.scenario}`);
    }
  }

  // ----------------------------------------------------------------------------------------------
  // Acting as the learner (only the coach's own buttons, unless a case says otherwise)

  // A coach that shows nothing new for this long has stalled (sooner once it has reported an error):
  // fail the case now rather than wait out its timeout.
  assertProgress(state) {
    const quiet = Date.now() - (this.lastChangeAt || Date.now());
    const limit = state?.status?.error ? 30000 : 90000;
    if (quiet > limit) throw new Error(`the coach stalled for ${Math.round(quiet / 1000)}s on "${state?.eyebrow || ''} ${state?.headline || ''}"${state?.status?.text ? ` (${state.status.text})` : ''}`);
  }

  coach(selector) { return this.page.locator(`#adaptive-incident-coach ${selector}`); }

  async click(selector, label) {
    const target = this.coach(selector);
    await target.click({timeout: 10000});
    await this.record.event({kind: 'audit_click', control: label || selector});
  }

  async waitFor(predicate, {timeout = 60000, label = 'condition', interval = 400} = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const state = await this.poll();
      if (await predicate(state)) return state;
      await sleep(interval);
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  async beginBriefing() {
    const state = await this.waitFor(current => current.briefing || current.panelVisible, {timeout: 240000, label: 'the incident briefing'});
    if (!state.briefing) {
      this.record.fail('no_briefing', 'the session opened without its incident briefing');
      return state;
    }
    this.checkWording('incident briefing', state.briefing);
    await this.record.screenshot(this.page, 'briefing');
    await this.click('.briefing-begin', 'Begin');
    return state;
  }

  // Judge every step once the case is over (a step's result can come after the next step arrived).
  finish() {
    if (this.finished) return;
    this.finished = true;
    for (const command of this.commands.values()) {
      if (command === this.current && this.interrupted) continue;
      this.finishCommand(command);
    }
    this.current = null;
    for (const failure of this.networkFailures.slice(0, 10)) {
      if (KNOWN_SILENT_FAILURES.some(pattern => pattern.test(failure.url))) this.record.note(`known silent Kibana failure: ${failure.status || failure.failure} ${failure.url.slice(0, 120)}`);
      else this.record.fail('network', `request failed: ${failure.status || failure.failure} ${failure.url.slice(0, 160)}`);
    }
  }
}
