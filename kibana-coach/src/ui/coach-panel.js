class IncidentCoachPanel {
  constructor(host) {
    this.host = host;
    this.root = host.attachShadow({mode: 'open'});
    this.root.innerHTML = `<style>${IncidentCoachPanel.styles}</style>
      <aside class="panel" aria-label="Incident coach" hidden>
        <header title="Drag to move the coach"><span class="live-dot"></span><strong>Incident coach</strong><button id="stop" title="Stop automation">Stop</button></header>
        <div class="progress" aria-hidden="true"><span></span></div>
        <p id="mode"></p><h2 id="objective"></h2>
        <section id="stage" aria-live="polite">
          <p id="phase-eyebrow" class="eyebrow"></p>
          <p id="phase-headline"></p>
          <p id="phase-detail" hidden></p>
          <div id="countdown" class="countdown" aria-hidden="true" hidden><span></span></div>
        </section>
        <div class="actions"><button id="pause">Pause</button><button id="advance" title="Complete this step now and continue">Advance</button><button id="incident-info" title="Review the initial incident briefing">Incident info</button><button id="hint">Hint</button><button id="demonstrate">Show me</button><button id="review-feedback" hidden>Review feedback</button></div>
        <section id="hint-card" aria-live="polite" hidden><span id="hint-label"></span><p id="hint-text"></p></section>
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
    this.briefing = new IncidentBriefing(this.root);
    this.currentBriefing = null;
    this.paused = false;
    this.activeTarget = null;
    this.activeCommandId = null;
    this.evidenceFields = [];
    this.evidenceHighlights = [];
    // A guided step starts undimmed; the spotlight is only revealed on demonstration or a hint.
    this.spotlightRevealed = false;
    // New evidence is confirmed inside the panel; the next step is held until it finishes.
    this.celebrating = false;
    this.advanceRequested = false;
    this.pendingCommand = null;
    const dragHandle = this.root.querySelector('header');
    dragHandle.addEventListener('pointerdown', event => this.startDrag(event));
    dragHandle.addEventListener('pointermove', event => this.moveDrag(event));
    dragHandle.addEventListener('pointerup', event => this.endDrag(event));
    dragHandle.addEventListener('pointercancel', event => this.endDrag(event));
    this.reposition = event => {
      if (this.panel.hidden) return;
      // Scroll fires this many times a second; coalesce to one update per frame so the glide isn't
      // repeatedly retargeted mid-flight (which resets its easing and reads as a stutter).
      if (this.repositionScheduled) return;
      this.repositionScheduled = true;
      requestAnimationFrame(() => {
        this.repositionScheduled = false;
        if (this.panel.hidden) return;
        const target = this.activeTarget?.isConnected ? this.activeTarget : null;
        // Nothing to dodge — no highlighted control and no open doc-viewer flyout — so leave the
        // card where it rests rather than nudging it for every stray scroll or mutation.
        if (this.dragging) return;
        if (!target && !this.findFlyout() && !this.findPopovers().length && !this.evidenceField && !this.evidenceFields.length && event?.type !== 'resize') return;
        // Keep the panel clear of the control, but only re-dim/-highlight if the spotlight is
        // already revealed — a guided step starts with nothing dimmed until the learner asks.
        if (target && this.spotlightRevealed) this.spotlight.show(target);
        this.refreshEvidenceHighlights();
        this.placeAwayFrom(target);
      });
    };
    window.addEventListener('resize', this.reposition);
    window.addEventListener('scroll', this.reposition, true);
    // Expanding a result opens Kibana's doc-viewer flyout, docked over the right of the screen —
    // exactly where the card usually sits, so it would be hidden underneath. Popovers (the time
    // picker, a field's Top values, Add filter) open over the page the same way, and the step's own
    // control can render — or shift — only after its command arrived, as Discover finishes loading.
    // None of that fires a scroll or resize, so watch the DOM and re-check placement (one frame at a
    // time). placeAwayFrom is sticky, so this only moves the card when it actually covers something
    // the learner needs; the open/closed flag skips the flood of unrelated mutations otherwise.
    this.flyoutObserver = new MutationObserver(() => {
      if (this.flyoutCheckScheduled) return;
      this.flyoutCheckScheduled = true;
      requestAnimationFrame(() => {
        this.flyoutCheckScheduled = false;
        const open = !!this.findFlyout();
        const watching = this.activeTarget?.isConnected || this.findPopovers().length || this.evidenceField || this.evidenceFields.length;
        if (open === this.flyoutOpen && !watching) return;
        this.flyoutOpen = open;
        this.reposition();
      });
    });
    this.flyoutObserver.observe(document.body, {childList: true, subtree: true});
    this.root.querySelector('#pause').onclick = () => this.setPaused(!this.paused);
    this.root.querySelector('#advance').onclick = () => this.onAdvance?.();
    this.root.querySelector('#hint').onclick = () => this.revealHint();
    this.root.querySelector('#demonstrate').onclick = () => this.onDemonstrate?.();
    this.root.querySelector('#review-feedback').onclick = () => this.onReviewFeedback?.();
    this.root.querySelector('#incident-info').onclick = () => {
      if (this.currentBriefing) this.briefing.show(this.currentBriefing, {review: true});
    };
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

  showBriefing(briefing) {
    this.host.hidden = false;
    this.currentBriefing = briefing;
    return this.briefing.show(briefing);
  }

  showCommand(command, target) {
    // Hold the next step behind an in-progress confirmation so the learner sees the success land
    // before the card flips to the next task; finishCelebrate() replays this once it settles.
    if (this.celebrating) {
      this.pendingCommand = {command, target};
      if (this.advanceRequested) this.finishCelebrate();
      return;
    }
    this.clearHint();
    this.host.hidden = false;
    this.panel.hidden = false;
    this.root.querySelector('#stage').classList.remove('success', 'celebrate-in', 'recovery');
    this.activeCommandId = command.command_id;
    this.activeTarget = target;
    this.evidenceField = null;
    this.clearEvidenceHighlights();
    this.currentCommand = command;
    this.root.querySelector('#mode').textContent = `${command.mode} · step ${command.step_index + 1} of ${command.step_count}`;
    this.root.querySelector('#objective').textContent = command.step_id.replaceAll('-', ' ');
    this.root.querySelector('.progress span').style.width = `${100 * command.step_index / command.step_count}%`;
    this.root.querySelector('#pause').hidden = command.mode !== 'demonstration';
    this.root.querySelector('#demonstrate').hidden = command.mode !== 'guided';
    this.root.querySelector('#review-feedback').hidden = true;
    this.root.querySelector('#incident-info').hidden = command.mode !== 'guided' || !this.currentBriefing;
    const advance = this.root.querySelector('#advance');
    advance.hidden = command.mode !== 'demonstration';
    advance.textContent = 'Advance';
    advance.title = 'Continue to the next part';
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
    // A demonstration is the coach acting on-screen, so it keeps the spotlight (dim + highlight)
    // from the start. A guided step is the learner's to solve: begin with nothing dimmed or
    // highlighted, and only reveal the spotlight when they explicitly ask for a hint. Challenge
    // stays dark too. `activeTarget` is still stored above so a later hint knows what to point at.
    this.spotlightRevealed = command.mode === 'demonstration';
    if (target && this.spotlightRevealed) this.spotlight.show(target); else this.spotlight.hide();
    requestAnimationFrame(() => this.placeAwayFrom(target));
  }

  updateCommandTarget(command, target) {
    if (this.pendingCommand?.command === command) this.pendingCommand.target = target;
    else if (this.activeCommandId === command.command_id) {
      // The step's control rendered after its card did (Discover was still loading), so the card was
      // placed with nothing to avoid. Re-place it now so it never sits on the control to use.
      this.activeTarget = target;
      requestAnimationFrame(() => this.placeAwayFrom(target));
    }
  }

  // The learner's own input left the view with no results. Explain what went wrong and that the
  // coach is about to put the search back; Advance ("Restore now") skips the reading countdown.
  showRecovery({headline, detail}) {
    clearTimeout(this.celebrateTimer);
    this.celebrating = false;
    this.advanceRequested = false;
    this.clearHint();
    this.spotlight.hide();
    this.cursor.hide();
    this.host.hidden = false;
    this.panel.hidden = false;
    this.phase = 'recovery';
    for (const id of ['#hint', '#demonstrate', '#incident-info', '#pause', '#review-feedback']) this.root.querySelector(id).hidden = true;
    const advance = this.root.querySelector('#advance');
    advance.hidden = false;
    advance.textContent = 'Restore now';
    advance.title = 'Put the search back now';
    const stage = this.root.querySelector('#stage');
    stage.hidden = false;
    stage.classList.remove('success', 'celebrate-in', 'acting');
    stage.classList.add('recovery');
    this.renderPhase({eyebrow: 'No results — back on track', headline, detail});
    requestAnimationFrame(() => this.placeAwayFrom(this.activeTarget?.isConnected ? this.activeTarget : null));
  }

  showRecoveryWorking() {
    this.root.querySelector('#advance').hidden = true;
    this.renderPhase({eyebrow: 'Restoring the search', headline: 'Clearing the dead end and re-applying what the investigation has established so far…'});
    this.startWorking();
  }

  showGuidedCompletion() {
    clearTimeout(this.celebrateTimer);
    this.celebrating = false;
    this.advanceRequested = false;
    this.pendingCommand = null;
    this.phase = null;
    this.clearHint();
    this.spotlight.hide();
    this.host.hidden = false;
    this.panel.hidden = false;
    this.root.querySelector('.progress span').style.width = '100%';
    this.root.querySelector('#mode').textContent = 'guided · complete';
    this.root.querySelector('#objective').textContent = 'Investigation complete';
    this.root.querySelector('#pause').hidden = true;
    this.root.querySelector('#advance').hidden = true;
    this.root.querySelector('#hint').hidden = true;
    this.root.querySelector('#demonstrate').hidden = true;
    this.root.querySelector('#review-feedback').hidden = false;
    this.root.querySelector('#incident-info').hidden = !this.currentBriefing;
    this.root.querySelector('#diagnosis').hidden = true;
    this.root.querySelector('#stage').classList.remove('success', 'celebrate-in', 'recovery');
    this.root.querySelector('#stage').hidden = false;
    this.renderPhase({eyebrow: 'Finished', headline: 'Your guided investigation is complete.'});
    requestAnimationFrame(() => this.placeAwayFrom(null));
  }

  // A hint in guided mode dims the page and highlights the control the step is about — the first
  // time the learner needs a nudge — in addition to requesting the worded hint from the service.
  revealHint() {
    if (this.activeTarget?.isConnected) {
      this.spotlightRevealed = true;
      this.spotlight.show(this.activeTarget);
      this.placeAwayFrom(this.activeTarget);
    }
    this.onHint?.();
  }

  showHint(hint) {
    // A reply can arrive after the learner has moved to another card or step.
    if (this.panel.hidden || this.phase ||
        !['guided', 'challenge'].includes(this.currentCommand?.mode) ||
        hint.step_id !== this.currentCommand.step_id) return;
    this.root.querySelector('#hint-label').textContent = hint.level > 0 ? `Hint ${hint.level}` : 'Hint';
    this.root.querySelector('#hint-text').textContent = hint.text;
    this.root.querySelector('#hint-card').hidden = false;
    this.refit();
    this.placeAwayFrom(this.activeTarget?.isConnected ? this.activeTarget : null);
  }

  clearHint() {
    this.root.querySelector('#hint-card').hidden = true;
    this.root.querySelector('#hint-label').textContent = '';
    this.root.querySelector('#hint-text').textContent = '';
  }

  // The demonstration is revealed as one idea per card: what → optional why → action → learning.
  // When supplied, "what" and "why" are separate full cards with their own reading countdowns.
  enterPhase(phase, command = this.currentCommand) {
    this.clearHint();
    if (phase !== 'learning') this.clearEvidenceHighlights();
    this.phase = phase;
    this.currentCommand = command;
    this.root.querySelector('#advance').title = 'Continue to the next part';
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
      // The action is done; this beat talks about the result, not a control. Drop the spotlight and
      // cursor so a now-stale highlight (e.g. the closed time picker's Apply button, left floating
      // over the results grid) doesn't linger, and the page un-dims to show the refreshed histogram.
      this.spotlightRevealed = false;
      this.spotlight.hide();
      this.cursor.hide();
      this.activeTarget = null;
      this.evidenceField = command?.type === 'add_column' ? command.value?.field : null;
      this.renderPhase({eyebrow: 'What we learned', headline: command?.evidence || 'Step complete.'});
      this.resetCountdown();
      this.showEvidenceHighlights(command?.learning_focus || []);
      // The added column is the evidence to read next. Return the coach to the left before the
      // browser paints the refreshed table, then keep that column clear if the user moves the coach.
      if (this.evidenceField && !this.dragging) {
        this.pos = {left: 18, top: 72};
        this.applyPosition();
        requestAnimationFrame(() => this.placeAwayFrom(null));
      }
    }
  }

  // "Show me" on a guided step starts the action right away, then explains it after the result.
  // Advance can skip that final reading beat; Hint and Show me are moot while the coach acts.
  beginWalkthrough(command) {
    this.root.querySelector('#demonstrate').hidden = true;
    this.root.querySelector('#hint').hidden = true;
    this.root.querySelector('#incident-info').hidden = true;
    this.root.querySelector('#advance').hidden = false;
    if (this.activeTarget?.isConnected) {
      this.spotlightRevealed = true;
      this.spotlight.show(this.activeTarget);
    }
    this.enterPhase('action', command);
    requestAnimationFrame(() => this.placeAwayFrom(this.activeTarget));
  }

  showWhy(command = this.currentCommand) { this.enterPhase('why', command); }

  beginActionPhase(command = this.currentCommand) { this.enterPhase('action', command); }

  showLearning(command = this.currentCommand) { this.enterPhase('learning', command); }

  setPaused(paused, notify = true) {
    this.paused = paused;
    this.root.querySelector('#pause').textContent = paused ? 'Resume' : 'Pause';
    if (notify) this.onPause?.(paused);
  }

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
    // The bar adds height after the card was fitted; lift the card so nothing below it is clipped.
    this.refit();
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
    this.refit();
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

  // Continue a frozen reading bar using the time still left in its beat.
  resumeCountdown(remaining) {
    const bar = this.root.querySelector('#countdown');
    if (bar.hidden || bar.classList.contains('working')) return;
    const fill = bar.querySelector('span');
    void fill.offsetWidth;
    fill.style.transition = `width ${Math.max(0, remaining)}ms linear`;
    fill.style.width = '100%';
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
    eyebrowEl.textContent = eyebrow;
    eyebrowEl.hidden = !eyebrow;
    this.root.querySelector('#phase-headline').textContent = headline;
    const detailEl = this.root.querySelector('#phase-detail');
    detailEl.textContent = detail;
    detailEl.hidden = !detail;
    if (this.phase !== 'recovery') stage.classList.remove('recovery');
    stage.classList.toggle('acting', this.phase === 'action');
    stage.classList.remove('phase-in');
    void stage.offsetWidth;
    stage.classList.add('phase-in');
    this.refit();
  }

  showTarget(target, activity = '') {
    this.activeTarget = target;
    if (activity) {
      this.phase = 'action';
      this.renderPhase({eyebrow: 'Doing it now', headline: activity});
      if (!this.root.querySelector('#countdown').classList.contains('working')) this.startWorking();
    }
    if (target) {
      // The coach is acting on this control (a demonstration or a "Show me"), so the spotlight is
      // shown and stays revealed for repositioning on scroll/resize.
      this.spotlightRevealed = true;
      this.spotlight.show(target);
      this.placeAwayFrom(target);
    }
  }

  showInfo(target, activity) {
    this.phase = 'info';
    this.resetCountdown();
    this.renderPhase({eyebrow: 'Note', headline: activity});
    this.showTarget(target);
    this.root.querySelector('#advance').title = 'Continue after reading this note';
  }

  waitForAdvance(signal) {
    if (signal?.aborted) return Promise.reject(new DOMException('Demonstration stopped', 'AbortError'));
    return new Promise((resolve, reject) => {
      const clear = () => {
        signal?.removeEventListener('abort', abort);
        if (this.completeInfoBeat === done) this.completeInfoBeat = null;
      };
      const done = () => { clear(); resolve(); };
      const abort = () => { clear(); reject(new DOMException('Demonstration stopped', 'AbortError')); };
      this.completeInfoBeat = done;
      signal?.addEventListener('abort', abort, {once: true});
    });
  }

  advanceInfo() {
    if (!this.completeInfoBeat) return false;
    this.completeInfoBeat();
    return true;
  }

  // Kibana's expanded-document viewer opens as a flyout docked on the right. Return its on-screen
  // rectangle while it's open (and big enough to matter), so placement can treat it as a keep-out
  // region just like a highlighted control; null when there's no flyout to dodge.
  findFlyout() {
    const el = document.querySelector("[data-test-subj='docViewerFlyout']");
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return null;
    return rect;
  }

  // Kibana's open popovers — the time picker, a field's Top values, Add filter, combo-box option
  // lists. Whatever the learner has open is what they are working in, so it is a keep-out region.
  findPopovers() {
    return [...document.querySelectorAll('[data-popover-panel], .euiPopover__panel, .euiComboBoxOptionsList')]
      .map(node => node.getBoundingClientRect())
      .filter(rect => rect.width >= 40 && rect.height >= 40 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth);
  }

  findEvidenceRect() {
    if (!this.evidenceField) return null;
    const header = [...document.querySelectorAll("[role='columnheader'], th")]
      .find(node => node.textContent?.trim() === this.evidenceField);
    if (!header) return null;
    const rect = header.getBoundingClientRect();
    if (!rect.width || rect.right <= 0 || rect.left >= innerWidth) return null;
    return {left: rect.left - 24, right: rect.right + 24, top: rect.top - 24, bottom: innerHeight};
  }

  clearEvidenceHighlights() {
    for (const highlight of this.evidenceHighlights || []) highlight.remove();
    this.evidenceHighlights = [];
    this.evidenceFields = [];
  }

  showEvidenceHighlights(fields) {
    this.clearEvidenceHighlights();
    this.evidenceFields = Array.isArray(fields) ? fields : [];
    for (const field of this.evidenceFields) {
      const highlight = document.createElement('div');
      highlight.className = 'incident-evidence-highlight';
      highlight.setAttribute('aria-hidden', 'true');
      this.root.append(highlight);
      this.evidenceHighlights.push(highlight);
    }
    this.refreshEvidenceHighlights();
  }

  refreshEvidenceHighlights() {
    if (!this.evidenceFields?.length) return;
    const headers = [...document.querySelectorAll("[role='columnheader'], th")];
    for (const [index, field] of this.evidenceFields.entries()) {
      const highlight = this.evidenceHighlights[index];
      const header = headers.find(node => node.textContent?.trim().includes(field));
      const rect = header?.getBoundingClientRect();
      const left = Math.max(0, rect?.left ?? 0);
      const right = Math.min(innerWidth, rect?.right ?? 0);
      const top = Math.max(0, rect?.top ?? 0);
      highlight.hidden = !rect || right <= left || top >= innerHeight - 48;
      if (!highlight.hidden) {
        highlight.style.cssText = `left:${left}px;top:${top}px;width:${right - left}px;height:${innerHeight - top - 48}px`;
      }
    }
  }

  clampPosition(left, top) {
    const rect = this.panel.getBoundingClientRect();
    return {
      left: Math.round(Math.max(18, Math.min(left, Math.max(18, innerWidth - rect.width - 18)))),
      top: Math.round(Math.max(72, Math.min(top, Math.max(72, innerHeight - Math.min(rect.height, innerHeight - 90) - 18)))),
    };
  }

  startDrag(event) {
    if (event.button !== 0 || event.target.closest('button') || this.panel.hidden) return;
    event.preventDefault();
    const handle = this.root.querySelector('header');
    handle.setPointerCapture(event.pointerId);
    const rect = this.panel.getBoundingClientRect();
    this.dragging = {pointerId: event.pointerId, x: event.clientX - rect.left, y: event.clientY - rect.top};
    this.panel.style.transition = 'none';
    handle.classList.add('dragging');
  }

  moveDrag(event) {
    if (this.dragging?.pointerId !== event.pointerId) return;
    this.pos = this.clampPosition(event.clientX - this.dragging.x, event.clientY - this.dragging.y);
    this.applyPosition(true);
  }

  endDrag(event) {
    if (this.dragging?.pointerId !== event.pointerId) return;
    this.dragging = null;
    const handle = this.root.querySelector('header');
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    handle.classList.remove('dragging');
    this.panel.style.transition = '';
    this.placeAwayFrom(this.activeTarget?.isConnected ? this.activeTarget : null);
  }

  // Stay put unless the current spot would actually cover the highlighted control or the open
  // doc-viewer flyout (or fell off-screen). Only then glide to the least-disruptive clear corner.
  // Needless hops are jarring.
  placeAwayFrom(target) {
    if (this.panel.hidden || this.dragging) return;
    // A null pos means the panel was just revealed: snap to the resting spot instead of gliding
    // there from the CSS default corner (the load-time jerk/reflow). Later moves stay animated.
    const firstPlacement = !this.pos;
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
    // A generous keep-out ring around the control: the panel leaves while the highlight/cursor is
    // still approaching rather than once it has already slid underneath, so the move reads as
    // getting out of the way in advance instead of reacting to a collision.
    const lead = 64;
    // Everything the card must stay off: the highlighted control (with its lead ring) and, while the
    // expanded-document viewer is open, the flyout docked on the right. Overlap is summed over all of
    // them, so an open flyout on the right pushes the card to a clear corner on the left.
    const guards = [];
    if (targetRect && targetRect.width) {
      guards.push({left: targetRect.left - lead, right: targetRect.right + lead, top: targetRect.top - lead, bottom: targetRect.bottom + lead});
    }
    const flyoutRect = this.findFlyout();
    if (flyoutRect) {
      guards.push({left: flyoutRect.left, right: flyoutRect.right, top: flyoutRect.top, bottom: flyoutRect.bottom});
    }
    const evidenceRect = this.findEvidenceRect();
    if (evidenceRect) guards.push(evidenceRect);
    const pad = 16;
    for (const rect of this.findPopovers()) {
      guards.push({left: rect.left - pad, right: rect.right + pad, top: rect.top - pad, bottom: rect.bottom + pad});
    }
    const overlap = position => {
      const right = position.left + width;
      const bottom = position.top + height;
      let area = 0;
      for (const guard of guards) {
        const w = Math.max(0, Math.min(right, guard.right) - Math.max(position.left, guard.left));
        const h = Math.max(0, Math.min(bottom, guard.bottom) - Math.max(position.top, guard.top));
        area += w * h;
      }
      return area;
    };
    // Sticky: keep the current placement when it isn't covering a keep-out and still fits.
    if (this.pos) {
      const fits = this.pos.left >= margin - 1 && this.pos.top >= topMargin - 1
        && this.pos.left <= maxLeft + 1 && this.pos.top <= maxTop + 1;
      if (fits && overlap(this.pos) === 0) return;
    } else if (!guards.length) {
      this.pos = {left: maxLeft, top: topMargin};
      this.applyPosition(firstPlacement);
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
    // Fewest pixels over the keep-outs, then (moving) the shortest hop, else the corner farthest
    // from the control.
    ranked.sort((a, b) => a.overlap - b.overlap || (this.pos ? a.move - b.move : b.away - a.away));
    this.pos = {left: Math.round(ranked[0].position.left), top: Math.round(ranked[0].position.top)};
    this.applyPosition(firstPlacement);
  }

  // `instant` suppresses the panel's left/top transition for one commit so a freshly revealed panel
  // appears at its resting spot rather than sliding in from the CSS default corner.
  applyPosition(instant = false) {
    // Move with a GPU-composited transform rather than left/top: animating layout properties forces
    // the heavy Kibana grid underneath to reflow on every frame, which drops frames and reads as a
    // jerky slide. The glide time also scales with the distance travelled so a small nudge stays
    // quick while a full corner-swap decelerates gently into place instead of lurching off the mark.
    if (instant) {
      this.panel.style.transition = 'none';
    } else {
      const from = this.appliedPos || this.pos;
      const distance = Math.hypot(this.pos.left - from.left, this.pos.top - from.top);
      this.panel.style.setProperty('--panel-move', `${Math.round(Math.min(900, Math.max(380, distance * 0.8)))}ms`);
    }
    this.panel.style.transform = `translate(${this.pos.left}px, ${this.pos.top}px)`;
    // Bound the card to the viewport from wherever its top now sits, so a phase that grows
    // taller can never spill past the bottom edge — it keeps the same margin as the sides and
    // scrolls inside if it truly can't fit. (CSS max-height is measured from the viewport top,
    // which stops guarding once the panel is placed lower down.)
    this.panel.style.maxHeight = `${Math.max(160, innerHeight - this.pos.top - 18)}px`;
    if (instant) {
      void this.panel.offsetWidth; // flush the placement before re-enabling the transition
      if (!this.dragging) this.panel.style.transition = '';
    }
    this.appliedPos = {left: this.pos.left, top: this.pos.top};
  }

  // A demonstration reveals one card at a time (what → optional why → action → learning) and the cards
  // differ in height, so after each one renders, lift the panel just enough — never above the top
  // margin — that its bottom keeps a comfortable margin. Horizontal placement is left untouched (no
  // jarring corner hop), and the move is instant so it reads as part of the card's own transition.
  refit() {
    if (!this.panel || this.panel.hidden || !this.pos) return;
    const margin = 18;
    const topMargin = 72;
    const capped = this.panel.style.maxHeight;
    this.panel.style.maxHeight = 'none';
    const natural = this.panel.offsetHeight; // full content height, ignoring the cap and transforms
    this.panel.style.maxHeight = capped;
    const maxTop = Math.max(topMargin, innerHeight - natural - margin);
    if (this.pos.top > maxTop) this.pos.top = maxTop;
    this.applyPosition(true);
  }

  finishCommand(command) {
    if (command?.command_id !== this.activeCommandId) return;
    this.clearHint();
    this.clearEvidenceHighlights();
    this.spotlight.hide();
    this.cursor.hide();
    this.panel.hidden = true;
    this.activeTarget = null;
    this.spotlightRevealed = false;
    this.phase = null;
  }

  toast(message, error = false) {
    const status = this.root.querySelector('#status');
    status.textContent = message;
    status.className = error ? 'error' : '';
    // A problem must never be swallowed by a panel that finishCommand hid between steps: surface the
    // panel so the learner sees what went wrong instead of the demonstration appearing to just stop.
    if (error) { this.host.hidden = false; this.panel.hidden = false; }
  }

  // Confirm newly found evidence in the already-open panel: the current step's card turns
  // into a green "New evidence found" card that animates in, holds briefly, then flips to the next step. The
  // next command (showCommand) is deferred while this plays so the success is seen before advancing.
  celebrate(message = '') {
    // A demonstration narrates its own "What we learned" beat, so it needs no separate confirmation.
    if (this.currentCommand?.mode === 'demonstration') return;
    this.clearHint();
    this.host.hidden = false;
    this.panel.hidden = false;
    this.celebrating = true;
    this.advanceRequested = false;
    this.phase = 'success';
    this.resetCountdown();
    const stage = this.root.querySelector('#stage');
    const eyebrow = this.root.querySelector('#phase-eyebrow');
    stage.hidden = false;
    stage.classList.remove('acting', 'recovery');
    stage.classList.add('success');
    eyebrow.hidden = false;
    eyebrow.innerHTML = '<span class="stage-tick" aria-hidden="true"></span>New evidence found';
    this.root.querySelector('#phase-headline').textContent = message || 'That step is complete.';
    // Replay the entrance animation from a clean state.
    stage.classList.remove('celebrate-in', 'phase-in');
    void stage.offsetWidth;
    stage.classList.add('celebrate-in');
    this.refit();
    clearTimeout(this.celebrateTimer);
    this.celebrateTimer = setTimeout(() => this.finishCelebrate(), 1500);
  }

  // The hold is over: drop the confirmation and render the step that arrived while it was playing.
  // With no next step yet (it is still resolving, or this was the final goal) the card simply stays.
  finishCelebrate() {
    clearTimeout(this.celebrateTimer);
    this.celebrating = false;
    this.advanceRequested = false;
    if (!this.pendingCommand) return;
    const {command, target} = this.pendingCommand;
    this.pendingCommand = null;
    this.showCommand(command, target);
  }

  advanceCelebration() {
    if (!this.celebrating) return false;
    this.advanceRequested = true;
    if (this.pendingCommand) this.finishCelebrate();
    return true;
  }

  stop() {
    this.clearHint();
    this.briefing.close();
    this.clearEvidenceHighlights();
    this.spotlight.hide();
    this.cursor.hide();
    this.panel.hidden = true;
    this.host.hidden = true;
    this.pos = null;
    this.appliedPos = null;
    clearTimeout(this.celebrateTimer);
    this.celebrating = false;
    this.advanceRequested = false;
    this.pendingCommand = null;
    this.root.querySelector('#stage').classList.remove('success', 'celebrate-in', 'recovery');
  }

  static styles = `
    :host { all: initial; position: fixed; z-index: 2147483647; inset: 0; pointer-events: none; font: 14px system-ui,sans-serif; color: #17212b; }
    .panel { pointer-events: auto; position: fixed; z-index:3; top: 0; left: 0; width: min(468px, calc(100vw - 36px)); max-height: calc(100vh - 90px); overflow: auto; box-sizing: border-box; padding: 18px; border: 1px solid #b6c6d6; border-radius: 12px; background: #fff; box-shadow: 0 16px 46px #17212b40; transform: translate(18px, 72px); transition: transform var(--panel-move, .6s) cubic-bezier(.4, 0, .2, 1); will-change: transform; }
    [hidden] { display:none!important; }
    header { display:flex; align-items:center; gap:8px; cursor:grab; touch-action:none; user-select:none; } header.dragging { cursor:grabbing; } header strong { flex:1; } .live-dot { width:9px;height:9px;border-radius:50%;background:#1aa87a;box-shadow:0 0 0 4px #1aa87a22; }
    h2 { margin: 14px 0 8px; font-size: 17px; text-transform: capitalize; } h3 { margin:0 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.045em;color:#3f5060; } p { line-height:1.45; } #mode { color:#536170; font-size:12px; text-transform:uppercase; letter-spacing:.05em; }
    #stage { padding:20px 22px;border:1px solid #bcd3e6;border-left:6px solid #006bb4;border-radius:11px;background:#f1f7fd;box-shadow:0 6px 20px #006bb416; } #stage.acting { border-left-color:#e0a200;background:#fff8e8;box-shadow:0 6px 20px #e0a2001f; }
    .eyebrow { margin:0 0 10px;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#3f6480;font-weight:750; } #phase-headline { margin:0;font-size:20px;line-height:1.38;font-weight:600;letter-spacing:-.01em;color:#0f2231;white-space:pre-line; }
    #stage.phase-in { animation:phase-in .32s cubic-bezier(.22,1,.36,1); } @keyframes phase-in { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:none} }
    .countdown { margin-top:16px;height:7px;border-radius:6px;background:#cfe0ee;overflow:hidden; } .countdown span { display:block;height:100%;width:0;background:#006bb4;border-radius:6px; } #stage.acting .countdown { background:#efdaa6; } #stage.acting .countdown span { background:#d98c00; }
    .countdown.working span { width:34%!important;animation:cd-sweep 1.25s cubic-bezier(.55,0,.45,1) infinite; } @keyframes cd-sweep { 0%{transform:translateX(-115%)} 100%{transform:translateX(310%)} }
    @media (prefers-reduced-motion: reduce) { .countdown.working span { transform:none!important;width:100%!important;opacity:.55; } .countdown span { width:100%!important; } }
    button { border:1px solid #8293a3;border-radius:5px;background:#f5f7f9;padding:6px 9px;cursor:pointer; } button:hover,button:focus-visible { outline:2px solid #006bb4;outline-offset:1px; }
    #stop { color:#a32b1c;border-color:#d77d72; } #advance { margin-left:auto; } .actions { display:flex; gap:7px; margin-top:12px; }
    #hint-card { margin-top:14px;padding:13px 16px 14px;border:1px solid #b8dcea;border-left:4px solid #0874a8;border-radius:9px;background:#f0f8fc;box-shadow:0 4px 14px #0874a812; }
    #hint-label { display:block;color:#08638d;font:700 11px/1.3 system-ui,sans-serif;letter-spacing:.09em;text-transform:uppercase; }
    #hint-text { margin:6px 0 0;color:#173d53;font:500 15px/1.5 'Segoe UI',system-ui,sans-serif;letter-spacing:-.005em;white-space:pre-line; }
    .progress { height:4px;background:#dce4eb;margin:13px 0;border-radius:4px;overflow:hidden; }.progress span { display:block;height:100%;background:#006bb4;transition:width .3s; }
    label { display:block;font-weight:650;margin-top:10px; } input,select,textarea { display:block;width:100%;box-sizing:border-box;margin-top:3px;padding:7px;border:1px solid #9ba9b6;border-radius:4px;font:inherit; } textarea { min-height:58px; }
    #diagnosis button { margin-top:12px;background:#006bb4;color:#fff;border:0; } #status { min-height:18px;color:#147d5c; } #status:empty { display:none; }.error { color:#a32b1c!important; }
    #stage.success { border-left-color:#12a56b;background:#ecf8f2;box-shadow:0 6px 22px #12a56b24; } #stage.success .eyebrow { display:flex;align-items:center;gap:8px;color:#0b7a4f; } #stage.success #phase-headline { color:#0c3d2b; }
    #phase-detail { margin:12px 0 0;color:#3a4d5c;font-size:14px;line-height:1.5;white-space:pre-line; }
    #stage.recovery { border-left-color:#d4602a;background:#fff4ec;box-shadow:0 6px 22px #d4602a24; } #stage.recovery .eyebrow { color:#a8431a; } #stage.recovery #phase-headline { color:#4a1d08;font-size:18px; } #stage.recovery .countdown { background:#f4d6c4; } #stage.recovery .countdown span { background:#d4602a; }
    .stage-tick { flex:0 0 auto;display:inline-block;width:18px;height:18px;border-radius:50%;background:#12a56b;position:relative;transform:none;animation:tick-pop .4s .1s cubic-bezier(.22,1.4,.4,1) both; }
    .stage-tick::after { content:"";position:absolute;left:6px;top:3px;width:4px;height:8px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(42deg); }
    @keyframes tick-pop { from{transform:scale(0)} to{transform:scale(1)} }
    #stage.celebrate-in { animation:celebrate-in .42s cubic-bezier(.22,1,.36,1); } @keyframes celebrate-in { from{opacity:0;transform:translateY(8px) scale(.99)} to{opacity:1;transform:none} }
    .incident-spotlight { position:fixed;z-index:1;display:none;box-sizing:border-box;border:3px solid #ffb000;border-radius:7px;box-shadow:0 0 0 9999px #10182070;pointer-events:none;transition:all .25s; }
    .incident-evidence-highlight { position:fixed;z-index:1;box-sizing:border-box;border:3px solid #ffb000;border-radius:7px;background:#ffb00018;box-shadow:0 0 0 2px #fff8;pointer-events:none;transition:all .25s; }
    .incident-cursor { position:fixed;z-index:2;left:-12px;top:-12px;width:24px;height:24px;opacity:0;pointer-events:none;transition:transform var(--incident-cursor-duration, .65s) cubic-bezier(.4,.1,.6,.9),opacity .15s; }
    .incident-cursor.visible { opacity:1; }.incident-cursor:before { content:'➤';display:block;color:#ffb000;font-size:28px;filter:drop-shadow(0 2px 2px #0008);transform:rotate(-25deg); }
    .incident-cursor span { position:absolute;inset:0;border:2px solid #ffb000;border-radius:50%;opacity:0; }.incident-cursor.clicked span { animation:click-ring .5s; }
    @keyframes click-ring { from{opacity:1;transform:scale(.3)}to{opacity:0;transform:scale(2)} }
    dialog.incident-debrief { pointer-events:auto;width:min(720px,calc(100vw - 48px));max-width:none;max-height:calc(100vh - 48px);overflow:auto;box-sizing:border-box;border:0;border-radius:10px;padding:24px;box-shadow:0 14px 50px #0006;color:#17212b; }.incident-debrief::backdrop{background:#101820aa}.dialog-close{float:right;border:0;font-size:22px}.incident-debrief li{display:flex;justify-content:space-between;padding:5px 0}.incident-debrief .total{font-size:20px;font-weight:750}.incident-debrief .demo-checks{padding-left:20px}.incident-debrief .demo-checks li{display:list-item;padding:5px 0}.incident-debrief .demo-checks p{margin:3px 0}.incident-problem{margin:12px 0 18px;padding:14px 16px;border-left:5px solid #d64a3a;background:#fff3f1;border-radius:6px}.incident-problem strong{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#8c2418}.incident-problem p{margin:5px 0 0;font-size:17px;font-weight:750;line-height:1.4}.incident-conclusion{padding:12px 14px;border-left:4px solid #1aa87a;background:#eef9f5;border-radius:6px}
    .guided-score { margin:18px 0 16px; }
    .guided-score-heading { display:flex;justify-content:space-between;align-items:baseline;margin-bottom:9px;font-size:16px; }
    .guided-score-heading strong:last-child { font-size:24px;font-variant-numeric:tabular-nums; }
    .guided-score-track { position:relative;height:20px;overflow:hidden;border-radius:6px;background:linear-gradient(90deg,#b42318 0%,#d84227 14%,#eb7330 29%,#f2aa38 42%,#e7cf49 53%,#aacc50 67%,#63b65a 82%,#148d61 100%); }
    .guided-score-unearned { position:absolute;top:0;bottom:0;left:var(--score);right:0;background:#e4e9ed; }
    .guided-score-ticks { position:absolute;inset:0;display:flex;justify-content:space-between;pointer-events:none; }
    .guided-score-ticks i { display:block;width:1px;height:100%;background:#fff;box-shadow:0 0 0 1px #17212b66; }
    .guided-score-labels { display:flex;justify-content:space-between;margin-top:5px;color:#536170;font-size:11px;font-variant-numeric:tabular-nums; }
    .incident-debrief .guided-score-rule { margin:10px 0 0;color:#3f5060;font-size:12px; }
    @media (prefers-reduced-motion: reduce) { *, .incident-cursor, .progress span { transition:none!important;animation:none!important; } .stage-tick { transform:none!important; } }
  `;
}

globalThis.IncidentCoachPanel = IncidentCoachPanel;
