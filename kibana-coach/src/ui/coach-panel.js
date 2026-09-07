class IncidentCoachPanel {
  constructor(host) {
    this.host = host;
    this.root = host.attachShadow({mode: 'open'});
    this.root.innerHTML = `<style>${IncidentCoachPanel.styles}</style>
      <aside class="panel" aria-label="Incident coach">
        <header><span class="live-dot"></span><strong>Incident coach</strong><button id="stop" title="Stop automation">Stop</button></header>
        <div class="progress" aria-hidden="true"><span></span></div>
        <p id="mode"></p><h2 id="objective">Waiting for a session…</h2>
        <section id="stage" aria-live="polite">
          <p id="phase-eyebrow" class="eyebrow"></p>
          <p id="phase-headline"></p>
          <p id="phase-detail" class="muted"></p>
          <div id="countdown" class="countdown" aria-hidden="true" hidden><span></span></div>
        </section>
        <div class="actions"><button id="pause">Pause</button><button id="hint">Hint</button><button id="demonstrate">Show me</button></div>
        <form id="diagnosis" hidden>
          <label>Faulty service<input name="service" required></label>
          <label>Failure type<select name="fault_type"><option value="latency">Latency</option><option value="error">Errors</option><option value="unavailable">Unavailable</option></select></label>
          <label>Affected route<input name="affected_route" placeholder="/checkout" required></label>
          <label>Trace ID<input name="trace_id" required></label>
          <label>Evidence<textarea name="evidence" required></textarea></label>
          <button type="submit">Submit diagnosis</button>
        </form>
        <p id="status" role="status"></p>
      </aside>`;
    this.panel = this.root.querySelector('.panel');
    this.cursor = new IncidentCursor(this.root);
    this.spotlight = new IncidentSpotlight(this.root);
    this.debrief = new IncidentDebrief(this.root);
    this.paused = false;
    this.activeTarget = null;
    this.activeCommandId = null;
    this.reposition = () => {
      if (!this.panel.hidden && this.activeTarget?.isConnected) {
        this.spotlight.show(this.activeTarget);
        this.placeAwayFrom(this.activeTarget);
      }
    };
    window.addEventListener('resize', this.reposition);
    window.addEventListener('scroll', this.reposition, true);
    this.root.querySelector('#pause').onclick = event => {
      this.paused = !this.paused;
      event.target.textContent = this.paused ? 'Resume' : 'Pause';
      this.onPause?.(this.paused);
    };
    this.root.querySelector('#hint').onclick = () => this.onHint?.();
    this.root.querySelector('#demonstrate').onclick = () => this.onDemonstrate?.();
    this.root.querySelector('#stop').onclick = () => this.onStop?.();
    this.root.querySelector('#diagnosis').addEventListener('submit', event => {
      event.preventDefault();
      this.onDiagnosis?.(Object.fromEntries(new FormData(event.target)));
    });
  }

  renderAnswerSchema(schema = {}) {
    const form = this.root.querySelector('#diagnosis');
    const submit = form.querySelector('button[type="submit"]');
    for (const node of [...form.querySelectorAll('label')]) node.remove();
    const fields = schema.fields?.length ? schema.fields : [
      {id: 'service', label: 'Faulty service', kind: 'string'},
      {id: 'fault_type', label: 'Failure type', kind: 'string'},
      {id: 'affected_route', label: 'Affected route', kind: 'string'},
      {id: 'trace_id', label: 'Trace ID', kind: 'string'},
      {id: 'evidence', label: 'Evidence', kind: 'text'},
    ];
    for (const field of fields) {
      const label = document.createElement('label');
      label.textContent = field.label || field.id.replaceAll('_', ' ');
      const input = field.kind === 'text' ? document.createElement('textarea') : document.createElement('input');
      input.name = field.id;
      input.required = field.required !== false;
      if (field.kind === 'number') input.type = 'number';
      if (field.placeholder) input.placeholder = field.placeholder;
      label.append(input);
      form.insertBefore(label, submit);
    }
    submit.textContent = schema.type === 'triage_decision' ? 'Submit triage decision' : schema.type === 'comparison' ? 'Submit comparison' : 'Submit diagnosis';
  }

  showCommand(command, target) {
    this.host.hidden = false;
    this.panel.hidden = false;
    this.activeCommandId = command.command_id;
    this.activeTarget = target;
    this.currentCommand = command;
    this.root.querySelector('#mode').textContent = `${command.mode} · step ${command.step_index + 1} of ${command.step_count}`;
    this.root.querySelector('#objective').textContent = command.step_id.replaceAll('-', ' ');
    this.root.querySelector('.progress span').style.width = `${100 * command.step_index / command.step_count}%`;
    this.root.querySelector('#demonstrate').hidden = command.mode !== 'guided';
    this.root.querySelector('#hint').hidden = command.mode === 'demonstration';
    if (command.type === 'request_diagnosis' || command.type === 'request_answer') this.renderAnswerSchema(command.answer_schema);
    this.root.querySelector('#diagnosis').hidden = !['request_diagnosis', 'request_answer'].includes(command.type) || command.mode === 'demonstration';
    // Reveal one beat at a time. A demonstration opens on its intent and is walked
    // through action then learning by the orchestrator; other modes show a single card.
    if (command.mode === 'demonstration') {
      this.enterPhase('what');
    } else if (command.mode === 'challenge') {
      this.phase = null;
      this.resetCountdown();
      this.root.querySelector('#stage').hidden = true;
    } else {
      this.phase = null;
      this.resetCountdown();
      this.renderPhase({eyebrow: 'What to do', headline: command.narration || ''});
      this.root.querySelector('#stage').hidden = !command.narration;
    }
    if (target && command.mode !== 'challenge') this.spotlight.show(target); else this.spotlight.hide();
    requestAnimationFrame(() => this.placeAwayFrom(target));
  }

  // The demonstration is revealed as one idea per card: what → why → action → learning.
  // "what" and "why" are separate full cards, each with its own countdown to read it.
  enterPhase(phase, command = this.currentCommand) {
    this.phase = phase;
    this.currentCommand = command;
    const stage = this.root.querySelector('#stage');
    stage.hidden = false;
    if (phase === 'what') {
      this.renderPhase({eyebrow: 'What I’ll do next', headline: command?.narration || ''});
      this.resetCountdown();
    } else if (phase === 'why') {
      this.renderPhase({eyebrow: 'Why I’m doing it', headline: command?.reasoning || ''});
      this.resetCountdown();
    } else if (phase === 'action') {
      this.renderPhase({eyebrow: 'Doing it now', headline: 'Watch the highlighted control and the cursor.'});
      this.startWorking();
    } else if (phase === 'learning') {
      const lines = [command?.evidence, command?.concept].filter(Boolean);
      this.renderPhase({eyebrow: 'What we learned', headline: lines[0] || 'Step complete.', detail: lines[1] || ''});
      this.resetCountdown();
    }
  }

  showWhy(command = this.currentCommand) { this.enterPhase('why', command); }

  beginActionPhase(command = this.currentCommand) { this.enterPhase('action', command); }

  showLearning(command = this.currentCommand) { this.enterPhase('learning', command); }

  // Fill the phase bar over `duration` so the learner can see the transition approaching.
  startCountdown(duration) {
    const bar = this.root.querySelector('#countdown');
    const fill = bar.querySelector('span');
    bar.hidden = false;
    bar.classList.remove('working');
    fill.style.animation = 'none';
    fill.style.transform = 'none';
    fill.style.transition = 'none';
    fill.style.width = '0%';
    void fill.offsetWidth;
    fill.style.transition = `width ${Math.max(0, duration)}ms linear`;
    fill.style.width = '100%';
  }

  // The action beat has no fixed length, so sweep a clearly-moving block ("working…").
  startWorking() {
    const bar = this.root.querySelector('#countdown');
    const fill = bar.querySelector('span');
    bar.hidden = false;
    fill.style.transition = 'none';
    fill.style.width = '';
    fill.style.transform = '';
    fill.style.animation = '';
    bar.classList.add('working');
  }

  // Freeze the bar where it is (used when the demo is paused).
  stopCountdown() {
    const bar = this.root.querySelector('#countdown');
    if (bar.hidden) return;
    const fill = bar.querySelector('span');
    const width = getComputedStyle(fill).width;
    fill.style.transition = 'none';
    fill.style.animation = 'none';
    fill.style.transform = 'none';
    fill.style.width = width;
    bar.classList.remove('working');
  }

  resetCountdown() {
    const bar = this.root.querySelector('#countdown');
    const fill = bar.querySelector('span');
    bar.classList.remove('working');
    fill.style.animation = 'none';
    fill.style.transform = 'none';
    fill.style.transition = 'none';
    fill.style.width = '0%';
    bar.hidden = true;
  }

  renderPhase({eyebrow = '', headline = '', detail = ''}) {
    const stage = this.root.querySelector('#stage');
    const eyebrowEl = this.root.querySelector('#phase-eyebrow');
    const detailEl = this.root.querySelector('#phase-detail');
    eyebrowEl.textContent = eyebrow;
    eyebrowEl.hidden = !eyebrow;
    this.root.querySelector('#phase-headline').textContent = headline;
    detailEl.textContent = detail;
    detailEl.hidden = !detail;
    stage.classList.toggle('acting', this.phase === 'action');
    stage.classList.remove('phase-in');
    void stage.offsetWidth;
    stage.classList.add('phase-in');
  }

  showTarget(target, activity = '') {
    this.activeTarget = target;
    if (activity) {
      this.phase = 'action';
      this.renderPhase({eyebrow: 'Doing it now', headline: activity});
      if (!this.root.querySelector('#countdown').classList.contains('working')) this.startWorking();
    }
    if (target) {
      this.spotlight.show(target);
      this.placeAwayFrom(target);
    }
  }

  // Stay put unless the current spot would actually cover the highlighted control (or fell
  // off-screen). Only then glide to the least-disruptive clear corner. Needless hops are jarring.
  placeAwayFrom(target) {
    if (this.panel.hidden) return;
    const margin = 18;
    const topMargin = 72;
    const panelRect = this.panel.getBoundingClientRect();
    const width = panelRect.width;
    const height = Math.min(panelRect.height, innerHeight - topMargin - margin);
    const maxLeft = Math.max(margin, innerWidth - width - margin);
    const maxTop = Math.max(topMargin, innerHeight - height - margin);
    const corners = [
      {left: margin, top: topMargin},
      {left: maxLeft, top: topMargin},
      {left: margin, top: maxTop},
      {left: maxLeft, top: maxTop},
    ];
    const targetRect = target?.getBoundingClientRect();
    const guard = targetRect && targetRect.width
      ? {left: targetRect.left - 40, right: targetRect.right + 40, top: targetRect.top - 40, bottom: targetRect.bottom + 40}
      : null;
    const overlap = position => {
      if (!guard) return 0;
      const right = position.left + width;
      const bottom = position.top + height;
      const w = Math.max(0, Math.min(right, guard.right) - Math.max(position.left, guard.left));
      const h = Math.max(0, Math.min(bottom, guard.bottom) - Math.max(position.top, guard.top));
      return w * h;
    };
    // Sticky: keep the current placement when it isn't covering the target and still fits.
    if (this.pos) {
      const fits = this.pos.left >= margin - 1 && this.pos.top >= topMargin - 1
        && this.pos.left <= maxLeft + 1 && this.pos.top <= maxTop + 1;
      if (fits && overlap(this.pos) === 0) return;
    } else if (!targetRect) {
      this.pos = {left: maxLeft, top: topMargin};
      this.applyPosition();
      return;
    }
    const distTo = position => targetRect
      ? Math.hypot(position.left + width / 2 - (targetRect.left + targetRect.width / 2), position.top + height / 2 - (targetRect.top + targetRect.height / 2))
      : 0;
    const ranked = corners.map(position => ({
      position,
      overlap: overlap(position),
      move: this.pos ? Math.hypot(position.left - this.pos.left, position.top - this.pos.top) : 0,
      away: distTo(position),
    }));
    // Fewest pixels over the target, then (moving) the shortest hop, else the corner farthest from it.
    ranked.sort((a, b) => a.overlap - b.overlap || (this.pos ? a.move - b.move : b.away - a.away));
    this.pos = {left: Math.round(ranked[0].position.left), top: Math.round(ranked[0].position.top)};
    this.applyPosition();
  }

  applyPosition() {
    this.panel.style.left = `${this.pos.left}px`;
    this.panel.style.top = `${this.pos.top}px`;
    this.panel.style.right = 'auto';
  }

  finishCommand(command) {
    if (command?.command_id !== this.activeCommandId) return;
    this.spotlight.hide();
    this.cursor.hide();
    this.panel.hidden = true;
    this.activeTarget = null;
    this.phase = null;
  }

  toast(message, error = false) {
    const status = this.root.querySelector('#status');
    status.textContent = message;
    status.className = error ? 'error' : '';
  }

  stop() {
    this.spotlight.hide();
    this.cursor.hide();
    this.panel.hidden = true;
    this.host.hidden = true;
    this.pos = null;
  }

  static styles = `
    :host { all: initial; position: fixed; z-index: 2147483647; inset: 0; pointer-events: none; font: 14px system-ui,sans-serif; color: #17212b; }
    .panel { pointer-events: auto; position: fixed; z-index:3; top: 72px; right: 18px; width: min(468px, calc(100vw - 36px)); max-height: calc(100vh - 90px); overflow: auto; box-sizing: border-box; padding: 18px; border: 1px solid #b6c6d6; border-radius: 12px; background: #fff; box-shadow: 0 16px 46px #17212b40; transition: left .72s cubic-bezier(.22,1,.36,1), top .72s cubic-bezier(.22,1,.36,1); }
    [hidden] { display:none!important; }
    header { display:flex; align-items:center; gap:8px; } header strong { flex:1; } .live-dot { width:9px;height:9px;border-radius:50%;background:#1aa87a;box-shadow:0 0 0 4px #1aa87a22; }
    h2 { margin: 14px 0 8px; font-size: 17px; text-transform: capitalize; } h3 { margin:0 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.045em;color:#3f5060; } p { line-height:1.45; } #mode { color:#536170; font-size:12px; text-transform:uppercase; letter-spacing:.05em; }
    #stage { padding:20px 22px;border:1px solid #bcd3e6;border-left:6px solid #006bb4;border-radius:11px;background:#f1f7fd;box-shadow:0 6px 20px #006bb416; } #stage.acting { border-left-color:#e0a200;background:#fff8e8;box-shadow:0 6px 20px #e0a2001f; }
    .eyebrow { margin:0 0 10px;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#3f6480;font-weight:750; } #phase-headline { margin:0;font-size:20px;line-height:1.38;font-weight:600;letter-spacing:-.01em;color:#0f2231; } .muted { margin:12px 0 0;font-size:14px;line-height:1.5;color:#48586a; }
    #stage.phase-in { animation:phase-in .32s cubic-bezier(.22,1,.36,1); } @keyframes phase-in { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:none} }
    .countdown { margin-top:16px;height:7px;border-radius:6px;background:#cfe0ee;overflow:hidden; } .countdown span { display:block;height:100%;width:0;background:#006bb4;border-radius:6px; } #stage.acting .countdown { background:#efdaa6; } #stage.acting .countdown span { background:#d98c00; }
    .countdown.working span { width:34%!important;animation:cd-sweep 1.25s cubic-bezier(.55,0,.45,1) infinite; } @keyframes cd-sweep { 0%{transform:translateX(-115%)} 100%{transform:translateX(310%)} }
    @media (prefers-reduced-motion: reduce) { .countdown.working span { transform:none!important;width:100%!important;opacity:.55; } .countdown span { width:100%!important; } }
    button { border:1px solid #8293a3;border-radius:5px;background:#f5f7f9;padding:6px 9px;cursor:pointer; } button:hover,button:focus-visible { outline:2px solid #006bb4;outline-offset:1px; }
    #stop { color:#a32b1c;border-color:#d77d72; } .actions { display:flex; gap:7px; margin-top:12px; }
    .progress { height:4px;background:#dce4eb;margin:13px 0;border-radius:4px;overflow:hidden; }.progress span { display:block;height:100%;background:#006bb4;transition:width .3s; }
    label { display:block;font-weight:650;margin-top:10px; } input,select,textarea { display:block;width:100%;box-sizing:border-box;margin-top:3px;padding:7px;border:1px solid #9ba9b6;border-radius:4px;font:inherit; } textarea { min-height:58px; }
    #diagnosis button { margin-top:12px;background:#006bb4;color:#fff;border:0; } #status { min-height:18px;color:#147d5c; }.error { color:#a32b1c!important; }
    .incident-spotlight { position:fixed;z-index:1;display:none;box-sizing:border-box;border:3px solid #ffb000;border-radius:7px;box-shadow:0 0 0 9999px #10182070;pointer-events:none;transition:all .25s; }
    .incident-cursor { position:fixed;z-index:2;left:-12px;top:-12px;width:24px;height:24px;opacity:0;pointer-events:none;transition:transform var(--incident-cursor-duration, .65s) cubic-bezier(.4,.1,.6,.9),opacity .15s; }
    .incident-cursor.visible { opacity:1; }.incident-cursor:before { content:'➤';display:block;color:#ffb000;font-size:28px;filter:drop-shadow(0 2px 2px #0008);transform:rotate(-25deg); }
    .incident-cursor span { position:absolute;inset:0;border:2px solid #ffb000;border-radius:50%;opacity:0; }.incident-cursor.clicked span { animation:click-ring .5s; }
    @keyframes click-ring { from{opacity:1;transform:scale(.3)}to{opacity:0;transform:scale(2)} }
    dialog.incident-debrief { pointer-events:auto;max-width:600px;border:0;border-radius:10px;padding:24px;box-shadow:0 14px 50px #0006;color:#17212b; }.incident-debrief::backdrop{background:#101820aa}.dialog-close{float:right;border:0;font-size:22px}.incident-debrief li{display:flex;justify-content:space-between;padding:5px 0}.incident-debrief .total{font-size:20px;font-weight:750}.incident-debrief .demo-checks{padding-left:20px}.incident-debrief .demo-checks li{display:list-item;padding:5px 0}.incident-debrief .demo-checks p{margin:3px 0}.incident-conclusion{padding:12px 14px;border-left:4px solid #1aa87a;background:#eef9f5;border-radius:6px}
    @media (prefers-reduced-motion: reduce) { *, .incident-cursor, .progress span { transition:none!important;animation:none!important; } }
  `;
}

globalThis.IncidentCoachPanel = IncidentCoachPanel;
