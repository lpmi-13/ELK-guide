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
  const demonstrationTimingScale = 10;

  function demonstrationReadingPause(command) {
    const words = [command.narration, command.reasoning, command.evidence, command.concept]
      .filter(Boolean)
      .join(' ')
      .trim()
      .split(/\s+/).length;
    return Math.min(24000, Math.max(10000, words * 250));
  }

  function wait(milliseconds, signal) {
    if (signal?.aborted) return Promise.reject(new DOMException('Demonstration stopped', 'AbortError'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        resolve();
      }, milliseconds);
      const abort = () => {
        clearTimeout(timer);
        reject(new DOMException('Demonstration stopped', 'AbortError'));
      };
      signal?.addEventListener('abort', abort, {once: true});
    });
  }

  async function execute(command, explicitlyRequested = false) {
    executionController?.abort();
    const controller = new AbortController();
    executionController = controller;
    try {
      const timingScale = command.mode === 'demonstration' ? demonstrationTimingScale : 1;
      if (command.mode === 'demonstration') {
        const target = await adapter.waitFor(command.target, 20000, controller.signal);
        coach.showCommand(command, target);
        await wait(demonstrationReadingPause(command), controller.signal);
      }
      const action = await adapter.perform(command, coach, {timingScale, signal: controller.signal});
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
        ...summary.diagnosis,
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
    client.onHint = hint => coach.toast(`Hint ${hint.level}: ${hint.text}`);
    client.onActionResult = result => {
      if (result.evaluation.outcome === 'accepted') coach.toast(result.evaluation.reason);
    };
    client.onCommand = async command => {
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
    observer = new KibanaActionObserver(adapter, action => client.sendAction(action, 'learner'));
    observer.start();
    coach.onPause = paused => {
      if (paused) executionController?.abort();
      client.send({message_type: paused ? 'pause' : 'resume'});
    };
    coach.onHint = () => client.requestHint();
    coach.onDemonstrate = () => currentCommand && execute(currentCommand, true);
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
    host.hidden = session.mode === 'demonstration';
    coach.toast(`Connected to ${session.session_id}. Automation is visibly active.`);
  }

  const savedConfig = sessionStorage.getItem(activeSessionKey);
  if (savedConfig) {
    startSession(JSON.parse(savedConfig)).catch(error => {
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
