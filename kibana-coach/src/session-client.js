class IncidentSessionClient {
  constructor(config) {
    this.server = config.server.replace(/\/$/, '');
    this.sessionId = config.session;
    this.token = config.token;
    this.runId = config.runId;
    this.mode = config.mode;
    this.sequence = 0;
    this.socket = null;
    this.stopped = false;
  }

  async connect() {
    const saved = JSON.parse(sessionStorage.getItem(`incident-coach:${this.sessionId}`) || 'null');
    this.token ||= saved?.token;
    this.runId ||= saved?.runId;
    this.mode ||= saved?.mode;
    if (!this.token || !this.runId || !this.mode) throw new Error('The automatic session handoff is incomplete. Open Kibana from the lab launcher again.');
    this.sequence = saved?.sequence || 0;
    this.save();
    this.openSocket();
    return {session_id: this.sessionId, run_id: this.runId, mode: this.mode};
  }

  save() {
    sessionStorage.setItem(`incident-coach:${this.sessionId}`, JSON.stringify({token: this.token, runId: this.runId, mode: this.mode, sequence: this.sequence}));
  }

  openSocket() {
    const socketUrl = this.server.replace(/^http/, 'ws');
    this.socket = new WebSocket(`${socketUrl}/api/sessions/${this.sessionId}/events?token=${encodeURIComponent(this.token)}`);
    this.socket.onopen = () => this.onStatus?.('Connected to the learning session.');
    this.socket.onmessage = event => this.handle(JSON.parse(event.data));
    this.socket.onclose = () => {
      if (!this.stopped) {
        this.onStatus?.('Reconnecting to the learning session…');
        setTimeout(() => this.openSocket(), 1500);
      }
    };
  }

  handle(message) {
    if (message.message_type === 'command') this.onCommand?.(message);
    else if (message.message_type === 'hint') this.onHint?.(message);
    else if (message.message_type === 'action_result') this.onActionResult?.(message);
    else if (message.message_type === 'complete') this.onStatus?.('Investigation goals complete.');
  }

  send(message) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('Learning session is not connected.');
    this.socket.send(JSON.stringify(message));
  }

  sendAction(partial, actor = 'learner') {
    this.sequence += 1;
    this.save();
    const action = {
      protocol_version: 2,
      run_id: this.runId,
      session_id: this.sessionId,
      sequence: this.sequence,
      type: partial.type,
      actor,
      observed_at: new Date().toISOString(),
      details: partial.details || {},
      state_before: partial.state_before || {},
      state_after: partial.state_after || {}
    };
    this.send({message_type: 'action', action});
  }

  requestHint() { this.send({message_type: 'hint'}); }
  acknowledge(command, status, observedState = {}) { this.send({message_type: 'ack', command_id: command.command_id, status, observed_state: observedState}); }

  async submitDiagnosis(answer) {
    const response = await fetch(`${this.server}/api/sessions/${this.sessionId}/answer`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${this.token}`},
      body: JSON.stringify(answer)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Diagnosis failed (${response.status})`);
    return result;
  }

  stop() {
    this.stopped = true;
    this.socket?.close(1000, 'Learner stopped automation');
  }

  forget() {
    this.stop();
    sessionStorage.removeItem(`incident-coach:${this.sessionId}`);
  }
}

globalThis.IncidentSessionClient = IncidentSessionClient;
