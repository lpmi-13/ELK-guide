// @ts-check
// The coach's end of the learning session: one authenticated WebSocket per tab, reconnected when it
// drops. Its messages are declared in ../protocol/protocol.d.ts; `npm run check:protocol` checks this
// file against that declaration and the declaration against samples generated from the server.

/** @typedef {import('../protocol/protocol').ServerMessage} ServerMessage */
/** @typedef {import('../protocol/protocol').ClientMessage} ClientMessage */
/** @typedef {import('../protocol/protocol').ObservedAction} ObservedAction */
/** @typedef {import('../protocol/protocol').Command} Command */
/** @typedef {import('../protocol/protocol').Failed} Failed */
/** @typedef {import('../protocol/protocol').Feedback} Feedback */
/** @typedef {import('../protocol/protocol').Mode} Mode */
/** @typedef {{type: string, details?: Record<string, unknown>, state_before?: Record<string, unknown>, state_after?: Record<string, unknown>}} PartialAction */

// Reconnect delays after a drop, in milliseconds: quick at first, then steady while the service is away.
const RECONNECT_DELAYS = [1500, 3000, 5000, 10000];

class IncidentSessionClient {
  /** @param {{server: string, session: string, token?: string, runId?: string, mode?: Mode}} config */
  constructor(config) {
    this.server = config.server.replace(/\/$/, '');
    this.sessionId = config.session;
    this.token = config.token;
    this.runId = config.runId;
    this.mode = config.mode;
    this.sequence = 0;
    /** @type {WebSocket | null} */
    this.socket = null;
    this.stopped = false;
    // Drops in a row without a successful open, which sets how long to wait before the next attempt.
    this.failures = 0;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    this.reconnectTimer = undefined;
    /** @type {ReturnType<typeof setInterval> | undefined} */
    this.heartbeat = undefined;
    // Observed actions reported while the socket is reconnecting (a pivot reported as its destination page
    // loads, say), sent in order once it is open again rather than lost.
    /** @type {ClientMessage[]} */
    this.outbox = [];
    /** @type {((message: import('../protocol/protocol').IncidentBriefing) => void) | undefined} */
    this.onBriefing = undefined;
    /** @type {((message: Command) => void) | undefined} */
    this.onCommand = undefined;
    /** @type {((message: import('../protocol/protocol').Hint) => void) | undefined} */
    this.onHint = undefined;
    /** @type {((message: import('../protocol/protocol').ActionResult) => void) | undefined} */
    this.onActionResult = undefined;
    /** @type {((message: import('../protocol/protocol').CheckIn) => void) | undefined} */
    this.onCheckIn = undefined;
    /** @type {((message: import('../protocol/protocol').WindowSlid) => void) | undefined} */
    this.onWindowSlid = undefined;
    /** @type {(() => void) | undefined} */
    this.onComplete = undefined;
    /** The run can't be investigated any more (or the service no longer knows the session). @type {((message: Failed) => void) | undefined} */
    this.onFailed = undefined;
    /** @type {((message: string) => void) | undefined} */
    this.onError = undefined;
    /** @type {((message: string, retry?: () => void) => void) | undefined} */
    this.onStatus = undefined;
    /** @type {(() => {step_id: string, seconds_active: number} | null) | undefined} */
    this.stepClock = undefined;
    /** @type {(() => Record<string, unknown> | null) | undefined} */
    this.currentView = undefined;
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
    clearTimeout(this.reconnectTimer);
    if (this.stopped) return;
    const socketUrl = this.server.replace(/^http/, 'ws');
    let opened = false;
    // The browser's UTC offset lets the service write clock times ("noticed at 14:03") as Discover shows them.
    const socket = new WebSocket(`${socketUrl}/api/sessions/${this.sessionId}/events?token=${encodeURIComponent(this.token || '')}&utc_offset=${new Date().getTimezoneOffset()}`);
    this.socket = socket;
    socket.onopen = () => {
      opened = true;
      this.failures = 0;
      this.onStatus?.('');
      for (const queued of this.outbox.splice(0)) socket.send(JSON.stringify(queued));
      // The service drops a socket that says nothing for a minute, and a learner reading the page or
      // writing an answer sends nothing. A heartbeat keeps the session from flickering "Reconnecting".
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(/** @type {ClientMessage} */ ({message_type: 'heartbeat'})));
      }, 25000);
    };
    socket.onmessage = event => this.handle(/** @type {ServerMessage} */ (JSON.parse(event.data)));
    socket.onclose = () => {
      clearInterval(this.heartbeat);
      if (this.stopped || this.socket !== socket) return;
      // A socket that never opened may mean the session is gone, not that the service is busy: ask.
      if (!opened) this.probe().then(expired => { if (!expired) this.scheduleReconnect(); });
      else this.scheduleReconnect();
    };
  }

  // Try again after a growing pause, saying so, with a way to try now.
  scheduleReconnect() {
    if (this.stopped) return;
    const delay = RECONNECT_DELAYS[Math.min(this.failures, RECONNECT_DELAYS.length - 1)];
    this.failures += 1;
    const retry = () => this.openSocket();
    this.onStatus?.(this.failures > 1 ? 'The learning service is not answering. Retrying…' : 'Reconnecting to the learning session…', retry);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(retry, delay);
  }

  /**
   * Whether the session has ended for good. The service answers 404 for a session it no longer knows
   * (it restarted, say) and 401 for a token it never issued; either way there is nothing to reconnect
   * to, so the coach offers the launcher instead. A service that can't be reached at all may come back.
   * @returns {Promise<boolean>}
   */
  async probe() {
    let response;
    try {
      response = await fetch(`${this.server}/api/sessions/${this.sessionId}`, {headers: {Authorization: `Bearer ${this.token}`}, cache: 'no-store'});
    } catch (_error) {
      return false;
    }
    /** @type {{launcher_url?: string, available?: boolean, run_state?: string | null}} */
    let body = {};
    try { body = await response.json(); } catch (_error) { /* not JSON: a proxy error page */ }
    const launcher = body.launcher_url || `${location.protocol}//${location.hostname}:8090/`;
    if (response.status === 404 || response.status === 401) {
      this.end({message_type: 'failed', session_id: this.sessionId, reason: 'missing', error: 'This investigation is no longer available.', launcher_url: launcher});
      return true;
    }
    if (response.ok && body.available === false) {
      const reason = body.run_state === 'FAILED' ? 'failed' : body.run_state === 'ABORTED' ? 'aborted' : 'missing';
      const error = reason === 'failed' ? 'This investigation could not be prepared.' : reason === 'aborted'
        ? 'This investigation has ended: its run was stopped or replaced.' : 'This investigation is no longer available.';
      this.end({message_type: 'failed', session_id: this.sessionId, reason, error, launcher_url: launcher});
      return true;
    }
    return false;
  }

  /** @param {Failed} message */
  end(message) {
    this.stop();
    this.onFailed?.(message);
  }

  /** @param {ServerMessage} message */
  handle(message) {
    switch (message.message_type) {
      case 'incident_briefing': this.onBriefing?.(message); break;
      case 'command': this.onCommand?.(message); break;
      case 'hint': this.onHint?.(message); break;
      case 'action_result': this.onActionResult?.(message); break;
      case 'check_in': this.onCheckIn?.(message); break;
      case 'window_slid': this.onWindowSlid?.(message); break;
      case 'complete':
        this.onStatus?.('Investigation goals complete.');
        this.onComplete?.();
        break;
      case 'failed': this.end(message); break;
      case 'error': this.onError?.(message.error || 'Learning session error.'); break;
      // Pause/resume and command acknowledgements need nothing further from the coach.
      case 'status':
      case 'acknowledged':
        break;
      default: {
        /** @type {never} */
        const unhandled = message;
        console.warn('Unknown learning-session message', unhandled);
      }
    }
  }

  /** @param {ClientMessage} message */
  send(message) {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      if (message.message_type === 'action' && !this.stopped) {
        this.outbox.push(message);
        return;
      }
      throw new Error('Learning session is not connected.');
    }
    this.socket.send(JSON.stringify(message));
  }

  /**
   * @param {PartialAction} partial
   * @param {'learner' | 'tutorial'} [actor]
   */
  sendAction(partial, actor = 'learner') {
    if (!this.runId) throw new Error('Learning session is not connected.');
    this.sequence += 1;
    this.save();
    /** @type {ObservedAction} */
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
    // Guided: the active time spent on the current step so far, recorded for the debrief.
    const clock = this.stepClock?.();
    if (clock) action.step_clock = clock;
    // The search on screen as the action is reported; the service checks evidence against it.
    const view = this.currentView?.();
    if (view) action.view = view;
    this.send({message_type: 'action', action});
  }

  requestHint() { this.send({message_type: 'hint'}); }
  /** @param {string} stepId */
  requestCheckIn(stepId) { this.send({message_type: 'check_in', step_id: stepId}); }
  // Ask whether the learner's relative window has moved past the incident yet (see window_watch).
  checkWindow() { this.send({message_type: 'window_check'}); }
  /** @param {string} stepId @param {string} reasonCode @param {string | null} [diagnosis] */
  reportRecovery(stepId, reasonCode, diagnosis) { this.send({message_type: 'recovery_shown', step_id: stepId, reason_code: reasonCode, diagnosis: diagnosis || null}); }
  /** @param {import('../protocol/protocol').IncidentBriefing} briefing */
  acknowledgeBriefing(briefing) { this.send({message_type: 'briefing_ack', briefing_id: briefing.briefing_id}); }
  /** @param {Command} command @param {'completed' | 'failed'} status @param {Record<string, unknown>} [observedState] */
  acknowledge(command, status, observedState = {}) { this.send({message_type: 'ack', command_id: command.command_id, status, observed_state: observedState}); }
  /** @param {boolean} paused */
  setPaused(paused) { this.send({message_type: paused ? 'pause' : 'resume'}); }

  /**
   * @param {Record<string, unknown>} answer
   * @returns {Promise<Feedback>}
   */
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

  /** @returns {Promise<Feedback>} */
  async getFeedback() {
    const response = await fetch(`${this.server}/api/sessions/${this.sessionId}/feedback`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Feedback unavailable (${response.status})`);
    return result;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeat);
    this.socket?.close(1000, 'Learner stopped automation');
  }

  forget() {
    this.stop();
    sessionStorage.removeItem(`incident-coach:${this.sessionId}`);
  }
}

/** @type {any} */ (globalThis).IncidentSessionClient = IncidentSessionClient;
