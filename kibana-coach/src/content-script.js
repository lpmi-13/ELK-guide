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
    client.onStatus = message => coach.toast(message);
    client.onError = message => coach.toast(message, true);
    client.onComplete = async () => {
      if (client.mode !== 'guided' || guidedFeedbackShown) return;
      guidedFeedbackShown = true;
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
      if (result.evaluation.outcome === 'accepted') {
        const reason = String(result.evaluation.reason || '').replace(/^Completed:\s*/i, '').trim();
        coach.celebrate(reason || 'This step revealed useful evidence.');
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
    });
    observer.start();
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
