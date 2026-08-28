(() => {
  const host = document.createElement('div');
  host.id = 'adaptive-incident-coach';
  host.hidden = true;
  document.documentElement.append(host);
  const coach = new IncidentCoachPanel(host);
  const adapter = new KibanaAdapter();
  let client = null;
  let observer = null;
  let currentCommand = null;

  async function execute(command, explicitlyRequested = false) {
    try {
      const action = await adapter.perform(command, coach);
      client.acknowledge(command, 'completed', action?.state_after || {});
      if (explicitlyRequested) client.sendAction({type: 'step_demonstrated', details: {step_id: command.step_id}}, 'learner');
      if (action) client.sendAction(action, 'tutorial');
    } catch (error) {
      coach.toast(error.message, true);
      client.acknowledge(command, 'failed', {error: error.message});
    }
  }

  async function pair(config) {
    client?.stop();
    observer?.stop();
    await adapter.initialize();
    client = new IncidentSessionClient(config);
    client.onStatus = message => coach.toast(message);
    client.onHint = hint => coach.toast(`Hint ${hint.level}: ${hint.text}`);
    client.onActionResult = result => {
      if (result.evaluation.outcome === 'accepted') coach.toast(result.evaluation.reason);
    };
    client.onCommand = command => {
      currentCommand = command;
      const target = adapter.resolve(command.target);
      coach.showCommand(command, target);
      if (command.mode === 'demonstration' && command.type !== 'request_diagnosis') execute(command);
    };
    const session = await client.connect();
    observer = new KibanaActionObserver(adapter, action => client.sendAction(action, 'learner'));
    observer.start();
    coach.onPause = paused => client.send({message_type: paused ? 'pause' : 'resume'});
    coach.onHint = () => client.requestHint();
    coach.onDemonstrate = () => currentCommand && execute(currentCommand, true);
    coach.onStop = () => { observer.stop(); client.stop(); coach.stop(); };
    coach.onDiagnosis = async answer => {
      try {
        const feedback = await client.submitDiagnosis(answer);
        coach.debrief.show(feedback);
      } catch (error) { coach.toast(error.message, true); }
    };
    host.hidden = false;
    coach.toast(`Paired to ${session.session_id}. Automation is visibly active.`);
  }

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type !== 'incident-coach-pair') return false;
    pair(message.config).then(() => respond({ok: true})).catch(error => respond({ok: false, error: error.message}));
    return true;
  });
})();
