// Guided step clock. Counts only the time the learner is actually working on a step — it pauses
// while the tab is hidden, the briefing is open, the coach is walking through or recovering, a
// success is showing, or a check-in is already up — and only resets when the step changes. When the
// step's budget (command.pace_seconds, never under 45s) runs out it waits for a quiet moment (5s
// without pointer or key input, no Kibana popover open, the query bar not focused) and then asks for
// a check-in. After "Keep going" the next one comes at 1.5× the budget; after two, none for the step.
class GuidedStepClock {
  constructor({isPaused = () => false, isQuiet = () => true, onDue = () => {}, now = () => performance.now(),
    // Wrapped: a browser's setTimeout throws "Illegal invocation" when called as a method of this.
    setTimer = (callback, delay) => setTimeout(callback, delay), clearTimer = id => clearTimeout(id),
    tickMs = 500, idleMs = 5000} = {}) {
    Object.assign(this, {isPaused, isQuiet, onDue, now, setTimer, clearTimer, tickMs, idleMs});
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

globalThis.GuidedStepClock = GuidedStepClock;

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
  // that would complete the step early and cut off the "What we learned" beat.
  let walkthroughController = null;
  let guidedFeedbackShown = false;
  // Guided dead-end recovery: set while the coach explains and undoes a search that left no results.
  let recoveryController = null;
  let deadEndSince = 0;
  let deadEndPoll = null;
  // The check-in card on screen ({stepId}), and the learner's latest query with its result count so
  // an accepted free-text search can carry a note on its success card.
  let checkIn = null;
  let lastSearch = null;
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
  const demonstrationSlowdown = 3;
  const demonstrationTimingScale = 10 * demonstrationSlowdown;

  function readingPause(...texts) {
    const words = texts.filter(Boolean).join(' ').trim().split(/\s+/).filter(Boolean).length;
    if (!words) return 0;
    return Math.min(15000, Math.max(5500, words * 260));
  }

  // The reading pause currently on screen. "Advance" completes it early — the same effect as its
  // countdown bar filling — after which the demonstration carries on at its normal pace. Only one
  // reading beat runs at a time, so a single resolver is enough.
  let completeReadingBeat = null;
  let activeReadingBeat = null;

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
      if (command.mode === 'demonstration') {
        // Start with the next move; show a separate why card only when it adds new guidance.
        // The anchor is only the control the opening cards point at; perform() resolves the controls
        // the step actually drives. Some steps (e.g. add_filter) deliberately point at an anchor the
        // registry does not hold, like the filter bar, so a missing anchor must never abort the run —
        // resolveAnchor falls back to no opening highlight and perform() highlights the real controls.
        const target = await adapter.resolveAnchor(command.target, controller.signal);
        coach.showCommand(command, target);
        await readBeat(command.narration);
        if (command.reasoning) {
          coach.showWhy(command);
          await readBeat(command.reasoning);
        }
        // Beat 3 — action: hand the card over to the live step's narration.
        coach.beginActionPhase(command);
      }
      // "Show me" starts the guided action immediately. Its explanation follows the action.
      const walkthrough = explicitlyRequested && command.mode === 'guided' && command.walkthrough
        ? {...command, ...command.walkthrough} : null;
      if (walkthrough) {
        walkthroughController = controller;
        coach.beginWalkthrough(walkthrough);
      }
      const action = await adapter.perform(command, coach, {timingScale, signal: controller.signal, readBeat});
      const learning = walkthrough
        ? {...walkthrough, evidence: [walkthrough.reasoning, walkthrough.evidence].filter(Boolean).join('\n\n')}
        : command;
      if (command.mode === 'demonstration' || learning.evidence) {
        // Beat 4 — learning: summarise what the result showed before moving on.
        coach.showLearning(learning);
        await readBeat(learning.evidence);
      }
      coach.finishCommand(command);
      client.acknowledge(command, 'completed', action?.state_after || {});
      if (explicitlyRequested) client.sendAction({type: 'step_demonstrated', details: {step_id: command.step_id}}, 'learner');
      if (action) client.sendAction(action, 'tutorial');
    } catch (error) {
      if (error.name === 'AbortError') return;
      coach.toast(error.message, true);
      client.acknowledge(command, 'failed', {error: error.message});
    } finally {
      if (executionController === controller) executionController = null;
      if (walkthroughController === controller) walkthroughController = null;
    }
  }

  function recoveryEligible(command = currentCommand) {
    return client?.mode === 'guided' && !guidedFeedbackShown && !recoveryController &&
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
  async function describeDeadEnd(state, reason) {
    const code = reason?.reason_code || 'empty_result';
    if (code === 'lost_earned_state') {
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
    if (code === 'window_excludes_incident') {
      const offset = reason.incident_offset_minutes ?? coach.currentBriefing?.detected_offset_minutes;
      return {
        eyebrow: 'Incident outside the window — back on track',
        headline: `The window now starts ${minutesText(reason.from_minutes)} ago, but the incident was noticed ${minutesText(offset)} ago, so it’s outside the view.`,
        detail: 'I’ll put back the window you set earlier. Or widen it yourself — I’ll step aside.',
        stillBroken: () => {
          const range = observer.readTimeRange();
          const minutes = observer.timeRangeMinutes(range.from, range.to);
          return minutes != null && offset != null && minutes + 1 < offset;
        },
        restore: async () => adapter.restoreDiscoverState(state, {timeOnly: true}),
      };
    }
    const problem = {
      ...describeEmptySearch(state),
      eyebrow: 'No results — back on track',
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
    try { button.click(); } finally { adapter.performing = false; }
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
    try {
      const problem = await describeDeadEnd(state, reason);
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
      coach.showRecoveryWorking();
      // Mute the observer: the coach's own restore must not be reported as the learner's action.
      adapter.performing = true;
      restored = await problem.restore();
    } catch (error) {
      if (error.name !== 'AbortError') coach.toast(error.message, true);
    } finally {
      clearInterval(watch);
      adapter.performing = false;
      observer?.rebaseline();
      if (recoveryController === controller) recoveryController = null;
      if (currentCommand && client) {
        coach.showCommand(currentCommand, adapter.resolve(currentCommand.target));
        if (restored) coach.toast('Search restored — carry on with this step.');
      }
    }
  }

  // The step clock ran out: a soft card with the step, the latest drift the service noticed, and
  // Keep going / Give me a hint / Show me. Answering it costs nothing.
  function showCheckIn(message) {
    if (!currentCommand || message.step_id !== currentCommand.step_id || message.step_id !== stepClock.stepId ||
        recoveryController || executionController || coach.celebrating || guidedFeedbackShown) {
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
      title: message.step_title || currentCommand.step_id.replaceAll('-', ' '),
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
      coach.debrief.showDemonstration(summary);
    } catch (error) {
      coach.toast(error.message, true);
    }
  }

  async function startSession(config) {
    client?.stop();
    observer?.stop();
    guidedFeedbackShown = false;
    await adapter.initialize();
    client = new IncidentSessionClient(config);
    client.stepClock = () => stepClock.stepId ? {step_id: stepClock.stepId, seconds_active: stepClock.seconds} : null;
    client.onCheckIn = showCheckIn;
    client.onStatus = message => coach.toast(message);
    client.onError = message => coach.toast(message, true);
    client.onComplete = async () => {
      if (client.mode !== 'guided' || guidedFeedbackShown) return;
      guidedFeedbackShown = true;
      stepClock.stop();
      checkIn = null;
      try {
        const feedback = await client.getFeedback();
        observer?.stop();
        coach.showGuidedCompletion();
        coach.debrief.show(feedback);
      } catch (error) {
        guidedFeedbackShown = false;
        coach.toast(error.message, true);
      }
    };
    client.onHint = hint => coach.showHint(hint);
    client.onActionResult = result => {
      const {evaluation} = result;
      // The service found the learner's change left the step unanswerable. An empty search starts
      // recovering without waiting out the usual grace period; a lost filter or a window that misses
      // the incident still shows results, so recover from it directly.
      if (client.mode === 'guided' && (evaluation.outcome === 'dead_end' || evaluation.outcome === 'empty_result')) {
        if ((evaluation.reason_code || 'empty_result') === 'empty_result') deadEndSince = 1;
        else if (recoveryEligible()) recoverFromDeadEnd(currentCommand, evaluation);
      }
      if (evaluation.outcome === 'accepted') {
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
      // Safety net: reveal Kibana here too, for any flow that reaches a command
      // without first showing a briefing.
      window.__coachBootOverlay?.release();
      // Resume re-sends the pending command. Its reading beat is already running (or paused), so
      // leave that execution and its countdown in place instead of starting the step over.
      // The same holds for a guided "Show me" walkthrough that is still playing.
      if (executionController && !executionController.signal.aborted &&
          currentCommand?.command_id === command.command_id) return;
      // A new guided step means the one being walked through is already complete (e.g. the learner's
      // own action satisfied it), so stop explaining it rather than narrate over the next step.
      if (command.mode === 'guided') executionController?.abort();
      currentCommand = command;
      // The clock times a step, so a re-sent command for the same step keeps counting.
      checkIn = null;
      if (command.mode === 'guided' && command.pace_seconds) {
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
      // Tag a learner's window change with when the incident was noticed (from the briefing) so
      // the service can accept any window that reaches back far enough to include it.
      if (action.type === 'time_range_changed') {
        const offset = coach.currentBriefing?.detected_offset_minutes;
        if (offset != null && action.details && action.details.incident_offset_minutes == null) {
          action.details = {...action.details, incident_offset_minutes: offset};
        }
      }
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
      client.send({message_type: paused ? 'pause' : 'resume'});
    };
    coach.onHint = () => client.requestHint();
    coach.onReviewFeedback = async () => {
      try { coach.debrief.show(await client.getFeedback()); }
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
      coach.stop();
    };
    coach.onDiagnosis = async answer => {
      try {
        const feedback = await client.submitDiagnosis(answer);
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
