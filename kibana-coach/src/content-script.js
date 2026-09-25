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

  function readingBeatWait(milliseconds, signal) {
    if (signal?.aborted) return Promise.reject(new DOMException('Demonstration stopped', 'AbortError'));
    return new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (completeReadingBeat === done) completeReadingBeat = null; resolve(); };
      const abort = () => { clearTimeout(timer); if (completeReadingBeat === done) completeReadingBeat = null; reject(new DOMException('Demonstration stopped', 'AbortError')); };
      const timer = setTimeout(done, milliseconds);
      completeReadingBeat = done;
      signal?.addEventListener('abort', abort, {once: true});
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
        // Beat 1 — what: name the next move; Beat 2 — why: the reason, each its own card.
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
      const action = await adapter.perform(command, coach, {timingScale, signal: controller.signal});
      if (command.mode === 'demonstration') {
        // Beat 4 — learning: summarise what the result showed before moving on.
        coach.showLearning(command);
        await readBeat(command.evidence);
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
    await adapter.initialize();
    client = new IncidentSessionClient(config);
    client.onStatus = message => coach.toast(message);
    client.onError = message => coach.toast(message, true);
    client.onHint = hint => coach.toast(`Hint ${hint.level}: ${hint.text}`);
    client.onActionResult = result => {
      if (result.evaluation.outcome === 'accepted') {
        const reason = String(result.evaluation.reason || '').replace(/^Completed:\s*/i, '').trim();
        coach.celebrate(reason || 'Correct — that step is complete.');
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
      currentCommand = command;
      if (command.mode === 'demonstration' && command.type === 'show_debrief') {
        finishDemonstration(command);
        return;
      }
      if (command.mode === 'demonstration') {
        execute(command);
        return;
      }
      let target = adapter.resolve(command.target);
      if (!target && command.target.startsWith('kibana.')) {
        target = await adapter.waitFor(command.target, 20000).catch(() => null);
        if (currentCommand !== command) return;
      }
      coach.showCommand(command, target);
    };
    const session = await client.connect();
    observer = new KibanaActionObserver(adapter, action => {
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
        executionController?.abort();
        coach.stopCountdown();
      }
      client.send({message_type: paused ? 'pause' : 'resume'});
    };
    coach.onHint = () => client.requestHint();
    coach.onDemonstrate = () => currentCommand && execute(currentCommand, true);
    coach.onAdvance = () => {
      if (!currentCommand || currentCommand.mode !== 'demonstration') return;
      if (coach.paused) {
        // Nothing is counting down while paused — resume so the demonstration plays on.
        coach.setPaused(false);
        return;
      }
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
    coach.toast(`Connected to ${session.session_id}. Automation is visibly active.`);
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
