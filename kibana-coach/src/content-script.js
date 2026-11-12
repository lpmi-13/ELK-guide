// Guided step clock. Counts only the time the learner is actually working on a step — it pauses
// while the tab is hidden, the briefing is open, the coach is walking through or recovering, a
// success is showing, or a check-in is already up — and only resets when the step changes. When the
// step's budget (command.pace_seconds, never under 45s) runs out it waits for a quiet moment (5s
// without pointer or key input, no Kibana popover open, the query bar not focused) and then asks for
// a check-in. After "Keep going" the next one comes at 1.5× the budget; after two, none for the step.
class GuidedStepClock {
  /**
   * @param {{isPaused?: () => boolean, isQuiet?: () => boolean, onDue?: (stepId: string) => void, now?: () => number,
   *   setTimer?: (callback: () => void, delay: number) => any, clearTimer?: (id: any) => void, tickMs?: number, idleMs?: number}} [options]
   */
  constructor({isPaused = () => false, isQuiet = () => true, onDue = () => {}, now = () => performance.now(),
    // Wrapped: a browser's setTimeout throws "Illegal invocation" when called as a method of this.
    setTimer = (callback, delay) => setTimeout(callback, delay), clearTimer = id => clearTimeout(id),
    tickMs = 500, idleMs = 5000} = {}) {
    this.isPaused = isPaused;
    this.isQuiet = isQuiet;
    this.onDue = onDue;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.tickMs = tickMs;
    this.idleMs = idleMs;
    this.stepId = null;
    this.timer = null;
    this.active = 0;
  }

  start(stepId, budgetSeconds) {
    this.stop();
    this.stepId = stepId;
    this.budget = Math.max(45, Number(budgetSeconds) || 45) * 1000;
    this.active = 0;
    this.dueAt = this.budget;
    this.declines = 0;
    this.awaiting = false;
    this.lastTick = this.now();
    this.lastInput = this.lastTick;
    this.schedule();
  }

  // Seconds of active time on the current step (one decimal place).
  get seconds() { return Math.round(this.active / 100) / 10; }

  stop() {
    this.clearTimer(this.timer);
    this.timer = null;
    this.stepId = null;
  }

  // Any pointer or key input: the learner is busy, so a due check-in waits.
  input() { this.lastInput = this.now(); }

  schedule() { this.timer = this.setTimer(() => this.tick(), this.tickMs); }

  tick() {
    const now = this.now();
    // A throttled background tab can fire late; never count more than a couple of ticks at once.
    if (!this.isPaused()) this.active += Math.min(now - this.lastTick, 2 * this.tickMs);
    this.lastTick = now;
    if (!this.awaiting && this.dueAt != null && this.active >= this.dueAt && now - this.lastInput >= this.idleMs &&
        !this.isPaused() && this.isQuiet()) {
      this.awaiting = true;
      this.onDue(this.stepId);
    }
    if (this.stepId) this.schedule();
  }

  // "Keep going": back off to 1.5× the budget; after the second, no more check-ins on this step.
  keepGoing() {
    this.awaiting = false;
    this.declines += 1;
    this.dueAt = this.declines >= 2 ? null : this.active + 1.5 * this.budget;
  }

  // A hint or Show me was chosen: allow a fresh budget before checking in again.
  helped() {
    this.awaiting = false;
    if (this.dueAt != null) this.dueAt = this.active + this.budget;
  }

  // The check-in could not be shown just now; try again at the next quiet moment.
  retry() { this.awaiting = false; }
}

/** @type {any} */ (globalThis).GuidedStepClock = GuidedStepClock;

function startIncidentCoach() {
  if (document.querySelector('#adaptive-incident-coach')) return;
  const host = document.createElement('div');
  host.id = 'adaptive-incident-coach';
  host.hidden = true;
  document.documentElement.append(host);
  const coach = new IncidentCoachPanel(host);
  const adapter = new KibanaAdapter();
  let client = null;
  let observer = null;
  let currentCommand = null;
  let executionController = null;
  // Set while a guided "Show me" walkthrough plays. The coach reports its own action once the
  // walkthrough ends, so the observer must not report the coach's changes as the learner's —
  // that would complete the step early and cut off its explanation.
  let walkthroughController = null;
  // Set once the session has its feedback (any mode): no more recovery, check-ins or window watches.
  let investigationFinished = false;
  // Set once this page has shown a debrief: a reconnect's "complete" then leaves it closed.
  let debriefShown = false;
  // Guided dead-end recovery: set while the coach explains and undoes a search that left no results.
  let recoveryController = null;
  // The scope step's "choose again" card, and the watch on a relative window that will slide.
  let windowMiss = null;
  let windowWatch = null;
  let deadEndSince = 0;
  let deadEndPoll = null;
  // The check-in card on screen ({stepId}), and the learner's latest query with its result count so
  // an accepted free-text search can carry a note on its success card.
  let checkIn = null;
  let lastSearch = null;
  // Set once a step that opens another page has reported; that page's coach picks the session up.
  let leavingPage = false;
  const stepClock = new GuidedStepClock({
    isPaused: () => Boolean(document.hidden || coach.paused || coach.briefing?.active || coach.celebrating ||
      walkthroughController || executionController || recoveryController || checkIn),
    isQuiet: () => !coach.findPopovers().length && document.activeElement !== adapter.resolve('kibana.query_bar'),
    onDue: stepId => {
      try { client?.requestCheckIn(stepId); } catch (_error) { stepClock.retry(); }
    },
  });
  for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel']) {
    document.addEventListener(type, () => stepClock.input(), {capture: true, passive: true});
  }
  const activeSessionKey = 'incident-coach:auto-connect';
  // A step that opens another page tells its result there, where what it talks about is on screen.
  const carriedResultKey = 'incident-coach:carried-result';
  let carriedResult = null;
  let heldCommand = null;
  const demonstrationSlowdown = 3;
  const demonstrationTimingScale = 10 * demonstrationSlowdown;
  const completedActionHoldMs = 1000;

  function wordCount(...texts) {
    return texts.filter(Boolean).join(' ').trim().split(/\s+/).filter(Boolean).length;
  }

  function readingPause(...texts) {
    const words = wordCount(...texts);
    if (!words) return 0;
    return Math.min(15000, Math.max(5500, words * 260));
  }

  // A demonstration step opens on one line of intent: long enough to read it and find the
  // highlighted control, short enough that the time goes to the result the step produces.
  function goalPause(text) {
    return Math.min(8000, Math.max(5000, wordCount(text) * 300));
  }

  // The reading pause currently on screen. "Advance" completes it early — the same effect as its
  // countdown bar filling — after which the demonstration carries on at its normal pace. Only one
  // reading beat runs at a time, so a single resolver is enough.
  let completeReadingBeat = null;
  let activeReadingBeat = null;
  // An Advance pressed while the coach is acting waits for the action to finish. Keep its signal
  // scoped to the current action so it cannot affect a later command.
  let advanceAfterAction = null;

  function readingBeatWait(milliseconds, signal) {
    if (signal?.aborted) return Promise.reject(new DOMException('Demonstration stopped', 'AbortError'));
    return new Promise((resolve, reject) => {
      let remaining = milliseconds;
      let startedAt = 0;
      let timer = null;
      const clear = () => {
        clearTimeout(timer);
        timer = null;
        signal?.removeEventListener('abort', abort);
        if (completeReadingBeat === done) completeReadingBeat = null;
        if (activeReadingBeat === beat) activeReadingBeat = null;
      };
      const done = () => { clear(); resolve(); };
      const abort = () => { clear(); reject(new DOMException('Demonstration stopped', 'AbortError')); };
      const beat = {
        get remaining() { return remaining; },
        pause() {
          if (timer === null) return;
          remaining = Math.max(0, remaining - (performance.now() - startedAt));
          clearTimeout(timer);
          timer = null;
        },
        resume() {
          if (timer !== null) return;
          startedAt = performance.now();
          timer = setTimeout(done, remaining);
        },
      };
      activeReadingBeat = beat;
      completeReadingBeat = done;
      signal?.addEventListener('abort', abort, {once: true});
      if (!coach.paused) beat.resume();
    });
  }

  // A step's last beat, demonstrated or shown on request: ring what the action revealed and say what
  // it shows, then wait for the learner — reading the result is where the inference happens, so it is
  // never on a timer.
  // The step is only reported done afterwards, so the next step (or the debrief) can't cover it.
  // Popovers the step opened are closed on the way out so they don't pile up over the next step.
  async function showResult(command, signal) {
    const evidence = await adapter.findEvidence(command, signal);
    if (advanceAfterAction === signal) {
      // An Advance pressed during the action hurried its mechanics, not its result.
      advanceAfterAction = null;
      coach.setAdvancePending(false);
    }
    coach.showResult(command, evidence);
    await coach.waitForAdvance(signal);
    adapter.closeTransientPopovers();
  }

  async function execute(command, explicitlyRequested = false) {
    executionController?.abort();
    const controller = new AbortController();
    executionController = controller;
    try {
      const timingScale = command.mode === 'demonstration' ? demonstrationTimingScale : 1;
      const readBeat = async text => {
        const pause = readingPause(text) * demonstrationSlowdown;
        coach.startCountdown(pause);
        await readingBeatWait(pause, controller.signal);
      };
      const holdAction = command.mode === 'demonstration' ? async () => {
        // Keep the instruction visible after its completed control is no longer highlighted.
        // Use a reading beat so Pause freezes this hold and Advance can finish it early.
        coach.startCountdown(completedActionHoldMs);
        await readingBeatWait(completedActionHoldMs, controller.signal);
      } : null;
      if (command.mode === 'demonstration') {
        // State the step's goal in one line before touching Kibana.
        // The anchor is only the control the opening cards point at; perform() resolves the controls
        // the step actually drives. Some steps (e.g. add_filter) deliberately point at an anchor the
        // registry does not hold, like the filter bar, so a missing anchor must never abort the run —
        // resolveAnchor falls back to no opening highlight and perform() highlights the real controls.
        const target = await adapter.resolveAnchor(command.target, controller.signal, command);
        // A step that starts by reading the page (where the histogram rises) rings that instead of
        // spotlighting the control, which would dim the very thing the line asks the learner to read.
        coach.showCommand(command, command.goal_focus ? null : target);
        if (!command.goal_focus) coach.revealTarget?.(target);
        if (command.goal_focus) coach.showGoalFocus(await adapter.findEvidence({...command, evidence_focus: command.goal_focus}, controller.signal));
        const pause = goalPause(command.narration);
        coach.startCountdown(pause);
        await readingBeatWait(pause, controller.signal);
        // Hand the card over to the live step's action narration.
        coach.beginActionPhase(command);
      }
      // "Show me" starts the guided action immediately. Its explanation follows the action.
      const walkthrough = explicitlyRequested && command.mode === 'guided' && command.walkthrough
        ? {...command, ...command.walkthrough} : null;
      if (walkthrough) {
        walkthroughController = controller;
        coach.beginWalkthrough(walkthrough);
      }
      const action = await adapter.perform(command, coach, {timingScale, signal: controller.signal, readBeat, holdAction});
      const leaving = Boolean(action?.navigate);
      if (command.mode === 'demonstration' && action && !leaving) await showResult(command, controller.signal);
      const learning = walkthrough || command;
      if (leaving && (command.mode === 'demonstration' || learning.evidence)) {
        sessionStorage.setItem(carriedResultKey, JSON.stringify(learning));
      } else if (walkthrough && learning.evidence) {
        // Guided "Show me" ends on the same result card as a demonstration, with the reasoning its
        // immediate start skipped.
        await showResult(learning, controller.signal);
      }
      coach.finishCommand(command);
      client.acknowledge(command, 'completed', action?.state_after || {});
      if (explicitlyRequested) client.sendAction({type: 'step_demonstrated', details: {step_id: command.step_id}}, 'learner');
      if (action) client.sendAction(action, 'tutorial');
      // A step that opens another page (Explore in Discover) reports before it goes, and ignores the
      // next step meanwhile: the service sends it again when the coach reconnects on that page.
      if (action?.navigate) {
        leavingPage = true;
        setTimeout(() => location.assign(action.navigate), 400);
      }
    } catch (error) {
      if (error.name === 'AbortError') return;
      coach.toast(error.message, true);
      client.acknowledge(command, 'failed', {error: error.message});
    } finally {
      if (advanceAfterAction === controller.signal) advanceAfterAction = null;
      if (executionController === controller) {
        coach.setAdvancePending(false);
        executionController = null;
      }
      if (walkthroughController === controller) walkthroughController = null;
    }
  }

  // The step reported from the previous page and opened this one: say what it shows now that it's on
  // screen, before moving on. The service's next command waits for the learner, as it would on one page.
  async function playCarriedResult() {
    const command = carriedResult;
    const controller = new AbortController();
    executionController = controller;
    const guided = command.mode === 'guided';
    if (guided) walkthroughController = controller;
    currentCommand = command;
    try {
      coach.showCommand(command, null);
      if (guided) coach.beginWalkthrough(command);
      coach.showTarget(null, 'Opening the page this step leads to…');
      await showResult(command, controller.signal);
      coach.finishCommand(command);
    } catch (error) {
      if (error.name === 'AbortError') return;
      coach.toast(error.message, true);
    } finally {
      carriedResult = null;
      sessionStorage.removeItem(carriedResultKey);
      if (executionController === controller) {
        coach.setAdvancePending(false);
        executionController = null;
      }
      if (walkthroughController === controller) walkthroughController = null;
    }
    const next = heldCommand;
    heldCommand = null;
    if (next) client.onCommand(next);
  }

  function recoveryEligible(command = currentCommand) {
    return client?.mode === 'guided' && !investigationFinished && !recoveryController &&
      !executionController && !adapter.performing && command?.mode === 'guided' && Boolean(command.restore_state) &&
      !coach.briefing.active;
  }

  // A guided learner can type or filter their way into an empty view ("No results match your search
  // criteria") — e.g. `status_code is 503`, which KQL reads as free text. Nothing on screen can move
  // the investigation forward from there, so once that state persists the coach says what caused it,
  // undoes it, and re-applies the search the completed steps had established (restore_state). If the
  // learner fixes it themselves first, the coach steps aside.
  function checkDeadEnd() {
    if (!recoveryEligible() || !KibanaActionObserver.noResultsShown()) {
      deadEndSince = 0;
      return;
    }
    deadEndSince ||= Date.now();
    if (Date.now() - deadEndSince < 1500) return;
    deadEndSince = 0;
    recoverFromDeadEnd(currentCommand);
  }

  function listText(items) {
    return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  }

  function minutesText(minutes) {
    if (minutes == null) return 'a moment';
    if (minutes < 1) return `${Math.round(minutes * 60)} seconds`;
    const rounded = Math.round(minutes);
    return `${rounded} minute${rounded === 1 ? '' : 's'}`;
  }

  // A moment as Discover's times read it: 24-hour local time ("14:03").
  function clockText(moment) {
    const pad = number => String(number).padStart(2, '0');
    return `${pad(moment.getHours())}:${pad(moment.getMinutes())}`;
  }

  // The earned filter is still in force: as an enabled pill, or named with its value in the query.
  function holdsFilter(filter) {
    const pill = observer.readFilterPills().some(item => !item.disabled && item.field === filter.field &&
      String(item.value) === String(filter.value) && Boolean(item.negate) === Boolean(filter.negate));
    const query = (adapter.resolve('kibana.query_bar')?.value || '').replace(/\s+/g, '').toLowerCase();
    return pill || (!filter.negate && query.includes(String(filter.field).toLowerCase()) &&
      query.includes(String(filter.value).replace(/\s+/g, '').toLowerCase()));
  }

  function describeEmptySearch(state) {
    const query = (adapter.resolve('kibana.query_bar')?.value || '').trim();
    const expected = state.filters || [];
    const stray = observer.readFilterPills().filter(pill => !expected.some(filter =>
      filter.field === pill.field && String(filter.value) === String(pill.value) && Boolean(filter.negate) === pill.negate));
    const causes = [];
    if (query && query !== (state.query || '').trim()) causes.push(`The query “${query}”`);
    for (const pill of stray) causes.push(`${causes.length ? 'the' : 'The'} filter ${pill.negate ? 'NOT ' : ''}${pill.field}: ${pill.value}`);
    const cause = causes.length ? listText(causes) : 'The current search';
    return {
      headline: `${cause} left no matching results, so there’s nothing here to investigate.`,
      detail: 'I’ll clear it and put the search back to where this step starts. Or fix it yourself — I’ll step aside as soon as results come back.',
    };
  }

  async function searchIsEmpty() {
    // A URL-driven restore can take over a second to start Discover's refetch; allow for it so the
    // stale "No results" prompt isn't read as the outcome.
    const count = await observer.resultCount(8000, 2500);
    return count === 0 || (count == null && KibanaActionObserver.noResultsShown());
  }

  // What went wrong, how to tell the learner has fixed it, and how the coach puts it right.
  // `reason` is the service's dead_end evaluation, or null when the browser saw "No results" itself.
  /**
   * @typedef {{eyebrow: string, headline: string, detail: string, stillBroken: () => boolean,
   *   restore: (signal?: AbortSignal) => Promise<boolean>, working?: string, restoredToast?: string, diagnosis?: any}} DeadEndProblem
   * @param {import('../protocol/protocol').RestoreState} state
   * @param {import('../protocol/protocol').DeadEndEvaluation | null} reason
   * @returns {Promise<DeadEndProblem>}
   */
  async function describeDeadEnd(state, reason) {
    if (reason?.reason_code === 'lost_earned_state') {
      const lost = reason.lost || [];
      const names = lost.map(filter => `${filter.negate ? 'NOT ' : ''}${filter.field}: ${filter.value}`);
      return {
        eyebrow: 'Earned filter removed — back on track',
        headline: `Without ${listText(names) || 'that filter'}, the view no longer holds what an earlier step established, so this step can’t be answered from here.`,
        detail: 'I’ll put it back and keep the rest of your search. Or add it again yourself — I’ll step aside.',
        stillBroken: () => lost.some(filter => !holdsFilter(filter)),
        restore: async () => adapter.restoreDiscoverState(state, {merge: true}),
      };
    }
    if (reason?.reason_code === 'window_excludes_incident' || reason?.reason_code === 'window_slid_past_incident') {
      const code = reason.reason_code;
      // The service compares the window's start with the incident's moment in absolute time, and words
      // the card in the learner's clock time.
      const moment = new Date(reason.incident_reference_at);
      const start = new Date(reason.window_start_at);
      const known = !Number.isNaN(moment.getTime()) && !Number.isNaN(start.getTime());
      const time = reason.restore_time || state?.time;
      return {
        eyebrow: code === 'window_slid_past_incident' ? 'Window moved on — back on track' : 'Incident outside the window — back on track',
        headline: reason.headline || (known
          ? `The window now starts at ${clockText(start)}, after the incident at ${clockText(moment)}, so part of it is outside the view.`
          : `The window now starts ${minutesText(reason.from_minutes)} ago, after the incident ${minutesText(reason.incident_offset_minutes)} ago, so part of it is outside the view.`),
        detail: reason.detail || 'I’ll put the window back. Or widen it yourself — I’ll step aside.',
        working: 'Typing a fixed start into the date box, so the window stays put…',
        restoredToast: 'Window restored — carry on with this step.',
        stillBroken: () => {
          const range = observer.readTimeRange();
          const minutes = observer.timeRangeMinutes(range.from, range.to);
          return known && minutes != null && Date.now() - minutes * 60_000 > moment.getTime() + 60_000;
        },
        // Typed into the date box as Show me does, so it works on a dashboard too, and the learner
        // sees how to set a fixed start.
        restore: async signal => {
          if (!time?.from) return false;
          await adapter.perform({type: 'set_time_range', target: 'kibana.time_picker', value: {from: time.from, to: time.to || 'now'}}, coach, {signal});
          return true;
        },
      };
    }
    const problem = {
      ...describeEmptySearch(state),
      eyebrow: 'No results — back on track',
      diagnosis: null,
      stillBroken: () => KibanaActionObserver.noResultsShown(),
      restore: async () => {
        if (!adapter.restoreDiscoverState(state)) throw new Error('The search could not be restored automatically. Clear the query and filters to continue.');
        // Query and filters first; reset the window too only if that alone doesn't bring results back.
        if (await searchIsEmpty()) {
          adapter.restoreDiscoverState(state, {includeTime: true});
          if (await searchIsEmpty()) throw new Error('The search is still empty after restoring it. Try widening the time range.');
        }
        return true;
      },
    };
    const query = (adapter.resolve('kibana.query_bar')?.value || '').trim();
    if (query && query !== (state.query || '').trim()) {
      const diagnosis = QueryExplainer.explain(query, await adapter.loadFieldNames(), {resultCount: 0});
      if (diagnosis && diagnosis.kind !== 'free_text_luck') {
        problem.diagnosis = diagnosis;
        problem.eyebrow = 'No results — here’s why';
        problem.headline = diagnosis.message;
        problem.detail = diagnosis.fix
          ? 'Fix my query puts the corrected query in the search bar for you to run. Or reset the search to where this step starts.'
          : diagnosis.kind === 'value_absent'
            ? 'Show top values opens the field so you can pick a value that is really there. Or reset the search to where this step starts.'
            : 'Correct the query, or reset the search to where this step starts.';
      }
    }
    return problem;
  }

  // Put the corrected query in the search bar without running it: the learner presses Enter.
  function fillQuery(text) {
    const input = adapter.resolve('kibana.query_bar');
    if (!input) return false;
    adapter.setNativeValue(input, text, {commit: false});
    input.focus();
    input.setSelectionRange?.(text.length, text.length);
    return true;
  }

  function openFieldValues(field) {
    const escaped = String(field).replace(/['\\]/g, '\\$&');
    const button = document.querySelector(`[data-test-subj='field-${escaped}-showDetails']`);
    if (!button) {
      coach.toast(`Open ${field} in the field list to see its top values.`);
      return;
    }
    // The coach opening the popover is not the learner's action.
    adapter.performing = true;
    try { /** @type {HTMLElement} */ (button).click(); } finally { adapter.performing = false; }
  }

  // A diagnosed query: wait for Fix my query / Show top values / Reset search. Resolves when the
  // learner asks for the reset; rejects (AbortError) when they fix it themselves.
  function awaitRecoveryChoice(problem, signal) {
    return new Promise((resolve, reject) => {
      const {diagnosis} = problem;
      const reset = {id: 'reset', label: 'Reset search', onSelect: () => resolve()};
      const render = (detail, choices) => coach.showRecovery({eyebrow: problem.eyebrow, headline: problem.headline, detail, choices});
      const choices = [];
      if (diagnosis.fix) {
        choices.push({id: 'fix', label: 'Fix my query', primary: true, onSelect: () => {
          if (fillQuery(diagnosis.fix)) render(`The corrected query is in the search bar: ${diagnosis.fix}\n\nPress Enter to run it.`, [reset]);
        }});
      }
      if (diagnosis.kind === 'value_absent') {
        choices.push({id: 'values', label: 'Show top values', primary: true, onSelect: () => openFieldValues(diagnosis.field)});
      }
      render(problem.detail, [...choices, reset]);
      signal.addEventListener('abort', () => reject(new DOMException('Recovery stepped aside', 'AbortError')), {once: true});
    });
  }

  async function recoverFromDeadEnd(command, reason = null) {
    const controller = new AbortController();
    recoveryController = controller;
    checkIn = null;
    const state = command.restore_state;
    let watch = null;
    let restored = false;
    let problem = null;
    try {
      problem = await describeDeadEnd(state, reason);
      try { client.reportRecovery(command.step_id, reason?.reason_code || 'empty_result', problem.diagnosis?.kind); } catch (_error) { /* offline */ }
      // The learner fixing it themselves during the explanation cancels the restore.
      watch = setInterval(() => {
        if (!problem.stillBroken()) controller.abort();
      }, 400);
      if (problem.diagnosis) {
        await awaitRecoveryChoice(problem, controller.signal);
      } else {
        coach.showRecovery(problem);
        const pause = readingPause(problem.headline, problem.detail);
        coach.startCountdown(pause);
        await readingBeatWait(pause, controller.signal);
      }
      clearInterval(watch);
      coach.showRecoveryWorking(problem.working);
      // Mute the observer: the coach's own restore must not be reported as the learner's action.
      adapter.performing = true;
      restored = await problem.restore(controller.signal);
    } catch (error) {
      if (error.name !== 'AbortError') coach.toast(error.message, true);
    } finally {
      clearInterval(watch);
      adapter.performing = false;
      observer?.rebaseline();
      if (recoveryController === controller) recoveryController = null;
      if (currentCommand && client) {
        coach.showCommand(currentCommand, adapter.resolve(currentCommand.target));
        if (restored) coach.toast(problem?.restoredToast || 'Search restored — carry on with this step.');
      }
    }
  }

  // On the scope step, a window that doesn't reach the incident (often a relative one picked from a
  // briefing read minutes ago): say so at once in the learner's clock time, and let them choose again.
  // Nothing is put back; any new window, or Choose again, closes the card.
  function explainWindowMiss(command, reason) {
    dismissWindowMiss();
    const controller = new AbortController();
    windowMiss = controller;
    recoveryController = controller;
    checkIn = null;
    try { client.reportRecovery(command.step_id, reason.reason_code); } catch (_error) { /* offline */ }
    coach.showRecovery({
      eyebrow: 'Outside the window — choose again',
      headline: reason.headline || 'That window doesn’t reach back to the incident.',
      detail: reason.detail || 'Choose a window that starts earlier.',
      choices: [{id: 'retry', label: 'Choose again', primary: true, onSelect: () => {
        dismissWindowMiss();
        if (currentCommand) coach.showCommand(currentCommand, adapter.resolve(currentCommand.target));
      }}],
    });
  }

  function dismissWindowMiss() {
    if (!windowMiss) return;
    const controller = windowMiss;
    windowMiss = null;
    if (recoveryController === controller) recoveryController = null;
    controller.abort();
  }

  // A relative window that reaches the incident now will slide past it: the service says when. Then
  // ask it to confirm (it records the dead end), unless the window has changed in the meantime.
  function watchWindow(watch) {
    clearTimeout(windowWatch?.timer);
    windowWatch = null;
    const at = watch ? new Date(watch.slides_at).getTime() : Number.NaN;
    // Beyond a day the session is long over (and setTimeout's range ends at about 24 days).
    if (client?.mode !== 'guided' || Number.isNaN(at) || at - Date.now() > 86_400_000) return;
    const entry = {from: watch.from, timer: null};
    const check = () => {
      if (windowWatch !== entry || investigationFinished) return;
      // The coach's own restore changes the window without a report; that ends the watch too.
      if (observer?.readTimeRange().from !== entry.from) {
        windowWatch = null;
        return;
      }
      if (!recoveryEligible()) {
        entry.timer = setTimeout(check, 2000);
        return;
      }
      windowWatch = null;
      try { client.checkWindow(); } catch (_error) { /* offline: the next action is checked anyway */ }
    };
    // A moment's margin so the service, judging on its own clock, agrees it has slid.
    entry.timer = setTimeout(check, Math.max(0, at - Date.now()) + 1500);
    windowWatch = entry;
  }

  // The step clock ran out: a soft card with the step, the latest drift the service noticed, and
  // Keep going / Give me a hint / Show me. Answering it costs nothing.
  function showCheckIn(message) {
    if (!currentCommand || message.step_id !== currentCommand.step_id || message.step_id !== stepClock.stepId ||
        recoveryController || executionController || coach.celebrating || investigationFinished) {
      stepClock.retry();
      return;
    }
    checkIn = {stepId: message.step_id};
    const answer = choice => {
      if (checkIn?.stepId !== message.step_id) return;
      checkIn = null;
      client.sendAction({type: 'check_in_answered', details: {step_id: message.step_id, choice}}, 'learner');
      if (choice === 'keep_going') stepClock.keepGoing(); else stepClock.helped();
      coach.showCommand(currentCommand, adapter.resolve(currentCommand.target));
      if (choice === 'hint') coach.revealHint();
      if (choice === 'show_me') coach.onDemonstrate?.();
    };
    const drift = message.drift || [];
    coach.showCheckIn({
      title: message.step_title || currentCommand.step_title || currentCommand.step_id.replaceAll('-', ' '),
      drift: drift[drift.length - 1] || '',
      choices: [
        {id: 'keep_going', label: 'Keep going', primary: true, onSelect: () => answer('keep_going')},
        {id: 'hint', label: 'Give me a hint', onSelect: () => answer('hint')},
        {id: 'show_me', label: 'Show me', onSelect: () => answer('show_me')},
      ],
    });
  }

  async function finishDemonstration(command) {
    const summary = command.value;
    try {
      await client.submitDiagnosis({
        ...(summary.answer || summary.diagnosis),
        evidence: summary.evidence,
      });
      investigationFinished = true;
      debriefShown = true;
      coach.showCompletion('demonstration');
      coach.debrief.showDemonstration(summary);
    } catch (error) {
      coach.toast(error.message, true);
    }
  }

  // The debrief for any mode: a demonstration's summary, or the scored (or guided) feedback.
  /** @param {import('../protocol/protocol').Feedback} feedback */
  function showFeedback(feedback) {
    if ('demonstration_summary' in feedback && feedback.demonstration_summary) coach.debrief.showDemonstration(feedback.demonstration_summary);
    else coach.debrief.show(feedback);
  }

  const SESSION_ENDED_DETAIL = {
    aborted: 'Start a new run from the launcher. The same scenario key replays the same incident.',
    failed: 'Start it again from the launcher, or choose another scenario.',
    timeout: 'Start it again from the launcher, or choose another scenario.',
    missing: 'The learning service no longer has this session (it may have restarted). Start again from the launcher.',
  };

  async function startSession(config) {
    client?.stop();
    observer?.stop();
    investigationFinished = false;
    debriefShown = false;
    dismissWindowMiss();
    clearTimeout(windowWatch?.timer);
    windowWatch = null;
    try { carriedResult = JSON.parse(sessionStorage.getItem(carriedResultKey) || 'null'); } catch (_error) { carriedResult = null; }
    await adapter.initialize();
    client = new IncidentSessionClient(config);
    client.stepClock = () => stepClock.stepId ? {step_id: stepClock.stepId, seconds_active: stepClock.seconds} : null;
    client.currentView = () => {
      try {
        const view = adapter.currentView();
        // A dashboard keeps its filter pills out of the URL (verified 9.5.2), so read them off the page.
        if (view?.app === 'dashboards' && observer) view.filters = [...view.filters, ...observer.readFilterPills().filter(pill => !pill.disabled)];
        return view;
      } catch (_error) { return null; }
    };
    client.onCheckIn = showCheckIn;
    client.onStatus = (message, retry) => coach.toast(message, false, retry ? {label: 'Retry now', onSelect: retry} : null);
    client.onError = message => coach.toast(message, true);
    // The session is finished: after the last guided step, or on reconnecting (a reload) once any mode has
    // its feedback. The debrief opens once per page; Review feedback brings it back after it is closed.
    client.onComplete = async () => {
      if (debriefShown) return;
      investigationFinished = true;
      debriefShown = true;
      stepClock.stop();
      checkIn = null;
      try {
        const feedback = await client.getFeedback();
        observer?.stop();
        coach.showCompletion(client.mode);
        showFeedback(feedback);
      } catch (error) {
        investigationFinished = false;
        debriefShown = false;
        coach.toast(error.message, true);
      }
    };
    // The run can't be investigated any more (it was stopped, replaced or never became ready), or the
    // service no longer knows the session: stop everything and offer the way back to the launcher.
    client.onFailed = message => {
      executionController?.abort();
      recoveryController?.abort();
      dismissWindowMiss();
      stepClock.stop();
      checkIn = null;
      currentCommand = null;
      clearTimeout(deadEndPoll);
      observer?.stop();
      sessionStorage.removeItem(activeSessionKey);
      sessionStorage.removeItem(carriedResultKey);
      window.__coachBootOverlay?.release();
      coach.showSessionEnded({headline: message.error, detail: SESSION_ENDED_DETAIL[message.reason], launcherUrl: message.launcher_url});
    };
    client.onHint = hint => coach.showHint(hint);
    client.onWindowSlid = message => {
      if (message.evaluation && recoveryEligible()) recoverFromDeadEnd(currentCommand, message.evaluation);
    };
    client.onActionResult = result => {
      const {evaluation} = result;
      // A new window replaces the one a "choose again" card was about, and any watch on the old one.
      if (result.action?.type === 'time_range_changed') {
        dismissWindowMiss();
        watchWindow(result.window_watch);
      }
      // The service found the learner's change left the step unanswerable. An empty search starts
      // recovering without waiting out the usual grace period; a lost filter or a window that misses
      // the incident still shows results, so recover from it directly. On the scope step itself, a
      // window that misses is explained and the learner chooses again.
      if (client.mode === 'guided' && evaluation.outcome === 'dead_end') {
        const code = evaluation.reason_code;
        if (code === 'empty_result') deadEndSince = 1;
        else if (code === 'window_misses_incident') { if (recoveryEligible()) explainWindowMiss(currentCommand, evaluation); }
        else if (recoveryEligible()) recoverFromDeadEnd(currentCommand, evaluation);
      }
      if (evaluation.outcome === 'accepted') {
        dismissWindowMiss();
        const reason = String(evaluation.reason || '').replace(/^Completed:\s*/i, '').trim();
        // A bare value that happened to find the right documents still earns the step, with a note.
        let note = '';
        if (lastSearch && result.action?.sequence === lastSearch.sequence && lastSearch.count > 0) {
          const explained = QueryExplainer.explain(lastSearch.query, adapter.fieldNames(), {resultCount: lastSearch.count});
          if (explained?.kind === 'free_text_luck') note = explained.message;
        }
        coach.celebrate(reason || 'This step revealed useful evidence.', note);
      }
    };
    client.onBriefing = async briefing => {
      // Hold the boot overlay behind the briefing, then reveal the now-loaded
      // Kibana once the learner dismisses it — never a bare frame in between.
      window.__coachBootOverlay?.hold();
      await coach.showBriefing(briefing);
      window.__coachBootOverlay?.release();
      client.acknowledgeBriefing(briefing);
    };
    client.onCommand = async command => {
      if (leavingPage) return;
      // Safety net: reveal Kibana here too, for any flow that reaches a command
      // without first showing a briefing.
      window.__coachBootOverlay?.release();
      // A step's result carried over from the previous page plays first; whichever command the service
      // sends meanwhile (it resends on reconnect) runs when the learner has read it.
      if (carriedResult) {
        const started = heldCommand !== null;
        heldCommand = command;
        if (!started) playCarriedResult();
        return;
      }
      // Resume re-sends the pending command. Its reading beat is already running (or paused), so
      // leave that execution and its countdown in place instead of starting the step over.
      // The same holds for a guided "Show me" walkthrough that is still playing.
      if (executionController && !executionController.signal.aborted &&
          currentCommand?.command_id === command.command_id) return;
      // A reconnect re-sends the command on screen. An answer form that is already up keeps what the
      // learner has typed into it.
      if (['request_answer', 'request_diagnosis'].includes(command.type) && command.mode !== 'demonstration' &&
          currentCommand?.command_id === command.command_id) return;
      // A new guided step means the one being walked through is already complete (e.g. the learner's
      // own action satisfied it), so stop explaining it rather than narrate over the next step.
      if (command.mode === 'guided') executionController?.abort();
      currentCommand = command;
      // The clock times a step, so a re-sent command for the same step keeps counting.
      checkIn = null;
      if (command.mode === 'guided' && 'pace_seconds' in command && command.pace_seconds) {
        if (stepClock.stepId !== command.step_id) stepClock.start(command.step_id, command.pace_seconds);
      } else {
        stepClock.stop();
      }
      if (command.mode === 'demonstration' && command.type === 'show_debrief') {
        finishDemonstration(command);
        return;
      }
      if (command.mode === 'demonstration') {
        execute(command);
        return;
      }
      const target = adapter.resolve(command.target);
      // Guided cards should appear as soon as the command arrives. Some reference actions use an
      // anchor that is deliberately absent from the selector registry (for example filter_bar),
      // and waiting for it here leaves the previous success card on screen for 20 seconds.
      coach.showCommand(command, target);
      if (!target && adapter.registry?.targets?.[command.target]) {
        adapter.waitFor(command.target, 20000).then(found => {
          if (currentCommand === command) coach.updateCommandTarget(command, found);
        }).catch(() => {});
      }
    };
    await client.connect();
    observer = new KibanaActionObserver(adapter, action => {
      if (walkthroughController) return;
      // A demonstration is the coach's own route. What the page does by itself meanwhile (APM opening a
      // trace sample as a transaction group loads) is not the learner's action.
      if (client.mode === 'demonstration' && action.type === 'trace_sample_selected') return;
      // A demonstration step reports its own action once its result beat ends. The observer must not
      // report the coach's change first (e.g. the window it just set), or the next step would start
      // over the result the learner is still reading.
      if (executionController && currentCommand?.mode === 'demonstration') return;
      client.sendAction(action, 'learner');
      if (action.type === 'query_submitted') {
        lastSearch = {sequence: client.sequence, query: action.details?.query || '', count: action.state_after?.result_count};
      }
    });
    observer.start();
    clearTimeout(deadEndPoll);
    const pollDeadEnd = () => {
      checkDeadEnd();
      deadEndPoll = setTimeout(pollDeadEnd, 500);
    };
    deadEndPoll = setTimeout(pollDeadEnd, 500);
    coach.onPause = paused => {
      if (paused) {
        if (activeReadingBeat) activeReadingBeat.pause();
        else executionController?.abort();
        coach.stopCountdown();
      } else if (activeReadingBeat) {
        coach.resumeCountdown(activeReadingBeat.remaining);
        activeReadingBeat.resume();
      }
      client.setPaused(paused);
    };
    coach.onHint = () => client.requestHint();
    coach.onReviewFeedback = async () => {
      try { showFeedback(await client.getFeedback()); }
      catch (error) { coach.toast(error.message, true); }
    };
    coach.onDemonstrate = () => currentCommand && execute(currentCommand, true);
    coach.onAdvance = () => {
      if (!currentCommand) return;
      if (coach.advanceCelebration()) return;
      if (currentCommand.mode === 'demonstration' && coach.paused) {
        // Nothing is counting down while paused — resume so the demonstration plays on.
        coach.setPaused(false);
        return;
      }
      // A queued click owns this action until it finishes. Further clicks must not shorten each
      // internal hold and outrun the Kibana controls that are still updating.
      if (advanceAfterAction === executionController?.signal) return;
      if (coach.phase === 'action' && executionController && !executionController.signal.aborted) {
        advanceAfterAction = executionController.signal;
        coach.setAdvancePending(true);
        adapter.advanceTyping();
        return;
      }
      if (coach.advanceInfo()) return;
      if (adapter.advanceTyping()) return;
      // Complete the reading pause on screen now, exactly as if its countdown bar had filled. The
      // demonstration then continues at its normal pace — the action still runs and updates Kibana,
      // and the following beats and steps are unchanged. Outside a reading pause this is a no-op.
      completeReadingBeat?.();
    };
    coach.onStop = () => {
      executionController?.abort();
      currentCommand = null;
      stepClock.stop();
      checkIn = null;
      recoveryController?.abort();
      clearTimeout(deadEndPoll);
      observer.stop();
      client.forget();
      sessionStorage.removeItem(activeSessionKey);
      sessionStorage.removeItem(carriedResultKey);
      carriedResult = null;
      heldCommand = null;
      coach.stop();
    };
    coach.onDiagnosis = async answer => {
      try {
        // Discover shows local time, so a window stated as clock times is graded in the learner's zone.
        const feedback = await client.submitDiagnosis({...answer, client_utc_offset_minutes: new Date().getTimezoneOffset()});
        investigationFinished = true;
        debriefShown = true;
        coach.showCompletion('challenge');
        coach.debrief.show(feedback);
      } catch (error) { coach.toast(error.message, true); }
    };
  }

  const savedConfig = sessionStorage.getItem(activeSessionKey);
  if (savedConfig) {
    startSession(JSON.parse(savedConfig)).catch(error => {
      window.__coachBootOverlay?.release();
      host.hidden = false;
      coach.toast(`Automatic connection failed: ${error.message}`, true);
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startIncidentCoach, {once: true});
} else {
  startIncidentCoach();
}
