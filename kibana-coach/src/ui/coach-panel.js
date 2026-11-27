class IncidentCoachPanel {
  constructor(host) {
    this.host = host;
    this.root = host.attachShadow({mode: 'open'});
    this.root.innerHTML = `<style>${IncidentCoachPanel.styles}</style>
      <aside class="panel" aria-label="Incident coach" hidden>
        <header title="Drag to move the coach"><span class="live-dot"></span><strong>Incident coach</strong><button id="stop" title="Stop automation">Stop</button><button id="fold" type="button" hidden aria-label="Collapse coach" title="Collapse coach">${IncidentCoachPanel.foldIcons.collapse}</button></header>
        <div class="actions"><button id="pause">Pause</button><button id="advance" title="Complete this step now and continue">Advance</button><button id="incident-info" title="Review the initial incident briefing">Incident info</button><button id="hint">Hint</button><button id="demonstrate">Show me</button><button id="review-feedback" hidden>Review feedback</button></div>
        <div class="progress" aria-hidden="true"><span></span></div>
        <div class="step-line"><h2 id="objective"></h2><p id="mode"></p></div>
        <section id="stage" aria-live="polite">
          <p id="phase-eyebrow" class="eyebrow"></p>
          <p id="phase-headline"></p>
          <p id="phase-detail" hidden></p>
          <details id="phase-why" hidden open><summary>Why this step</summary><p id="phase-why-text"></p></details>
          <div id="stage-actions" class="stage-actions" hidden></div>
          <div id="countdown" class="countdown" aria-hidden="true" hidden><span></span></div>
        </section>
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
    // A press inside the coach (Advance, Pause, Hint...) is not a click outside Kibana's open popover.
    // Kibana closes a popover on any mouse event that reaches the document from outside it (verified 9.5.2:
    // pressing Advance while the coach typed into the date box closed the box and failed the step), so the
    // coach's own presses stop at its shadow root. Capture-phase listeners (the step clock's) still see them.
    for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'click']) {
      this.root.addEventListener(type, event => event.stopPropagation());
    }
    this.cursor = new IncidentCursor(this.root);
    this.spotlight = new IncidentSpotlight(this.root);
    this.debrief = new IncidentDebrief(this.root);
    this.briefing = new IncidentBriefing(this.root);
    this.currentBriefing = null;
    this.paused = false;
    // The finished investigation ({mode, until, ended, exploring}), null before it is finished; while
    // exploring, the card can be folded down to its header.
    this.completion = null;
    this.collapsed = false;
    this.activeTarget = null;
    this.activeCommandId = null;
    this.evidenceFields = [];
    this.evidenceTargets = [];
    this.evidenceHighlights = [];
    // Fields the card on screen talks about, and the field its step acts on: their result-table columns
    // are data the learner reads, so the card keeps off them (header and all) without ringing them.
    this.namedFields = [];
    this.stepFields = [];
    // A guided step starts undimmed; the spotlight is only revealed on demonstration or a hint.
    this.spotlightRevealed = false;
    // New evidence is confirmed inside the panel; the next step is held until it finishes.
    this.celebrating = false;
    this.advanceRequested = false;
    this.pendingCommand = null;
    // One thing moves at a time: the card (its text and its place) first, then what it points at. These
    // are when the card's current glide and text entrance end (performance.now() ms), and the tokens that
    // let a later beat cancel a highlight still waiting for the card to settle.
    this.moveEndsAt = 0;
    this.textEndsAt = 0;
    this.targetToken = 0;
    this.presentToken = 0;
    // Evidence rings wait (hidden) until the card has settled beside them; then they arrive.
    this.ringsRevealed = true;
    // The current step's hints: how many there are and how many the learner has seen.
    this.hintState = {used: 0, total: 0};
    // A learner who opens or closes a result card's reasoning has decided: the coach leaves it that way
    // from then on. Null until they do. The card stays where it is until its next beat, so the control
    // doesn't jump away from the pointer that just used it.
    this.reasoningOpen = null;
    const why = this.root.querySelector('#phase-why');
    why.querySelector('summary').addEventListener('click', () => {
      this.reasoningOpen = !why.open;
      this.keepPlace = true;
    });
    why.addEventListener('toggle', () => this.refit());
    const dragHandle = this.root.querySelector('header');
    dragHandle.addEventListener('pointerdown', event => this.startDrag(event));
    dragHandle.addEventListener('pointermove', event => this.moveDrag(event));
    dragHandle.addEventListener('pointerup', event => this.endDrag(event));
    dragHandle.addEventListener('pointercancel', event => this.endDrag(event));
    this.updatePlacement = event => {
      if (this.panel.hidden || this.dragging) return;
      // A result card is being put in place (scroll, one placement, then its rings): it isn't moved again
      // meanwhile, so it travels once, to where it ends up.
      if (this.presenting) {
        this.refreshEvidenceHighlights();
        return;
      }
      const target = this.activeTarget?.isConnected ? this.activeTarget : null;
      // Nothing to dodge — no highlighted control and no open doc-viewer flyout — so leave the
      // card where it rests rather than nudging it for every stray scroll or mutation.
      if (!target && !this.findFlyout() && !this.findPopovers().length && !this.watchingColumns() && !this.evidenceTargets.length && !this.coversQueryBar() && event?.type !== 'resize') return;
      // Highlights follow the page at once, whatever the card does.
      if (target && this.spotlightRevealed && !this.spotlightHeld) this.spotlight.show(target, {arrive: false});
      this.refreshEvidenceHighlights();
      // A popover or flyout that is opening grows over several frames (EUI animates both). Placing the
      // card against a half-drawn one makes it hop twice, so wait until its size holds still for a
      // moment; a few deferrals at most, so a panel that never settles is still dodged.
      const layers = [...this.findPopovers(), this.findFlyout()].filter(Boolean)
        .map(rect => [rect.left, rect.top, rect.width, rect.height].map(value => Math.round(value / 6)).join(',')).join(';');
      if (layers !== this.layerSignature && (this.layerDeferrals || 0) < 4) {
        this.layerSignature = layers;
        this.layerDeferrals = (this.layerDeferrals || 0) + 1;
        clearTimeout(this.layerTimer);
        this.layerTimer = setTimeout(() => this.reposition({type: 'settled'}), 140);
        if (layers) return;
      } else {
        this.layerDeferrals = 0;
      }
      this.placeAwayFrom(target);
    };
    this.reposition = event => {
      if (this.panel.hidden) return;
      // Scroll, resize and DOM mutations share one placement pass. Keep the
      // latest event so a resize is not lost behind an earlier scroll.
      if (event) this.placementEvent = event;
      if (this.repositionFrame) return;
      this.repositionFrame = requestAnimationFrame(() => {
        this.repositionFrame = 0;
        const event = this.placementEvent;
        this.placementEvent = null;
        if (this.mutationPlacement && event?.type !== 'settled') {
          this.mutationPlacement = false;
          const open = !!this.findFlyout();
          const watching = this.activeTarget?.isConnected || this.findPopovers().length || this.watchingColumns() || this.evidenceTargets.length || this.coversQueryBar();
          if (open === this.flyoutOpen && !watching && event?.type !== 'resize') return;
          this.flyoutOpen = open;
        }
        this.updatePlacement(event);
      });
    };
    // Expanding a result opens Kibana's doc-viewer flyout, docked over the right of the screen —
    // exactly where the card usually sits, so it would be hidden underneath. Popovers (the time
    // picker, a field's Top values, Add filter) open over the page the same way, and the step's own
    // control can render — or shift — only after its command arrived, as Discover finishes loading.
    // None of that fires a scroll or resize, so watch the DOM and re-check placement (one frame at a
    // time). placeAwayFrom is sticky, so this only moves the card when it actually covers something
    // the learner needs; the open/closed flag skips the flood of unrelated mutations otherwise.
    this.flyoutObserver = new MutationObserver(() => {
      if (this.panel.hidden) return;
      this.mutationPlacement = true;
      this.reposition();
    });
    this.root.querySelector('#pause').onclick = () => this.setPaused(!this.paused);
    this.root.querySelector('#advance').onclick = () => this.onAdvance?.();
    this.root.querySelector('#hint').onclick = () => this.revealHint();
    this.root.querySelector('#demonstrate').onclick = () => this.onDemonstrate?.();
    this.root.querySelector('#review-feedback').onclick = () => this.onReviewFeedback?.();
    this.root.querySelector('#incident-info').onclick = () => {
      if (this.currentBriefing) this.briefing.show(this.currentBriefing, {review: true});
    };
    this.root.querySelector('#stop').onclick = () => this.onStop?.();
    this.root.querySelector('#fold').onclick = () => this.setCollapsed(!this.collapsed);
    // The placement observers can be off by the time the investigation is finished, so a docked card
    // keeps its corner on its own when the window is resized.
    window.addEventListener('resize', () => { if (this.docked && !this.dragging) this.dock(true); });
    this.root.querySelector('#diagnosis').addEventListener('submit', event => {
      event.preventDefault();
      this.onDiagnosis?.(Object.fromEntries(new FormData(event.target)));
    });
  }

  startObserving() {
    if (!this.observing) {
      this.observing = true;
      window.addEventListener('resize', this.reposition);
      window.addEventListener('scroll', this.reposition, true);
    }
    this.startWatchingMutations();
  }

  startWatchingMutations() {
    if (this.watchingMutations || !document.body) return;
    this.watchingMutations = true;
    this.flyoutObserver.observe(document.body, {childList: true, subtree: true});
  }

  stopWatchingMutations() {
    this.flyoutObserver.disconnect();
    this.watchingMutations = false;
    this.mutationPlacement = false;
  }

  stopObserving() {
    if (!this.observing) return;
    this.observing = false;
    this.stopWatchingMutations();
    window.removeEventListener('resize', this.reposition);
    window.removeEventListener('scroll', this.reposition, true);
    cancelAnimationFrame(this.repositionFrame);
    this.repositionFrame = 0;
    this.placementEvent = null;
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

  showCommand(command, target, {focus = null} = {}) {
    // Hold the next step behind an in-progress confirmation so the learner sees the success land
    // before the card flips to the next task; finishCelebrate() replays this once it settles.
    if (this.celebrating) {
      this.pendingCommand = {command, target, focus};
      if (this.advanceRequested) this.finishCelebrate();
      return;
    }
    this.clearHint();
    this.host.hidden = false;
    // A card coming back between steps appears where it will stay, rather than gliding there from where
    // the last step left it.
    if (this.panel.hidden) this.appearInPlace();
    this.panel.hidden = false;
    this.root.querySelector('#stage').classList.remove('success', 'celebrate-in', 'recovery', 'checkin');
    this.activeCommandId = command.command_id;
    this.activeTarget = target;
    this.evidenceField = null;
    this.clearEvidenceHighlights();
    this.stepFields = IncidentCoachPanel.commandFields(command);
    this.currentCommand = command;
    // A challenge names no steps and shows no progress: the route is the learner's to find, and the
    // debrief scores it afterwards.
    const challenge = command.mode === 'challenge';
    this.root.querySelector('#mode').textContent = challenge ? 'challenge' : `${command.mode} · step ${command.step_index + 1} of ${command.step_count}`;
    this.root.querySelector('#objective').textContent = challenge ? 'Your investigation' : command.step_title || command.step_id.replaceAll('-', ' ');
    this.root.querySelector('.progress').hidden = challenge;
    this.root.querySelector('.progress span').style.width = `${100 * command.step_index / command.step_count}%`;
    this.root.querySelector('#pause').hidden = command.mode !== 'demonstration';
    this.root.querySelector('#demonstrate').hidden = command.mode !== 'guided';
    this.root.querySelector('#review-feedback').hidden = true;
    // The briefing is the problem statement, not help, so a challenge can reread it too.
    this.root.querySelector('#incident-info').hidden = command.mode === 'demonstration' || !this.currentBriefing;
    const advance = this.root.querySelector('#advance');
    advance.hidden = command.mode !== 'demonstration';
    advance.disabled = false;
    advance.textContent = 'Advance';
    advance.title = 'Continue to the next part';
    advance.classList.remove('primary');
    this.root.querySelector('#hint').hidden = command.mode !== 'guided';
    if (command.type === 'request_diagnosis' || command.type === 'request_answer') this.renderAnswerSchema(command.answer_schema);
    this.root.querySelector('#diagnosis').hidden = !['request_diagnosis', 'request_answer'].includes(command.type) || command.mode === 'demonstration';
    // Reveal one beat at a time. A demonstration opens on its intent, then performs
    // the action; other modes show a single card.
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
    // Every card starts with nothing dimmed or highlighted. A control is spotlit only when the coach
    // is about to use it, as the cursor sets off (showTarget), so a highlight never sits waiting for
    // a card's countdown. A guided step is the learner's to solve, so it lights its control only on
    // a hint. `activeTarget` is still stored above: the card keeps clear of the control, and a later
    // hint knows what to point at.
    this.spotlightRevealed = false;
    this.spotlightHeld = false;
    this.targetToken = (this.targetToken || 0) + 1;
    this.spotlight.hide();
    // The same step shown again (after a check-in or a recovery) keeps the hints already seen.
    const used = Number(command.hints_used) || 0;
    this.hintState = {used: this.hintStepId === command.step_id ? Math.max(used, this.hintState?.used || 0) : used, total: Number(command.hint_count) || 0};
    this.hintStepId = command.step_id;
    this.renderHintButton();
    this.liveMoments = command.moments || null;
    // A goal that starts by reading the page (where the histogram rises) rings that: the card is placed
    // clear of the rings before they are drawn, and they arrive once it has settled.
    if (focus) {
      this.showEvidenceHighlights(focus.columns || [], focus.targets || [], focus.fields || [], focus.primaryTargetIndex, {reveal: false});
      requestAnimationFrame(() => this.presentEvidence());
      return;
    }
    requestAnimationFrame(() => this.placeAwayFrom(target));
  }

  // The panel is about to be shown after being hidden: keep it invisible until its first placement, which
  // lands without a glide.
  appearInPlace() {
    this.snapNext = true;
    if (this.panel.style) this.panel.style.visibility = 'hidden';
  }

  // Resolves once the card has finished moving and its text has arrived. A highlight waits for this, so
  // the card and what it points at never move at the same time.
  settled(extra = 40) {
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const wait = reduced ? 0 : Math.max(0, Math.max(this.moveEndsAt || 0, this.textEndsAt || 0) - performance.now());
    return wait ? new Promise(resolve => setTimeout(resolve, wait + extra)) : Promise.resolve();
  }

  // The card is about what its rings show, so when one isn't all on screen the page scrolls. Rings that
  // fit together end up low in the view, which leaves the upper corners clear for the card; otherwise
  // the first clipped one is centred.
  revealEvidence() {
    const elements = this.evidenceTargets.map(target => target()).filter(element => element?.getClientRects().length);
    const clipped = elements.find(element => {
      const rect = element.getBoundingClientRect();
      return !this.cursor.isVisible(element) || (rect.height < innerHeight * 0.7 && (rect.top < 96 || rect.bottom > innerHeight - 8));
    });
    if (!clipped) return false;
    const rects = elements.map(element => element.getBoundingClientRect());
    const fits = Math.max(...rects.map(rect => rect.bottom)) - Math.min(...rects.map(rect => rect.top)) < innerHeight - 140;
    const lowest = elements[rects.reduce((best, rect, index) => rect.bottom > rects[best].bottom ? index : best, 0)];
    const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
    if (fits) {
      lowest.style.scrollMarginBottom = '16px';
      lowest.scrollIntoView({block: 'end', inline: 'nearest', behavior});
    } else {
      clipped.scrollIntoView({block: 'center', inline: 'nearest', behavior});
    }
    return true;
  }

  // Wait for a scroll revealEvidence started to come to rest: the rings' elements hold still for a moment
  // (at most about 1.5 s).
  async evidenceAtRest() {
    const deadline = performance.now() + 1500;
    let previous = '';
    let stillSince = 0;
    while (performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 32));
      const now = this.evidenceTargets.map(target => target()?.getBoundingClientRect()).map(rect => rect ? `${Math.round(rect.left)},${Math.round(rect.top)}` : '-').join(';');
      if (now === previous) {
        stillSince ||= performance.now();
        if (performance.now() - stillSince >= 96) return;
      } else {
        stillSince = 0;
        previous = now;
      }
    }
  }

  // Put a card about evidence in place, once, and only then draw its rings: scroll the evidence into view
  // if it isn't, wait for that to stop, choose the card's spot (next to the data when `seek`), let the card
  // glide there, then let the rings arrive. Nothing else re-places the card meanwhile. A later beat
  // (another card, another step) cancels what is left.
  async presentEvidence({seek = false} = {}) {
    const token = this.presentToken = (this.presentToken || 0) + 1;
    this.presenting = true;
    try {
      if (this.evidenceScrolling) await this.evidenceAtRest();
      this.evidenceScrolling = false;
      if (token !== this.presentToken || this.panel.hidden) return;
      this.seekFocus = seek;
      try { this.placeAwayFrom(null); } finally { this.seekFocus = false; }
    } finally {
      if (token === this.presentToken) this.presenting = false;
    }
    await this.settled();
    if (token !== this.presentToken || this.panel.hidden) return;
    this.revealEvidenceRings();
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

  // The learner's own input left the view unable to answer the step (no results, an earned filter
  // gone, a window that misses the incident). Explain what went wrong. With `choices` (a diagnosed
  // query: Fix my query / Reset search) the learner picks; without, the coach is about to put the
  // search back and Advance ("Restore now") skips the reading countdown.
  showRecovery({eyebrow = 'No results', headline, detail, choices}) {
    clearTimeout(this.celebrateTimer);
    this.celebrating = false;
    this.advanceRequested = false;
    this.clearHint();
    this.spotlight.hide();
    this.cursor.hide();
    this.host.hidden = false;
    this.panel.hidden = false;
    this.phase = 'recovery';
    // A status left from an earlier recovery ("The search is back. Continue…") would contradict this card.
    const status = this.root.querySelector('#status');
    if (!status.classList.contains('error')) this.toast('');
    for (const id of ['#hint', '#demonstrate', '#incident-info', '#pause', '#review-feedback']) this.root.querySelector(id).hidden = true;
    const advance = this.root.querySelector('#advance');
    advance.hidden = Boolean(choices?.length);
    advance.textContent = 'Restore now';
    advance.title = 'Put the search back now';
    const stage = this.root.querySelector('#stage');
    stage.hidden = false;
    stage.classList.remove('success', 'celebrate-in', 'acting', 'result', 'checkin');
    stage.classList.add('recovery');
    if (choices?.length) this.resetCountdown();
    this.renderPhase({eyebrow, headline, detail, choices});
    requestAnimationFrame(() => this.placeAwayFrom(this.activeTarget?.isConnected ? this.activeTarget : null));
  }

  showRecoveryWorking(headline = 'Removing the search that found nothing, and putting back what you had found so far…') {
    this.root.querySelector('#advance').hidden = true;
    this.renderPhase({eyebrow: 'Putting the search back', headline});
    this.startWorking();
  }

  // A soft, non-modal check-in when a guided step has taken a while: the step's title, the most
  // recent drift the service noticed (if any), and Keep going / Give me a hint / Show me.
  showCheckIn({title, drift, choices}) {
    this.clearHint();
    this.host.hidden = false;
    this.panel.hidden = false;
    this.phase = 'checkin';
    for (const id of ['#hint', '#demonstrate', '#advance', '#pause', '#review-feedback']) this.root.querySelector(id).hidden = true;
    const stage = this.root.querySelector('#stage');
    stage.hidden = false;
    stage.classList.remove('success', 'celebrate-in', 'acting', 'result', 'recovery');
    stage.classList.add('checkin');
    this.resetCountdown();
    this.renderPhase({eyebrow: 'Checking in', headline: `Still working on “${title}”?`, detail: drift || '', choices});
    requestAnimationFrame(() => this.placeAwayFrom(this.activeTarget?.isConnected ? this.activeTarget : null));
  }

  showGuidedCompletion() { this.showCompletion('guided'); }

  // The session has its feedback (any mode). The panel stays with Review feedback, so a debrief that was
  // closed can be opened again.
  showCompletion(mode = 'guided') {
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
    this.root.querySelector('#mode').textContent = `${mode} · complete`;
    this.root.querySelector('#objective').textContent = mode === 'demonstration' ? 'Demonstration complete' : 'Investigation complete';
    this.root.querySelector('#pause').hidden = true;
    this.root.querySelector('#advance').hidden = true;
    this.root.querySelector('#hint').hidden = true;
    this.root.querySelector('#demonstrate').hidden = true;
    this.root.querySelector('#review-feedback').hidden = false;
    this.root.querySelector('#incident-info').hidden = !this.currentBriefing;
    this.root.querySelector('#diagnosis').hidden = true;
    this.root.querySelector('#stage').classList.remove('success', 'celebrate-in', 'recovery', 'checkin');
    this.root.querySelector('#stage').hidden = false;
    // Two ways on: stay and explore the investigation's data, or close it and go back to the launcher
    // for another scenario or mode. The debrief offers the same pair.
    const canReturn = Boolean(this.onReturnToMenu);
    this.returning = false;
    this.completion = {mode, until: '', ended: false, exploring: false};
    this.setCollapsed(false);
    this.debrief.onReturnToMenu = canReturn ? () => this.returnToMenu() : null;
    this.debrief.onKeepExploring = canReturn ? () => this.startExploring() : null;
    this.renderPhase({
      eyebrow: 'Finished',
      headline: {
        guided: 'Your guided investigation is complete.',
        challenge: 'Your answer is in.',
        demonstration: 'The demonstration is complete.',
      }[mode] || 'Complete.',
      detail: this.completionDetail(),
      choices: canReturn ? [this.returnChoice()] : [],
    });
    requestAnimationFrame(() => this.placeAwayFrom(null));
  }

  completionDetail() {
    const {mode, until, exploring} = this.completion;
    const recap = mode === 'demonstration' ? 'summary' : 'debrief';
    if (!this.onReturnToMenu) return `Review feedback opens the ${recap} again.`;
    if (exploring) return `${until ? `It stays open until ${until}. ` : ''}Review feedback opens the ${recap} again. When you’re done, close it to choose another scenario or mode.`;
    return `You can keep exploring the data here${until ? ` until ${until}` : ''}. Review feedback opens the ${recap} again. When you’re done, close the investigation to choose another scenario or mode.`;
  }

  returnChoice(label = IncidentCoachPanel.returnLabel) {
    return {id: 'return-to-menu', label, primary: true, onSelect: () => this.returnToMenu()};
  }

  // The learner chose Keep exploring: the coach folds down to its header and docks in the lower-left
  // corner, out of the way. Unfolded (the header's +, as in the Argo CD lab's coach) it is the card that
  // closes the exploration, the same close as the debrief's "Close investigation & return to main menu".
  startExploring() {
    if (!this.completion || this.completion.ended) return;
    this.completion.exploring = true;
    this.root.querySelector('#objective').textContent = 'Incident exploration';
    // Nothing is automated any more: the way out is the close button.
    this.root.querySelector('#stop').hidden = true;
    this.renderPhase({
      eyebrow: 'Exploring',
      headline: 'Explore the incident data on your own.',
      detail: this.completionDetail(),
      choices: this.onReturnToMenu ? [this.returnChoice('Close this incident exploration')] : [],
    });
    this.setCollapsed(true);
  }

  // Fold the card down to its header, or unfold it. Folding docks it in the lower-left corner; it stays
  // docked — unfolded, the card rises from the bar, its bottom kept off the viewport's — until the
  // learner drags it somewhere else or the finished investigation is left behind.
  setCollapsed(collapsed) {
    this.collapsed = collapsed;
    this.panel.classList.toggle('collapsed', collapsed);
    const fold = this.root.querySelector('#fold');
    fold.hidden = !(this.completion?.exploring && !this.completion.ended);
    fold.innerHTML = collapsed ? IncidentCoachPanel.foldIcons.expand : IncidentCoachPanel.foldIcons.collapse;
    fold.setAttribute('aria-label', collapsed ? 'Expand coach' : 'Collapse coach');
    fold.title = collapsed ? 'Expand coach' : 'Collapse coach';
    // Kibana moving underneath doesn't move the card while the learner explores.
    if (this.completion?.exploring) this.keepPlace = true;
    if (collapsed) this.docked = true;
    else if (!this.completion?.exploring && !this.completion?.ended) this.docked = false;
    this.refit();
  }

  // Put the docked card in the lower-left corner, the same margin off the left and bottom edges as the
  // card keeps elsewhere, gliding there (IncidentCoachPanel.dockMotion) unless `instant`.
  dock(instant = false) {
    if (!this.panel || this.panel.hidden) return;
    const margin = 18;
    const capped = this.panel.style.maxHeight;
    this.panel.style.maxHeight = 'none';
    const natural = this.panel.offsetHeight; // full content height, ignoring the cap and transforms
    this.panel.style.maxHeight = capped;
    const target = {left: margin, top: Math.round(Math.max(72, innerHeight - natural - margin))};
    if (this.appliedPos?.left === target.left && this.appliedPos?.top === target.top) return;
    this.pos = target;
    this.applyPosition(instant, IncidentCoachPanel.dockMotion);
  }

  // A finished investigation can be explored until its run is reclaimed, at `until` (a clock time).
  showExplorationDeadline(until) {
    if (!this.completion || this.completion.ended) return;
    this.completion.until = until;
    this.root.querySelector('#phase-detail').textContent = this.completionDetail();
    this.refit();
  }

  // The time for exploring ran out at `endedAt` and the run's data is gone. Any debrief closes; the card
  // says what happened and leads back to the main menu, and a short notice makes sure it isn't missed.
  // Review feedback still works: the debrief is kept by the learning service, not the run.
  showExplorationEnded(endedAt) {
    const recap = this.completion?.mode === 'demonstration' ? 'summary' : 'debrief';
    this.completion = {...(this.completion || {mode: 'guided'}), until: endedAt, ended: true, exploring: false};
    this.setCollapsed(false);
    for (const dialog of this.root.querySelectorAll('dialog.incident-debrief')) dialog.close();
    this.briefing.close();
    this.spotlight.hide();
    this.cursor.hide();
    this.host.hidden = false;
    this.panel.hidden = false;
    this.phase = 'ended';
    this.activeTarget = null;
    this.returning = false;
    const canReturn = Boolean(this.onReturnToMenu);
    this.debrief.onReturnToMenu = canReturn ? () => this.returnToMenu() : null;
    this.root.querySelector('#objective').textContent = 'Investigation closed';
    this.root.querySelector('#mode').textContent = 'time is up';
    this.renderPhase({
      eyebrow: 'Time’s up',
      headline: 'This investigation has closed.',
      detail: `It could be explored until ${endedAt}, and its data has now been removed. Review feedback still opens the ${recap}.`,
      choices: canReturn ? [this.returnChoice('Return to main menu')] : [],
    });
    this.debrief.showTimeUp(endedAt);
    requestAnimationFrame(() => this.placeAwayFrom(null));
  }

  // Close the finished investigation and leave for the launcher. Every return control (the card's and
  // the debrief's) says it's closing, and a second press doesn't start another close.
  returnToMenu() {
    if (this.returning) return;
    this.returning = true;
    const buttons = [...this.root.querySelectorAll('[data-choice="return-to-menu"]')];
    const labels = buttons.map(button => button.textContent);
    for (const button of buttons) {
      button.disabled = true;
      button.textContent = 'Closing investigation…';
    }
    Promise.resolve(this.onReturnToMenu?.()).catch(error => {
      this.returning = false;
      buttons.forEach((button, index) => {
        button.disabled = false;
        button.textContent = labels[index];
      });
      this.toast(error.message, true);
    });
  }

  // The session can't go on: its run ended, was replaced or never became ready, or the service no longer
  // knows it. Nothing further is automated; the card says why and leads back to the launcher.
  showSessionEnded({headline, detail = '', launcherUrl = ''}) {
    clearTimeout(this.celebrateTimer);
    this.celebrating = false;
    this.advanceRequested = false;
    this.pendingCommand = null;
    this.clearHint();
    this.clearEvidenceHighlights();
    this.spotlight.hide();
    this.cursor.hide();
    this.briefing.close();
    this.completion = null;
    this.setCollapsed(false);
    this.host.hidden = false;
    this.panel.hidden = false;
    this.phase = 'ended';
    this.activeTarget = null;
    this.root.querySelector('.progress').hidden = true;
    this.root.querySelector('#mode').textContent = 'session ended';
    this.root.querySelector('#objective').textContent = 'Investigation unavailable';
    for (const id of ['#hint', '#demonstrate', '#advance', '#pause', '#incident-info', '#review-feedback', '#diagnosis']) this.root.querySelector(id).hidden = true;
    const stage = this.root.querySelector('#stage');
    stage.hidden = false;
    stage.classList.remove('success', 'celebrate-in', 'acting', 'result', 'checkin');
    stage.classList.add('recovery');
    this.resetCountdown();
    this.toast('');
    const choices = launcherUrl ? [{id: 'launcher', label: 'Return to the launcher', primary: true, onSelect: () => location.assign(launcherUrl)}] : [];
    this.renderPhase({eyebrow: 'Session ended', headline, detail, choices});
    requestAnimationFrame(() => this.placeAwayFrom(null));
  }

  // A hint in guided mode asks the service for the next worded hint and, once that is on the card and
  // the card has settled, dims the page and highlights the control the step is about. The highlight goes
  // as soon as the learner does something on the page: it was a pointer, and they have followed it.
  revealHint() {
    if (this.hintState.total && this.hintState.used >= this.hintState.total) return;
    this.hintSpotlightWanted = true;
    clearTimeout(this.hintSpotlightTimer);
    // Should the reply not come, light the control anyway after a moment.
    this.hintSpotlightTimer = setTimeout(() => this.lightHintTarget(), 1500);
    this.onHint?.();
  }

  showHint(hint) {
    // A reply can arrive after the learner has moved to another card or step.
    if (this.panel.hidden || this.phase ||
        !['guided', 'challenge'].includes(this.currentCommand?.mode) ||
        hint.step_id !== this.currentCommand.step_id) return;
    const total = Number(hint.total) || this.hintState.total;
    this.hintState = {used: Math.max(this.hintState.used, Number(hint.level) || 0), total};
    this.renderHintButton();
    this.root.querySelector('#hint-label').textContent = hint.level > 0 ? (total ? `Hint ${hint.level} of ${total}` : `Hint ${hint.level}`) : 'Hint';
    this.setLiveText(this.root.querySelector('#hint-text'), hint.text);
    this.root.querySelector('#hint-card').hidden = false;
    this.textEndsAt = performance.now() + 320;
    this.refit();
    this.placeAwayFrom(this.activeTarget?.isConnected ? this.activeTarget : null);
    clearTimeout(this.hintSpotlightTimer);
    this.settled().then(() => this.lightHintTarget());
  }

  // The hint's highlight on the step's control, once the card has settled. One press or key on the page
  // (not on the coach) puts it out.
  lightHintTarget() {
    clearTimeout(this.hintSpotlightTimer);
    if (!this.hintSpotlightWanted) return;
    this.hintSpotlightWanted = false;
    if (this.panel.hidden || this.phase || !this.activeTarget?.isConnected) return;
    this.spotlightRevealed = true;
    this.spotlightHeld = false;
    this.spotlight.show(this.activeTarget);
    this.watchHintDismissal();
  }

  watchHintDismissal() {
    this.stopHintDismissal();
    const dismiss = event => {
      if (event.composedPath?.().includes(this.host)) return;
      this.stopHintDismissal();
      if (!this.spotlightRevealed || this.phase) return;
      this.spotlightRevealed = false;
      this.spotlight.hide();
    };
    this.hintDismissal = dismiss;
    for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, dismiss, true);
  }

  stopHintDismissal() {
    if (!this.hintDismissal) return;
    for (const type of ['pointerdown', 'keydown']) document.removeEventListener(type, this.hintDismissal, true);
    this.hintDismissal = null;
  }

  // The Hint button shows how many of the step's hints are used (filled dots) and how many are left, and
  // turns off once all of them have been shown.
  renderHintButton() {
    const button = this.root.querySelector('#hint');
    if (!button) return;
    const {used, total} = this.hintState || {used: 0, total: 0};
    const left = Math.max(0, total - used);
    const exhausted = total > 0 && left === 0;
    button.disabled = exhausted;
    button.title = !total ? 'Get a hint for this step' : exhausted ? 'No hints left for this step' : `${left} hint${left === 1 ? '' : 's'} left for this step`;
    button.setAttribute?.('aria-label', total ? `Hint, ${used} of ${total} used` : 'Hint');
    if (typeof button.replaceChildren !== 'function') return;
    const label = document.createElement('span');
    label.textContent = 'Hint';
    const pips = document.createElement('span');
    pips.className = 'hint-pips';
    pips.setAttribute('aria-hidden', 'true');
    for (let index = 0; index < total; index += 1) {
      const pip = document.createElement('i');
      if (index < used) pip.className = 'used';
      pips.append(pip);
    }
    button.replaceChildren(label, ...(total ? [pips] : []));
  }

  hintsLeft() {
    const {used, total} = this.hintState || {used: 0, total: 0};
    return !total || used < total;
  }

  clearHint() {
    this.root.querySelector('#hint-card').hidden = true;
    this.root.querySelector('#hint-label').textContent = '';
    this.root.querySelector('#hint-text').textContent = '';
    this.hintSpotlightWanted = false;
    clearTimeout(this.hintSpotlightTimer);
    this.stopHintDismissal?.();
  }

  // The demonstration shows a one-line goal, performs the action, then says what the result shows
  // with the evidence ringed on the page. Guided "Show me" starts at the action, so it has had no goal
  // card to give the motive on: its result card adds why the step is done under the finding.
  enterPhase(phase, command = this.currentCommand, evidence = null) {
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
    } else if (phase === 'action') {
      // Nothing is lit yet: the first control lights up as the cursor sets off for it, and showTarget
      // replaces this line with what the coach does there.
      this.renderPhase({eyebrow: 'Doing it now', headline: 'Finding the control to use…'});
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
      const [finding, support] = IncidentCoachPanel.splitFinding(command?.evidence || 'Step complete.');
      this.renderPhase({eyebrow: 'What this shows', headline: finding, detail: support, why: command?.mode === 'guided' ? command.reasoning : ''});
      this.resetCountdown();
      // The rings arrive only once the card has settled beside them (presentEvidence).
      this.showEvidenceHighlights(evidence?.columns ?? command?.learning_focus ?? [], evidence?.targets || [], evidence?.fields || [], evidence?.primaryTargetIndex, {reveal: false});
      this.evidenceScrolling = this.revealEvidence();
    }
  }

  // A result card leads with its first sentence, the finding, and sets what follows it quieter, so a
  // long result still scans.
  static splitFinding(text) {
    const end = text.search(/[.!?]\s+\S/);
    return end < 0 ? [text, ''] : [text.slice(0, end + 1), text.slice(end + 1).trim()];
  }

  // "Show me" on a guided step starts the action right away, then explains it after the result.
  // Hint and Show me are moot while the coach acts.
  beginWalkthrough(command) {
    this.root.querySelector('#demonstrate').hidden = true;
    this.root.querySelector('#hint').hidden = true;
    this.root.querySelector('#incident-info').hidden = true;
    this.root.querySelector('#advance').hidden = false;
    // As in a demonstration, a control lights up only as the cursor sets off for it (showTarget), so
    // a hint's spotlight goes out until then.
    this.spotlightRevealed = false;
    this.targetToken = (this.targetToken || 0) + 1;
    this.stopHintDismissal();
    this.spotlight.hide();
    this.enterPhase('action', command);
    requestAnimationFrame(() => this.placeAwayFrom(this.activeTarget));
  }

  beginActionPhase(command = this.currentCommand) { this.enterPhase('action', command); }

  // A goal that starts by reading the page rings what to read while its one line is on screen. The
  // action phase clears the rings when the coach starts acting.
  showGoalFocus(evidence) {
    this.showEvidenceHighlights(evidence?.columns || [], evidence?.targets || [], evidence?.fields || [], evidence?.primaryTargetIndex, {reveal: false});
    requestAnimationFrame(() => this.presentEvidence());
  }

  // A step's result, in a demonstration or a guided "Show me": what the action revealed, with that
  // evidence ringed on the page.
  // Reading a result is where the inference happens, so this card has no countdown — it waits for
  // Continue, and Pause has nothing to hold.
  showResult(command, evidence) {
    this.enterPhase('learning', command, evidence);
    this.root.querySelector('#pause').hidden = true;
    const advance = this.root.querySelector('#advance');
    advance.disabled = false;
    advance.textContent = 'Continue';
    advance.title = 'Continue to the next step';
    advance.classList.add('primary');
    // Reading a result means looking from the card to its rings and back, so once the page has settled
    // (the rings scrolled into view) the card goes next to them when it sits far away, in the same single
    // move that clears them. It moves only for a long look across the screen: a card that hops for every
    // few pixels takes the Continue button with it.
    requestAnimationFrame(() => this.presentEvidence({seek: true}));
  }

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

  renderPhase({eyebrow = '', headline = '', detail = '', why = '', choices = []}) {
    const stage = this.root.querySelector('#stage');
    const eyebrowEl = this.root.querySelector('#phase-eyebrow');
    eyebrowEl.textContent = eyebrow;
    eyebrowEl.hidden = !eyebrow;
    this.setLiveText(this.root.querySelector('#phase-headline'), headline);
    const detailEl = this.root.querySelector('#phase-detail');
    this.setLiveText(detailEl, detail);
    detailEl.hidden = !detail;
    this.textEndsAt = performance.now() + 320;
    this.setReasoning(why);
    this.renderChoices(choices);
    if (this.phase !== 'recovery') stage.classList.remove('recovery');
    if (this.phase !== 'checkin') stage.classList.remove('checkin');
    stage.classList.toggle('acting', this.phase === 'action');
    stage.classList.toggle('result', this.phase === 'learning');
    stage.classList.remove('phase-in');
    void stage.offsetWidth;
    stage.classList.add('phase-in');
    this.refit();
  }

  // Text that says how long ago a moment was ("noticed at 12:18 (13 minutes ago)") goes stale while the
  // card stays up, and a learner can come back to an investigation hours later. Such text is kept as
  // written and shown with each "N minutes ago" worked out afresh, now and every 15 s after.
  setLiveText(element, text = '') {
    if (!element) return;
    const source = String(text ?? '');
    const live = IncidentCoachPanel.LIVE_AGO.test(source);
    IncidentCoachPanel.LIVE_AGO.lastIndex = 0;
    element.textContent = live ? IncidentCoachPanel.liveAgo(source, this.liveMoments) : source;
    if (!this.liveElements) this.liveElements = new Map();
    if (live) this.liveElements.set(element, source);
    else this.liveElements.delete(element);
    if (this.liveElements.size && !this.liveTimer) {
      this.liveTimer = setInterval(() => this.refreshLiveText(), 15000);
    } else if (!this.liveElements.size && this.liveTimer) {
      clearInterval(this.liveTimer);
      this.liveTimer = null;
    }
  }

  refreshLiveText() {
    for (const [element, source] of this.liveElements || []) {
      if (element.isConnected === false) continue;
      const text = IncidentCoachPanel.liveAgo(source, this.liveMoments);
      if (element.textContent !== text) element.textContent = text;
    }
  }

  // A clock time followed by how long ago it was ("12:18 (13 minutes ago)", "12:18 UTC (just now)").
  static LIVE_AGO = /\b([01]?\d|2[0-3]):([0-5]\d)( UTC)? \((?:\d+ minutes? ago|just now)\)/g;

  // `text` with each such "N minutes ago" counted to `now`. The service sends the exact instant behind
  // each clock time it wrote (`moments`: {"12:18": ISO}); without one, the clock time is read as the
  // latest such time today (yesterday's, when that is still ahead).
  static liveAgo(text, moments = null, now = Date.now()) {
    return String(text ?? '').replace(IncidentCoachPanel.LIVE_AGO, (match, hours, minutes, utc) => {
      const clock = `${hours.padStart(2, '0')}:${minutes}${utc || ''}`;
      let at = Date.parse(moments?.[clock] ?? moments?.[`${hours}:${minutes}${utc || ''}`] ?? '');
      if (Number.isNaN(at)) {
        const day = new Date(now);
        if (utc) day.setUTCHours(Number(hours), Number(minutes), 0, 0);
        else day.setHours(Number(hours), Number(minutes), 0, 0);
        at = day.getTime();
        if (at - now > 60_000) at -= 86_400_000;
      }
      const elapsed = Math.round((now - at) / 60_000);
      const ago = elapsed < 1 ? 'just now' : elapsed === 1 ? '1 minute ago' : `${elapsed} minutes ago`;
      return `${hours}:${minutes}${utc || ''} (${ago})`;
    });
  }

  // Why the step is done, under its finding. Open unless the learner closed it or it doesn't fit.
  setReasoning(text = '') {
    this.keepPlace = false;
    const why = this.root.querySelector('#phase-why');
    this.root.querySelector('#phase-why-text').textContent = text;
    why.hidden = !text;
    if (text) why.open = this.reasoningOpen ?? true;
  }

  // Close the reasoning to make the card shorter. False when that wouldn't change anything, or the
  // learner has said they want it as it is.
  foldReasoning() {
    const why = this.root.querySelector('#phase-why');
    if (why.hidden || !why.open || this.reasoningOpen !== null) return false;
    why.open = false;
    this.refit();
    return true;
  }

  // Buttons inside the stage card for a decision the card asks for: [{label, primary, onSelect}].
  renderChoices(choices = []) {
    const container = this.root.querySelector('#stage-actions');
    container.replaceChildren(...choices.map(choice => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = choice.label;
      if (choice.id) button.dataset.choice = choice.id;
      if (choice.primary) button.className = 'primary';
      button.onclick = () => choice.onSelect?.();
      return button;
    }));
    container.hidden = !choices.length;
  }

  // The coach is about to act on `target`. The card says so and gets out of the way first; only once it
  // has settled does the control light up (and the caller's cursor set off), so the card and the highlight
  // never move at once. Resolves when the control is lit. `arrive: false` moves a highlight that is already
  // up straight to the next control without replaying its entrance (one pin after another).
  showTarget(target, activity = '', {arrive = true} = {}) {
    this.activeTarget = target;
    // The caption may already be up (set before the control was scrolled into view); re-rendering
    // it would replay the card's entrance for the same words.
    if (activity && !(this.phase === 'action' && this.root.querySelector('#phase-headline').textContent === activity)) {
      this.phase = 'action';
      this.renderPhase({eyebrow: 'Doing it now', headline: activity});
      if (!this.root.querySelector('#countdown').classList.contains('working')) this.startWorking();
    }
    const token = this.targetToken = (this.targetToken || 0) + 1;
    if (!target) return Promise.resolve();
    // The coach is acting on this control (a demonstration or a "Show me"), so the spotlight is shown
    // and stays revealed for repositioning on scroll/resize. A highlight on another control goes now.
    const gliding = !arrive && this.spotlight.target && this.spotlight.target !== target;
    if (this.spotlight.target && this.spotlight.target !== target && !gliding) this.spotlight.hide();
    this.spotlightRevealed = true;
    this.spotlightHeld = true;
    this.placeAwayFrom(target);
    return this.settled().then(() => {
      if (token !== this.targetToken || this.activeTarget !== target || !this.spotlightRevealed) return;
      this.spotlightHeld = false;
      this.spotlight.show(target, {arrive: !gliding});
    });
  }

  clearActionTarget() {
    this.targetToken = (this.targetToken || 0) + 1;
    this.spotlightRevealed = false;
    this.spotlightHeld = false;
    this.spotlight.hide();
    this.cursor.hide();
    this.activeTarget = null;
  }

  showInfo(target, activity) {
    this.phase = 'info';
    this.resetCountdown();
    this.renderPhase({eyebrow: 'Note', headline: activity});
    this.root.querySelector('#advance').title = 'Continue after reading this note';
    return this.showTarget(target);
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

  setAdvancePending(pending) {
    const advance = this.root.querySelector('#advance');
    advance.disabled = pending;
    advance.textContent = pending ? 'Advancing when ready…' : 'Advance';
    advance.title = pending ? 'The coach will continue when this action finishes' : 'Continue to the next part';
  }

  // Kibana's flyouts dock over the right of the screen: the expanded document, APM's span details, a
  // host's details, an alert's details, the panel inspector. What is in them is what a step is about,
  // so return the widest open one's rectangle for placement to treat as a keep-out, like a highlighted
  // control; null when there's no flyout to dodge.
  findFlyout() {
    const rects = [...document.querySelectorAll("[data-test-subj='docViewerFlyout'], .euiFlyout")]
      .map(node => node.getBoundingClientRect())
      .filter(rect => rect.width >= 40 && rect.height >= 40);
    return rects.sort((left, right) => right.width - left.width)[0] || null;
  }

  // Kibana's open popovers — the time picker, a field's Top values, Add filter, combo-box option
  // lists. Whatever the learner has open is what they are working in, so it is a keep-out region.
  findPopovers() {
    return [...document.querySelectorAll('[data-popover-panel], .euiPopover__panel, .euiComboBoxOptionsList')]
      .map(node => node.getBoundingClientRect())
      .filter(rect => rect.width >= 40 && rect.height >= 40 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth);
  }

  // A column being read runs from its header to the bottom of the view, so the card must stay off all
  // of it: the column just added, and every result-table column a result card rings.
  // A field the card or its step names (a pinned row in the document, a Top values list, the field the
  // step filters on) is also a result-table column a learner reads down to compare rows, so that whole
  // column stays clear too, though only the evidence itself is ringed.
  evidenceColumnRects(fields = this.protectedFields()) {
    const headers = [...document.querySelectorAll("[role='columnheader'], th")];
    return fields.map(field => headers.find(node => node.textContent?.trim() === field)
      || headers.find(node => node.textContent?.trim().includes(field)))
      .filter(Boolean)
      .map(header => header.getBoundingClientRect())
      .filter(rect => rect.width && rect.right > 0 && rect.left < innerWidth)
      .map(rect => ({left: rect.left - 24, right: rect.right + 24, top: rect.top - 24, bottom: innerHeight}));
  }

  // The ringed columns (and the column just added), which are what a result card points at.
  ringedFields() {
    return [...new Set([this.evidenceField, ...(this.evidenceFields || [])].filter(Boolean))];
  }

  protectedFields() {
    return [...new Set([...this.ringedFields(), ...(this.namedFields || []), ...(this.stepFields || [])].filter(Boolean))];
  }

  watchingColumns() {
    return this.protectedFields().length > 0;
  }

  // The field names a command acts on: {field} or {fields: [...]} in its value.
  static commandFields(command) {
    const value = command?.value;
    if (!value || typeof value !== 'object') return [];
    return [value.field, ...(Array.isArray(value.fields) ? value.fields : [])].filter(field => typeof field === 'string' && field && field !== '@timestamp');
  }

  clearEvidenceHighlights() {
    for (const highlight of this.evidenceHighlights || []) highlight.remove();
    this.evidenceHighlights = [];
    this.evidenceFields = [];
    this.evidenceTargets = [];
    this.namedFields = [];
  }

  // Ring the evidence a result card talks about: result-table columns (`fields`, drawn down to the
  // bottom of the view) and page elements (`targets`, functions returning the live element). `named`
  // are the fields the card talks about, whose columns the card keeps clear of without ringing them.
  showEvidenceHighlights(fields, targets = [], named = [], primaryTargetIndex = -1, {reveal = true} = {}) {
    this.clearEvidenceHighlights();
    this.ringsRevealed = reveal;
    this.evidenceFields = Array.isArray(fields) ? fields : [];
    this.evidenceTargets = targets.filter(Boolean);
    this.evidencePrimaryIndex = primaryTargetIndex;
    this.namedFields = Array.isArray(named) ? named.filter(field => typeof field === 'string' && field) : [];
    for (let index = 0; index < this.evidenceFields.length + this.evidenceTargets.length; index += 1) {
      const highlight = document.createElement('div');
      // On a busy page the eye needs a cue to find the ring, so each one arrives once (`.entering`):
      // wide, closing in on its evidence, then a single pulse. Rings follow one another in the order
      // given. A ring whose element is off screen plays its entrance when it is scrolled into view.
      highlight.className = `incident-evidence-highlight${reveal ? ' entering' : ''}${index === this.evidenceFields.length + primaryTargetIndex && primaryTargetIndex >= 0 ? ' primary' : ''}`;
      highlight.hidden = !reveal;
      highlight.style.setProperty('--ring-delay', `${index * 110}ms`);
      highlight.addEventListener('animationend', event => {
        if (event.animationName === 'ring-pulse' || event.animationName === 'ring-fade') highlight.classList.remove('entering');
      });
      highlight.setAttribute('aria-hidden', 'true');
      this.root.append(highlight);
      this.evidenceHighlights.push(highlight);
    }
    this.refreshEvidenceHighlights();
  }

  // The rings registered hidden (showEvidenceHighlights with reveal false) arrive now, one after another.
  revealEvidenceRings() {
    if (this.ringsRevealed) return;
    this.ringsRevealed = true;
    for (const highlight of this.evidenceHighlights || []) highlight.classList.add('entering');
    this.refreshEvidenceHighlights();
  }

  // The on-screen rectangles of the ringed page elements; a target that is gone or off-screen is skipped.
  evidenceTargetRects() {
    return this.evidenceTargets.map(target => {
      const rect = target()?.getBoundingClientRect();
      return rect && rect.width && rect.height && rect.bottom > 0 && rect.top < innerHeight ? rect : null;
    });
  }

  refreshEvidenceHighlights() {
    if (!this.evidenceFields?.length && !this.evidenceTargets?.length) return;
    const headers = [...document.querySelectorAll("[role='columnheader'], th")];
    for (const [index, field] of this.evidenceFields.entries()) {
      const highlight = this.evidenceHighlights[index];
      const header = headers.find(node => node.textContent?.trim().includes(field));
      const rect = header?.getBoundingClientRect();
      const left = Math.max(0, rect?.left ?? 0);
      const right = Math.min(innerWidth, rect?.right ?? 0);
      const top = Math.max(0, rect?.top ?? 0);
      highlight.hidden = !this.ringsRevealed || !rect || right <= left || top >= innerHeight - 48;
      if (!highlight.hidden) IncidentCoachPanel.placeHighlight(highlight, left, top, right - left, innerHeight - top - 48);
    }
    const kinds = this.evidenceTargets.map((_, index) => (index === this.evidencePrimaryIndex ? 'primary' : ''));
    for (const [index, box] of IncidentCoachPanel.ringBoxes(this.evidenceTargetRects(), undefined, undefined, kinds).entries()) {
      const highlight = this.evidenceHighlights[this.evidenceFields.length + index];
      highlight.hidden = !box || !this.ringsRevealed;
      if (box) IncidentCoachPanel.placeHighlight(highlight, box.left, box.top, box.right - box.left, box.bottom - box.top);
    }
  }

  // Set a ring's box one property at a time, so its other inline styles (its entrance delay) stay.
  static placeHighlight(highlight, left, top, width, height) {
    Object.assign(highlight.style, {left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`});
  }

  // Rings around page elements, `pad` px outside each. Elements that sit next to each other (the
  // inspect step pins its fields into adjacent doc-viewer rows) share one ring around them all: the
  // group's first element gets the ring and the others null, so the eye reads one block of evidence,
  // not a stack of boxes. Next to each other means stacked (mostly the same columns, at most `join` px
  // apart) or side by side (mostly the same rows, at most `join` px apart). Elements that overlap each
  // other (one drawn inside another) keep their own rings, and so do elements of different `kinds`
  // (the primary ring has its own colour). Null rects stay null.
  static ringBoxes(rects, pad = 5, join = 8, kinds = []) {
    const group = rects.map((_, index) => index);
    const root = index => (group[index] === index ? index : (group[index] = root(group[index])));
    const neighbours = (a, b) => {
      const across = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const down = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      // Kibana's rows share a 1px border, so a sliver of overlap still counts as touching.
      if (across > 2 && down > 2) return false;
      const width = Math.min(a.right - a.left, b.right - b.left);
      const height = Math.min(a.bottom - a.top, b.bottom - b.top);
      return (across >= width / 2 && -down <= join) || (down >= height / 2 && -across <= join);
    };
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        if (!rects[i] || !rects[j] || (kinds[i] || '') !== (kinds[j] || '') || !neighbours(rects[i], rects[j])) continue;
        const [a, b] = [root(i), root(j)];
        group[Math.max(a, b)] = Math.min(a, b);
      }
    }
    const boxes = rects.map(() => null);
    for (const [index, rect] of rects.entries()) {
      if (!rect) continue;
      const lead = root(index);
      const box = boxes[lead];
      boxes[lead] = box
        ? {left: Math.min(box.left, rect.left - pad), top: Math.min(box.top, rect.top - pad), right: Math.max(box.right, rect.right + pad), bottom: Math.max(box.bottom, rect.bottom + pad)}
        : {left: rect.left - pad, top: rect.top - pad, right: rect.right + pad, bottom: rect.bottom + pad};
    }
    return boxes;
  }

  clampPosition(left, top, width, height) {
    return {
      left: Math.round(Math.max(18, Math.min(left, Math.max(18, innerWidth - width - 18)))),
      top: Math.round(Math.max(72, Math.min(top, Math.max(72, innerHeight - Math.min(height, innerHeight - 90) - 18)))),
    };
  }

  startDrag(event) {
    if (event.button !== 0 || event.target.closest('button') || this.panel.hidden) return;
    event.preventDefault();
    const handle = this.root.querySelector('header');
    handle.setPointerCapture(event.pointerId);
    const rect = this.panel.getBoundingClientRect();
    this.dragging = {pointerId: event.pointerId, x: event.clientX - rect.left, y: event.clientY - rect.top,
      width: rect.width, height: rect.height, pending: null, from: this.pos && {...this.pos}};
    this.panel.style.transition = 'none';
    handle.classList.add('dragging');
  }

  moveDrag(event) {
    if (this.dragging?.pointerId !== event.pointerId) return;
    this.dragging.pending = {left: event.clientX - this.dragging.x, top: event.clientY - this.dragging.y};
    if (this.dragFrame) return;
    this.dragFrame = requestAnimationFrame(() => {
      this.dragFrame = 0;
      this.flushDrag();
    });
  }

  flushDrag() {
    const drag = this.dragging;
    if (!drag?.pending) return;
    this.pos = this.clampPosition(drag.pending.left, drag.pending.top, drag.width, drag.height);
    drag.pending = null;
    this.applyPosition(true);
  }

  endDrag(event) {
    if (this.dragging?.pointerId !== event.pointerId) return;
    if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
      this.dragging.pending = {left: event.clientX - this.dragging.x, top: event.clientY - this.dragging.y};
    }
    cancelAnimationFrame(this.dragFrame);
    this.dragFrame = 0;
    this.flushDrag();
    // Dragged somewhere else (not just a press on the header), the card stays where the learner put it.
    const from = this.dragging.from;
    if (this.docked && (!from || from.left !== this.pos?.left || from.top !== this.pos?.top)) this.docked = false;
    this.dragging = null;
    const handle = this.root.querySelector('header');
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    handle.classList.remove('dragging');
    this.panel.style.transition = '';
    this.placeAwayFrom(this.activeTarget?.isConnected ? this.activeTarget : null);
  }

  // The card sits over Kibana's query bar row (it can render after the card first appears).
  coversQueryBar() {
    if (this.panel.hidden || this.dragging) return false;
    const card = this.panel.getBoundingClientRect();
    return [...document.querySelectorAll("[data-test-subj='globalQueryBar'], [data-test-subj='unifiedQueryInput']")].some(node => {
      const bar = node.getBoundingClientRect();
      return bar.width && bar.top < innerHeight / 2 && card.left < bar.right && card.right > bar.left && card.top < bar.bottom && card.bottom > bar.top;
    });
  }

  // Stay put unless the current spot would actually cover the highlighted control or the open
  // doc-viewer flyout (or fell off-screen). Only then glide to the least-disruptive clear spot: a screen
  // corner, or a spot right beside what the step is about, nearest first, so the learner reads the card
  // and the page without looking across the whole screen. Needless hops are jarring.
  placeAwayFrom(target) {
    // A card coming back between steps (appearInPlace) stays invisible until this first placement has
    // put it where it belongs, then shows there without a glide, whichever way the placement ends.
    const appearing = Boolean(this.snapNext);
    try {
      this.placeCard(target);
    } finally {
      if (appearing && !this.panel.hidden) {
        this.snapNext = false;
        this.panel.style.visibility = '';
      }
    }
  }

  placeCard(target) {
    if (this.panel.hidden || this.dragging || this.keepPlace) return;
    // A null pos means the panel was just revealed: snap to the resting spot instead of gliding
    // there from the CSS default corner (the load-time jerk/reflow). So does a card coming back between
    // steps (appearInPlace). Later moves stay animated.
    const firstPlacement = !this.pos || Boolean(this.snapNext);
    const margin = 18;
    const topMargin = 72;
    const panelRect = this.panel.getBoundingClientRect();
    const width = panelRect.width;
    const height = Math.min(panelRect.height, innerHeight - topMargin - margin);
    const maxLeft = Math.max(margin, innerWidth - width - margin);
    const maxTop = Math.max(topMargin, innerHeight - height - margin);
    const clamp = position => ({
      left: Math.round(Math.max(margin, Math.min(position.left, maxLeft))),
      top: Math.round(Math.max(topMargin, Math.min(position.top, maxTop))),
    });
    // Kibana's query bar row holds the search, filters and time picker every investigation starts
    // from, so the card never rests over it: with nothing else to dodge (a challenge has no step
    // target) it sits just below it on the right rather than covering the time picker.
    const queryBar = [...document.querySelectorAll("[data-test-subj='globalQueryBar'], [data-test-subj='unifiedQueryInput']")]
      .map(node => node.getBoundingClientRect()).find(rect => rect.width && rect.bottom > 0 && rect.top < innerHeight / 2);
    const belowBar = queryBar ? Math.min(Math.round(queryBar.bottom) + 10, maxTop) : null;
    const corners = [
      ...(belowBar == null ? [] : [{left: maxLeft, top: belowBar}, {left: margin, top: belowBar}]),
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
    // them, so an open flyout on the right pushes the card to a clear spot on the left.
    const guards = [];
    // What the card is about, which it should sit beside: the control in use, the ringed evidence and
    // the ringed columns' headers (each with the keep-out ring around it). `data` is the part of it that
    // is data to read (a document's rows, a table column, a Top values list, a flyout), as opposed to a
    // control such as a filter pill or the hit count: only data is worth moving the card for unasked.
    const focus = [];
    const data = [];
    if (targetRect && targetRect.width) {
      const guard = {left: targetRect.left - lead, right: targetRect.right + lead, top: targetRect.top - lead, bottom: targetRect.bottom + lead};
      guards.push(guard);
      focus.push(guard);
    }
    // When every corner covers something, what a step is about comes first: the query bar is the one
    // keep-out the card may sit over, so it only decides between corners that cover the rest equally.
    if (queryBar) guards.push({left: queryBar.left, right: queryBar.right, top: queryBar.top, bottom: queryBar.bottom, yields: true});
    const flyoutRect = this.findFlyout();
    if (flyoutRect) {
      // The flyout's own controls (a document's pin buttons) sit at its left edge, and the coach keeps a
      // lead ring around a control it is about to use; leaving that much room beside the flyout now saves
      // a second hop when the first pin lights up.
      guards.push({left: flyoutRect.left - lead, right: flyoutRect.right, top: flyoutRect.top, bottom: flyoutRect.bottom});
    }
    guards.push(...this.evidenceColumnRects());
    for (const column of this.evidenceColumnRects(this.ringedFields())) {
      const box = {...column, bottom: Math.min(column.bottom, column.top + 120)};
      focus.push(box);
      data.push(box);
    }
    const pad = 16;
    const rings = this.evidenceTargetRects();
    for (const [index, rect] of rings.entries()) {
      if (!rect) continue;
      const guard = {left: rect.left - pad, right: rect.right + pad, top: rect.top - pad, bottom: rect.bottom + pad};
      guards.push(guard);
      focus.push(guard);
      if (this.isDataEvidence(index)) data.push(guard);
    }
    // An open popover (a field's Top values, a pill's menu) is what the learner is working in: kept clear,
    // and somewhere to sit beside.
    for (const rect of this.findPopovers()) {
      const guard = {left: rect.left - pad, right: rect.right + pad, top: rect.top - pad, bottom: rect.bottom + pad};
      guards.push(guard);
      focus.push(guard);
    }
    // An open flyout holds what the step is about (the expanded document, a span's details), so with
    // nothing more precise to sit beside, the card sits beside the flyout rather than across the screen.
    if (!focus.length && flyoutRect) focus.push({left: flyoutRect.left, right: flyoutRect.right, top: flyoutRect.top, bottom: flyoutRect.bottom});
    // How much of each keep-out a position hides, as a share of that keep-out: hiding all of a thin
    // row is far worse than clipping the edge of a large chart, though it covers fewer pixels.
    const covered = (position, counted) => {
      const right = position.left + width;
      const bottom = position.top + height;
      let share = 0;
      for (const guard of guards.filter(counted)) {
        const w = Math.max(0, Math.min(right, guard.right) - Math.max(position.left, guard.left));
        const h = Math.max(0, Math.min(bottom, guard.bottom) - Math.max(position.top, guard.top));
        share += (w * h) / Math.max(1, (guard.right - guard.left) * (guard.bottom - guard.top));
      }
      return share;
    };
    const coveredEvidence = position => covered(position, guard => !guard.yields);
    const coveredBar = position => covered(position, guard => guard.yields);
    // The gap between the card and the nearest thing it is about (0 when touching); 0 with no focus.
    const gapTo = position => focus.length ? Math.min(...focus.map(box => Math.hypot(
      Math.max(0, box.left - (position.left + width), position.left - box.right),
      Math.max(0, box.top - (position.top + height), position.top - box.bottom)))) : 0;
    // Spots right beside each focus box (and beside all of them together), and beside every other
    // keep-out, so getting out of the way can be a short sidestep rather than a trip to a far corner: to
    // its right or left, top edges level or centred, or above or below it, left edges level or centred.
    const beside = [];
    const boxes = [...new Set([...focus, ...guards.filter(guard => !guard.yields)])];
    if (focus.length > 1) boxes.push({
      left: Math.min(...focus.map(box => box.left)), right: Math.max(...focus.map(box => box.right)),
      top: Math.min(...focus.map(box => box.top)), bottom: Math.max(...focus.map(box => box.bottom)),
    });
    const gap = 10;
    for (const box of boxes) {
      const middleY = (box.top + box.bottom) / 2 - height / 2;
      const middleX = (box.left + box.right) / 2 - width / 2;
      for (const left of [box.right + gap, box.left - width - gap]) beside.push({left, top: box.top}, {left, top: middleY});
      for (const top of [box.bottom + gap, box.top - height - gap]) beside.push({left: box.left, top}, {left: middleX, top});
    }
    const candidates = [...corners, ...beside.map(clamp)];
    const rank = position => ({
      position,
      evidence: coveredEvidence(position),
      bar: coveredBar(position),
      near: gapTo(position),
      move: this.pos ? Math.hypot(position.left - this.pos.left, position.top - this.pos.top) : 0,
      away: targetRect ? Math.hypot(position.left + width / 2 - (targetRect.left + targetRect.width / 2), position.top + height / 2 - (targetRect.top + targetRect.height / 2)) : 0,
    });
    // Least of what the step is about hidden, then least of the query bar. Then, while the card explains
    // what is on the page (a result, or an open flyout's contents), the nearest spot, a short hop breaking
    // near-ties. While the coach is acting it only gets out of the way: the shortest hop, which keeps
    // Advance close to where the pointer last pressed it (or, for a first placement, the spot farthest
    // from the control).
    const reading = this.phase === 'learning' || this.seekFocus || Boolean(flyoutRect);
    const order = (a, b) => a.evidence - b.evidence || a.bar - b.bar
      || (focus.length && reading ? (a.near + a.move * 0.25) - (b.near + b.move * 0.25)
        : this.pos ? a.move - b.move : b.away - a.away);
    // Sticky: keep the current placement when it isn't covering a keep-out and still fits — unless a
    // result card (seekFocus) sits far from its evidence and a clear spot beside it saves a long look.
    if (this.pos) {
      const fits = this.pos.left >= margin - 1 && this.pos.top >= topMargin - 1
        && this.pos.left <= maxLeft + 1 && this.pos.top <= maxTop + 1;
      if (fits && coveredEvidence(this.pos) === 0 && coveredBar(this.pos) === 0) {
        if (!this.seekFocus || !data.length) return;
        const gapToData = position => Math.min(...data.map(box => Math.hypot(
          Math.max(0, box.left - (position.left + width), position.left - box.right),
          Math.max(0, box.top - (position.top + height), position.top - box.bottom))));
        const nearest = candidates.map(rank).filter(item => item.evidence === 0 && item.bar === 0)
          .map(item => ({...item, near: gapToData(item.position)})).sort(order)[0];
        if (!nearest || gapToData(this.pos) - nearest.near < IncidentCoachPanel.seekDistance) return;
        this.pos = nearest.position;
        this.applyPosition();
        return;
      }
    } else if (!guards.length) {
      this.pos = {left: maxLeft, top: topMargin};
      this.applyPosition(firstPlacement);
      return;
    }
    const ranked = candidates.map(rank).sort(order);
    // Even the best spot covers what the step is about. That matters more than the reasoning beneath
    // the finding, so try again with the shorter card; the learner can still open the reasoning.
    if (ranked[0].evidence > 0 && this.foldReasoning()) {
      this.placeAwayFrom(target);
      return;
    }
    this.pos = {left: Math.round(ranked[0].position.left), top: Math.round(ranked[0].position.top)};
    this.applyPosition(firstPlacement);
  }

  // How much nearer (px) a result card must get to its evidence before it leaves a clear spot for one
  // beside the evidence.
  static seekDistance = 240;

  // Whether a ringed element is data the learner reads (a document's rows, a result row or cell, a Top
  // values list, a Field statistics row, anything in a flyout) rather than a control (a filter pill, the
  // query bar, the hit count, the histogram).
  isDataEvidence(index) {
    const element = this.evidenceTargets?.[index]?.();
    return Boolean(element?.closest?.("[role='row'], [role='gridcell'], .euiFlyout, [data-test-subj='docViewerFlyout'], .euiPopover__panel, [data-popover-panel], [data-test-subj~='dataVisualizerTable'], [data-test-subj^='dataVisualizerRow']"));
  }

  // `instant` suppresses the panel's left/top transition for one commit so a freshly revealed panel
  // appears at its resting spot rather than sliding in from the CSS default corner. `motion` can give the
  // glide its own timing function (a cubic-bezier) and shortest/longest durations in ms.
  applyPosition(instant = false, {ease = '', shortest = 380, longest = 900} = {}) {
    // Move with a GPU-composited transform rather than left/top: animating layout properties forces
    // the heavy Kibana grid underneath to reflow on every frame, which drops frames and reads as a
    // jerky slide. The glide time also scales with the distance travelled so a small nudge stays
    // quick while a full corner-swap decelerates gently into place instead of lurching off the mark.
    if (instant) {
      this.panel.style.transition = 'none';
    } else {
      const from = this.appliedPos || this.pos;
      const distance = Math.hypot(this.pos.left - from.left, this.pos.top - from.top);
      const duration = Math.round(Math.min(longest, Math.max(shortest, distance * 0.8)));
      this.panel.style.setProperty('--panel-move', `${duration}ms`);
      if (ease) this.panel.style.setProperty('--panel-ease', ease);
      else this.panel.style.removeProperty('--panel-ease');
      if (distance >= 1) this.moveEndsAt = performance.now() + duration;
    }
    this.panel.style.transform = `translate(${this.pos.left}px, ${this.pos.top}px)`;
    // Bound the card to the viewport from wherever its top now sits, so a phase that grows
    // taller can never spill past the bottom edge — it keeps the same margin as the sides and
    // scrolls inside if it truly can't fit. (CSS max-height is measured from the viewport top,
    // which stops guarding once the panel is placed lower down.)
    const maxHeight = `${Math.max(160, innerHeight - this.pos.top - 18)}px`;
    if (this.panel.style.maxHeight !== maxHeight) this.panel.style.maxHeight = maxHeight;
    if (instant && !this.dragging) {
      void this.panel.offsetWidth; // flush the placement before re-enabling the transition
      this.panel.style.transition = '';
    }
    this.appliedPos = {left: this.pos.left, top: this.pos.top};
  }

  // A demonstration reveals one card at a time (what → optional why → action → learning) and the cards
  // differ in height, so after each one renders, lift the panel just enough — never above the top
  // margin — that its bottom keeps a comfortable margin. Horizontal placement is left untouched (no
  // jarring corner hop), and the move is instant so it reads as part of the card's own transition.
  refit() {
    if (!this.panel || this.panel.hidden || !this.pos) return;
    // Docked, the card's bottom is what stays put: it grows or shrinks upward, gliding.
    if (this.docked) {
      this.dock();
      return;
    }
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
    this.targetToken = (this.targetToken || 0) + 1;
    this.presentToken = (this.presentToken || 0) + 1;
    this.presenting = false;
    this.clearHint();
    this.clearEvidenceHighlights();
    this.spotlight.hide();
    this.cursor.hide();
    this.panel.hidden = true;
    this.activeTarget = null;
    this.spotlightRevealed = false;
    this.phase = null;
  }

  // A line under the card: a status, or an error (which reveals the panel). `action` adds a button to it,
  // e.g. Retry now while the learning service is away.
  toast(message, error = false, action = null) {
    const status = this.root.querySelector('#status');
    status.textContent = message;
    status.className = error ? 'error' : '';
    if (action && message) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'status-action';
      button.textContent = action.label;
      button.onclick = () => action.onSelect?.();
      status.append(' ', button);
      this.host.hidden = false;
      this.panel.hidden = false;
    }
    // A problem must never be swallowed by a panel that finishCommand hid between steps: surface the
    // panel so the learner sees what went wrong instead of the demonstration appearing to just stop.
    if (error) { this.host.hidden = false; this.panel.hidden = false; }
  }

  // Confirm newly found evidence in the already-open panel: the current step's card turns
  // into a green "New evidence found" card that animates in, holds briefly, then flips to the next step. The
  // next command (showCommand) is deferred while this plays so the success is seen before advancing.
  // `note` is an extra line under the confirmation (e.g. "This worked, but it searches every field…"),
  // which holds the card a little longer so it can be read.
  celebrate(message = '', note = '') {
    // A demonstration narrates its own "What this shows" beat, so it needs no separate confirmation.
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
    stage.classList.remove('acting', 'result', 'recovery', 'checkin');
    stage.classList.add('success');
    eyebrow.hidden = false;
    eyebrow.innerHTML = '<span class="stage-tick" aria-hidden="true"></span>New evidence found';
    this.root.querySelector('#phase-headline').textContent = message || 'That step is complete.';
    const detail = this.root.querySelector('#phase-detail');
    detail.textContent = note;
    detail.hidden = !note;
    this.setReasoning();
    this.renderChoices([]);
    // Replay the entrance animation from a clean state.
    stage.classList.remove('celebrate-in', 'phase-in');
    void stage.offsetWidth;
    stage.classList.add('celebrate-in');
    this.refit();
    clearTimeout(this.celebrateTimer);
    this.celebrateTimer = setTimeout(() => this.finishCelebrate(), note ? 5000 : 1500);
  }

  // The hold is over: drop the confirmation and render the step that arrived while it was playing.
  // With no next step yet (it is still resolving, or this was the final goal) the card simply stays.
  finishCelebrate() {
    clearTimeout(this.celebrateTimer);
    this.celebrating = false;
    this.advanceRequested = false;
    if (!this.pendingCommand) return;
    const {command, target, focus} = this.pendingCommand;
    this.pendingCommand = null;
    this.showCommand(command, target, {focus});
  }

  advanceCelebration() {
    if (!this.celebrating) return false;
    this.advanceRequested = true;
    if (this.pendingCommand) this.finishCelebrate();
    return true;
  }

  stop() {
    this.targetToken = (this.targetToken || 0) + 1;
    this.presentToken = (this.presentToken || 0) + 1;
    this.presenting = false;
    clearTimeout(this.layerTimer);
    this.stopObserving();
    this.clearHint();
    this.briefing.close();
    this.clearEvidenceHighlights();
    this.spotlight.hide();
    this.cursor.hide();
    this.panel.hidden = true;
    this.host.hidden = true;
    this.pos = null;
    this.appliedPos = null;
    this.reasoningOpen = null;
    clearTimeout(this.celebrateTimer);
    this.celebrating = false;
    this.advanceRequested = false;
    this.pendingCommand = null;
    this.root.querySelector('#stage').classList.remove('success', 'celebrate-in', 'recovery', 'checkin');
    this.completion = null;
    this.setCollapsed(false);
  }

  static returnLabel = 'Close investigation & return to main menu';

  // Drawn rather than typed, so the fold toggle is a true minus and plus in every font.
  static foldIcons = {
    collapse: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.5 8h9"/></svg>',
    expand: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.5 8h9M8 3.5v9"/></svg>',
  };

  // Docking glides with a long, soft deceleration (ease-out quart) so the card settles into its corner.
  static dockMotion = {ease: 'cubic-bezier(.25, 1, .5, 1)', shortest: 560, longest: 820};

  static styles = `
    :host { all: initial; position: fixed; z-index: 2147483647; inset: 0; pointer-events: none; font: 14px system-ui,sans-serif; color: #17212b; }
    .panel { pointer-events: auto; position: fixed; z-index:3; top: 0; left: 0; width: min(468px, calc(100vw - 36px)); max-height: calc(100vh - 90px); overflow: auto; box-sizing: border-box; padding: 18px; border: 1px solid #b6c6d6; border-radius: 12px; background: #fff; box-shadow: 0 16px 46px #17212b40; transform: translate(18px, 72px); transition: transform var(--panel-move, .6s) var(--panel-ease, cubic-bezier(.4, 0, .2, 1)); will-change: transform; }
    [hidden] { display:none!important; }
    header { display:flex; align-items:center; gap:8px; cursor:grab; touch-action:none; user-select:none; } header.dragging { cursor:grabbing; } header strong { flex:1; } .live-dot { width:9px;height:9px;border-radius:50%;background:#1aa87a;box-shadow:0 0 0 4px #1aa87a22; }
    h2 { margin: 14px 0 8px; font-size: 17px; text-transform: capitalize; } h3 { margin:0 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.045em;color:#3f5060; } p { line-height:1.45; } .step-line { display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-bottom:10px; } .progress[hidden] + .step-line { margin-top:12px; } .step-line h2 { margin:0; } #mode { flex:none; margin:0; color:#536170; font-size:12px; } #mode::first-letter { text-transform:uppercase; }
    #stage { padding:16px 18px;border:1px solid #bcd3e6;border-left:6px solid #006bb4;border-radius:11px;background:#f1f7fd;box-shadow:0 6px 20px #006bb416; } #stage.acting { border-left-color:#e0a200;background:#fff8e8;box-shadow:0 6px 20px #e0a2001f; } #stage.result { border-left-color:#12a56b;background:#f0f9f4;box-shadow:0 6px 20px #12a56b1f; } #stage.result .eyebrow { color:#0b7a4f; } #stage.result #phase-headline { font-size:17px;line-height:1.42; } #stage.result #phase-detail { margin-top:6px;color:#22384a;text-wrap:pretty; }
    #phase-why { margin-top:10px;padding-top:6px;border-top:1px solid #12a56b33; } #phase-why summary { display:flex;align-items:center;gap:7px;width:fit-content;min-height:24px;list-style:none;cursor:pointer;color:#0b7a4f;font-size:13px;font-weight:650; } #phase-why summary::-webkit-details-marker { display:none; } #phase-why summary::before { content:"";width:5px;height:5px;margin-left:1px;border:solid currentColor;border-width:0 2px 2px 0;transform:rotate(-45deg);transition:transform .15s; } #phase-why[open] summary::before { transform:translateY(-1px) rotate(45deg); } #phase-why summary:hover,#phase-why summary:focus-visible { outline:2px solid #006bb4;outline-offset:1px;border-radius:3px; } #phase-why-text { margin:4px 0 0;color:#3a4d5c;font-size:14px;line-height:1.5;text-wrap:pretty; }
    .eyebrow { margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#3f6480;font-weight:750; } #phase-headline { margin:0;font-size:20px;line-height:1.38;font-weight:600;letter-spacing:-.01em;color:#0f2231;white-space:pre-line; }
    #stage.phase-in { animation:phase-in .32s cubic-bezier(.22,1,.36,1); } @keyframes phase-in { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:none} }
    .countdown { margin-top:16px;height:7px;border-radius:6px;background:#cfe0ee;overflow:hidden; } .countdown span { display:block;height:100%;width:0;background:#006bb4;border-radius:6px; } #stage.acting .countdown { background:#efdaa6; } #stage.acting .countdown span { background:#d98c00; }
    .countdown.working span { width:34%!important;animation:cd-sweep 1.25s cubic-bezier(.55,0,.45,1) infinite; } @keyframes cd-sweep { 0%{transform:translateX(-115%)} 100%{transform:translateX(310%)} }
    @media (prefers-reduced-motion: reduce) { .countdown.working span { transform:none!important;width:100%!important;opacity:.55; } .countdown span { width:100%!important; } }
    button { border:1px solid #8293a3;border-radius:5px;background:#f5f7f9;padding:6px 9px;cursor:pointer; } button:hover,button:focus-visible { outline:2px solid #006bb4;outline-offset:1px; }
    .panel.collapsed { width:auto;padding:10px 12px 10px 16px; } .panel.collapsed > :not(header) { display:none!important; }
    #fold { display:inline-grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:#536170; } #fold:hover { color:#17212b;background:#eef3f7; } #fold svg { width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round; }
    #stop { color:#a32b1c;border-color:#d77d72; } #advance { margin-left:auto;min-width:7.5em; } #advance.primary { background:#006bb4;border-color:#006bb4;color:#fff;font-weight:600;padding:6px 14px; } #advance:disabled { opacity:.7;cursor:wait; } .actions { display:flex; gap:7px; margin-top:12px; } .actions:not(:has(> :not([hidden]))) { display:none; }
    #hint { display:inline-flex;align-items:center;gap:7px; } #hint:disabled { opacity:.5;cursor:not-allowed;outline:none; }
    .hint-pips { display:inline-flex;gap:3px; } .hint-pips i { display:block;width:7px;height:7px;box-sizing:border-box;border:1.5px solid #0874a8;border-radius:50%; } .hint-pips i.used { background:#0874a8; }
    #hint-card { margin-top:14px;padding:13px 16px 14px;border:1px solid #b8dcea;border-left:4px solid #0874a8;border-radius:9px;background:#f0f8fc;box-shadow:0 4px 14px #0874a812; }
    #hint-label { display:block;color:#08638d;font:700 11px/1.3 system-ui,sans-serif;letter-spacing:.09em;text-transform:uppercase; }
    #hint-text { margin:6px 0 0;color:#173d53;font:500 15px/1.5 'Segoe UI',system-ui,sans-serif;letter-spacing:-.005em;white-space:pre-line; }
    .progress { height:4px;background:#dce4eb;margin:12px 0 10px;border-radius:4px;overflow:hidden; }.progress span { display:block;height:100%;background:#006bb4;transition:width .3s; }
    label { display:block;font-weight:650;margin-top:10px; } input,select,textarea { display:block;width:100%;box-sizing:border-box;margin-top:3px;padding:7px;border:1px solid #9ba9b6;border-radius:4px;font:inherit; } textarea { min-height:58px; }
    #diagnosis button { margin-top:12px;background:#006bb4;color:#fff;border:0; } #status { min-height:18px;color:#147d5c; } #status .status-action { margin-left:6px;padding:2px 8px;font-size:12px; } #status:empty { display:none; }.error { color:#a32b1c!important; }
    #stage.success { border-left-color:#12a56b;background:#ecf8f2;box-shadow:0 6px 22px #12a56b24; } #stage.success .eyebrow { display:flex;align-items:center;gap:8px;color:#0b7a4f; } #stage.success #phase-headline { color:#0c3d2b; }
    #phase-detail { margin:12px 0 0;color:#3a4d5c;font-size:14px;line-height:1.5;white-space:pre-line; }
    .stage-actions { display:flex;flex-wrap:wrap;gap:8px;margin-top:16px; } .stage-actions button { padding:7px 12px;font-weight:600; } .stage-actions button.primary { background:#006bb4;border-color:#006bb4;color:#fff; }
    #stage.checkin { border-left-color:#1a8a86;background:#eef8f7;box-shadow:0 6px 22px #1a8a8624; } #stage.checkin .eyebrow { color:#13706c; } #stage.checkin #phase-headline { color:#0d3533;font-size:18px; } #stage.checkin .stage-actions button.primary { background:#1a8a86;border-color:#1a8a86; }
    #stage.recovery .stage-actions button.primary { background:#c25423;border-color:#c25423; }
    #stage.recovery { border-left-color:#d4602a;background:#fff4ec;box-shadow:0 6px 22px #d4602a24; } #stage.recovery .eyebrow { color:#a8431a; } #stage.recovery #phase-headline { color:#4a1d08;font-size:18px; } #stage.recovery .countdown { background:#f4d6c4; } #stage.recovery .countdown span { background:#d4602a; }
    .stage-tick { flex:0 0 auto;display:inline-block;width:18px;height:18px;border-radius:50%;background:#12a56b;position:relative;transform:none;animation:tick-pop .4s .1s cubic-bezier(.22,1.4,.4,1) both; }
    .stage-tick::after { content:"";position:absolute;left:6px;top:3px;width:4px;height:8px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(42deg); }
    @keyframes tick-pop { from{transform:scale(0)} to{transform:scale(1)} }
    #stage.celebrate-in { animation:celebrate-in .42s cubic-bezier(.22,1,.36,1); } @keyframes celebrate-in { from{opacity:0;transform:translateY(8px) scale(.99)} to{opacity:1;transform:none} }
    /* One ring for every highlight: the spotlight on the control the coach acts on (the page dimmed
       around it) and the evidence rings a card talks about. Each arrives the same way (.entering). */
    :is(.incident-spotlight,.incident-evidence-highlight) { --ring:#ffb000;--ring-edge:#b86e00;--ring-glow:#ffb00059;position:fixed;z-index:1;box-sizing:border-box;border-radius:7px;pointer-events:none; }
    .incident-spotlight { display:none;box-shadow:0 0 0 9999px #10182070; }
    .incident-evidence-highlight { background:#ffb0001a; }
    .incident-evidence-highlight.primary { --ring:#0879a5;--ring-edge:#075878;--ring-glow:#0879a559;background:#0879a51f; }
    :is(.incident-spotlight,.incident-evidence-highlight)::before,:is(.incident-spotlight,.incident-evidence-highlight)::after { content:"";position:absolute;inset:0;box-sizing:border-box;border-radius:inherit; }
    :is(.incident-spotlight,.incident-evidence-highlight)::before { border:3px solid var(--ring);box-shadow:0 0 0 1px var(--ring-edge),inset 0 0 0 1px #fffc,0 0 14px 2px var(--ring-glow); }
    :is(.incident-spotlight,.incident-evidence-highlight).entering { animation:ring-flash .6s calc(var(--ring-delay,0ms) + .34s) ease-out both; }
    :is(.incident-spotlight,.incident-evidence-highlight).entering::before { animation:ring-close .7s var(--ring-delay,0ms) cubic-bezier(.34,1.4,.64,1) both; }
    :is(.incident-spotlight,.incident-evidence-highlight).entering::after { border:3px solid var(--ring);box-shadow:0 0 12px var(--ring-glow);animation:ring-pulse .8s calc(var(--ring-delay,0ms) + .4s) cubic-bezier(.2,.6,.3,1) both; }
    @keyframes ring-close { from { inset:-24px;border-radius:18px;opacity:0;box-shadow:0 0 0 1px var(--ring-edge),inset 0 0 0 1px #fffc,0 0 30px 10px var(--ring-glow); } 18% { opacity:1; } }
    @keyframes ring-flash { from { background-color:#ffb00000; } 30% { background-color:#ffb00059; } }
    @keyframes ring-pulse { from { inset:0;opacity:0; } 6% { opacity:1; } 45% { opacity:.6; } to { inset:-20px;border-radius:20px;opacity:0; } }
    @keyframes ring-fade { from { opacity:0; } }
    @media (prefers-reduced-motion: reduce) { :is(.incident-spotlight,.incident-evidence-highlight).entering { animation:ring-fade .25s var(--ring-delay,0ms) ease-out both!important; } :is(.incident-spotlight,.incident-evidence-highlight).entering::before { animation:none!important; } :is(.incident-spotlight,.incident-evidence-highlight).entering::after { animation:none!important;border:0; } }
    .incident-cursor { position:fixed;z-index:2;left:-12px;top:-12px;width:24px;height:24px;opacity:0;pointer-events:none;transition:transform var(--incident-cursor-duration, .65s) cubic-bezier(.4,.1,.6,.9),opacity .15s; }
    .incident-cursor.visible { opacity:1; }.incident-cursor:before { content:'➤';display:block;color:#ffb000;font-size:28px;filter:drop-shadow(0 2px 2px #0008);transform:rotate(-25deg); }
    .incident-cursor span { position:absolute;inset:0;border:2px solid #ffb000;border-radius:50%;opacity:0; }.incident-cursor.clicked span { animation:click-ring .5s; }
    @keyframes click-ring { from{opacity:1;transform:scale(.3)}to{opacity:0;transform:scale(2)} }
    /* Debriefs are read over a busy Kibana screen at desktop distance: a 17px base (1.55 leading), the
       problem statement at 21px, titles at 26px, and a width that keeps lines near 75 characters. */
    dialog.incident-debrief { pointer-events:auto;width:min(800px,calc(100vw - 48px));max-width:none;max-height:calc(100vh - 48px);overflow:auto;box-sizing:border-box;border:0;border-radius:12px;padding:30px 36px;box-shadow:0 14px 50px #0006;color:#17212b;font-size:17px;line-height:1.55; }.incident-debrief::backdrop{background:#101820aa}.dialog-close{float:right;border:0;font-size:26px;line-height:1}.incident-debrief h2{margin:0 0 4px;font-size:26px;line-height:1.25;letter-spacing:-.015em;text-transform:none}.incident-debrief li{display:flex;justify-content:space-between;padding:6px 0}.incident-debrief .total{font-size:23px;font-weight:750}.incident-debrief .demo-checks{margin:4px 0 0;padding-left:24px}.incident-debrief .demo-checks li{display:list-item;padding:5px 0 5px 4px;line-height:1.55}.incident-debrief .demo-checks li::marker{color:#536170}.incident-debrief .demo-checks p{margin:3px 0}.incident-problem{margin:16px 0 22px;padding:16px 20px;border-left:6px solid #d64a3a;background:#fff3f1;border-radius:8px}.incident-problem strong{display:block;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#8c2418}.incident-problem p{margin:6px 0 0;font-size:21px;font-weight:750;line-height:1.38;text-wrap:pretty}.incident-conclusion{padding:12px 14px;border-left:4px solid #1aa87a;background:#eef9f5;border-radius:6px}
    .guided-score { margin:18px 0 16px; }
    .guided-score-heading { display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px;font-size:18px; }
    .guided-score-heading strong:last-child { font-size:28px;font-variant-numeric:tabular-nums; }
    .guided-score-track { position:relative;height:20px;overflow:hidden;border-radius:6px;background:linear-gradient(90deg,#b42318 0%,#d84227 14%,#eb7330 29%,#f2aa38 42%,#e7cf49 53%,#aacc50 67%,#63b65a 82%,#148d61 100%); }
    .guided-score-unearned { position:absolute;top:0;bottom:0;left:var(--score);right:0;background:#e4e9ed; }
    .guided-score-ticks { position:absolute;inset:0;display:flex;justify-content:space-between;pointer-events:none; }
    .guided-score-ticks i { display:block;width:1px;height:100%;background:#fff;box-shadow:0 0 0 1px #17212b66; }
    .guided-score-labels { display:flex;justify-content:space-between;margin-top:6px;color:#536170;font-size:13px;font-variant-numeric:tabular-nums; }
    @media (prefers-reduced-motion: reduce) { *, .incident-cursor, .progress span { transition:none!important;animation:none!important; } .stage-tick { transform:none!important; } }
  `;
}

globalThis.IncidentCoachPanel = IncidentCoachPanel;
