class IncidentBriefing {
  constructor(root) {
    this.root = root;
    this.active = null;
    if (!root.querySelector('style[data-incident-briefing]')) {
      const style = document.createElement('style');
      style.dataset.incidentBriefing = '';
      style.textContent = IncidentBriefing.styles;
      root.append(style);
    }
  }

  node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  localTime(minutesAgo) {
    const observedAt = new Date(Date.now() - Number(minutesAgo || 0) * 60_000);
    try {
      return new Intl.DateTimeFormat(undefined, {hour: '2-digit', minute: '2-digit'}).format(observedAt);
    } catch (_error) {
      return observedAt.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
    }
  }

  modeCopy(mode) {
    return {
      demonstration: {label: 'Demonstration', action: 'Begin demonstration', waiting: 'Demonstration begins'},
      guided: {label: 'Guided practice', action: 'Begin guided practice', waiting: 'Guided practice begins'},
      challenge: {label: 'Challenge', action: 'Begin investigation', waiting: 'Investigation begins'},
    }[mode] || {label: mode, action: 'Begin investigation', waiting: 'Investigation begins'};
  }

  show(briefing) {
    if (this.active) return this.active.promise;
    const dialog = this.node('dialog', 'incident-briefing');
    dialog.setAttribute('aria-labelledby', 'incident-briefing-title');
    dialog.setAttribute('aria-describedby', 'incident-briefing-summary');

    const hero = this.node('div', 'briefing-hero');
    const image = this.node('img', 'briefing-hero-image');
    image.src = briefing.graphic;
    image.alt = '';
    image.decoding = 'async';
    hero.append(image);
    const heroShade = this.node('div', 'briefing-hero-shade');
    const source = this.node('div', 'briefing-source');
    const sourceIcon = this.node('span', `briefing-source-icon icon-${briefing.source.icon}`);
    sourceIcon.setAttribute('aria-hidden', 'true');
    const sourceCopy = this.node('span', 'briefing-source-copy');
    sourceCopy.append(
      this.node('strong', '', briefing.source.label),
      this.node('small', '', briefing.source.detail),
    );
    source.append(sourceIcon, sourceCopy);
    const status = this.node('div', 'briefing-status');
    status.append(this.node('span', 'briefing-severity', briefing.severity), this.node('span', 'briefing-state', 'Investigating'));
    heroShade.append(source, status);
    hero.append(heroShade);

    const main = this.node('div', 'briefing-main');
    const eyebrow = this.node('div', 'briefing-eyebrow');
    eyebrow.append(this.node('span', '', 'Incoming incident'), this.node('span', 'briefing-mode', this.modeCopy(briefing.mode).label));
    const title = this.node('h1', '', briefing.headline);
    title.id = 'incident-briefing-title';
    const summary = this.node('p', 'briefing-summary', briefing.summary);
    summary.id = 'incident-briefing-summary';

    const metadata = this.node('dl', 'briefing-metadata');
    const facts = [
      ['Raised', `${this.localTime(briefing.detected_offset_minutes)} local time`, `${briefing.detected_offset_minutes} minutes ago`],
      ['Environment', briefing.environment],
      ['Owning team', briefing.owner],
    ];
    for (const [label, value, secondary] of facts) {
      const item = this.node('div', 'briefing-metadata-item');
      item.append(this.node('dt', '', label), this.node('dd', '', value));
      if (secondary) item.append(this.node('small', '', secondary));
      metadata.append(item);
    }

    const impact = this.node('section', 'briefing-impact');
    impact.append(this.node('h2', '', 'What we know'), this.node('p', '', briefing.impact));
    const signals = this.node('ul', 'briefing-signals');
    for (const signal of briefing.signals || []) {
      const item = this.node('li', 'briefing-signal');
      item.append(this.node('span', 'briefing-signal-dot'), this.node('span', 'briefing-signal-label', signal.label), this.node('strong', '', signal.value));
      signals.append(item);
    }
    main.append(eyebrow, title, summary, metadata, impact, signals);

    const footer = this.node('footer', 'briefing-footer');
    const timing = this.node('div', 'briefing-timing');
    const countdownText = this.node('span', 'briefing-countdown-copy');
    const seconds = this.node('strong', 'briefing-seconds');
    countdownText.append(document.createTextNode(`${this.modeCopy(briefing.mode).waiting} in `), seconds);
    const timerTrack = this.node('span', 'briefing-timer-track');
    timerTrack.append(this.node('span', 'briefing-timer-fill'));
    timing.append(countdownText, timerTrack);
    const begin = this.node('button', 'briefing-begin', this.modeCopy(briefing.mode).action);
    begin.type = 'button';
    footer.append(timing, begin);

    dialog.append(hero, main, footer);
    this.root.append(dialog);

    let resolvePromise;
    const promise = new Promise(resolve => { resolvePromise = resolve; });
    const duration = Math.max(0, Number(briefing.duration_ms) || 30_000);
    const startedAt = Date.now();
    let interval;
    let timeout;
    const updateCountdown = () => {
      const remaining = Math.max(0, duration - (Date.now() - startedAt));
      seconds.textContent = `0:${String(Math.ceil(remaining / 1000)).padStart(2, '0')}`;
    };
    const dismiss = () => {
      if (dialog.open) dialog.close('continue');
    };
    begin.addEventListener('click', dismiss);
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      dismiss();
    });
    dialog.addEventListener('close', () => {
      clearInterval(interval);
      clearTimeout(timeout);
      dialog.remove();
      this.active = null;
      resolvePromise();
    }, {once: true});

    this.active = {briefing, dialog, promise, dismiss};
    dialog.showModal();
    updateCountdown();
    interval = setInterval(updateCountdown, 250);
    timeout = setTimeout(dismiss, duration);
    requestAnimationFrame(() => {
      const fill = dialog.querySelector('.briefing-timer-fill');
      fill.style.transitionDuration = `${duration}ms`;
      fill.style.transform = 'scaleX(0)';
    });
    begin.focus();
    return promise;
  }

  close() {
    this.active?.dismiss();
  }

  static styles = `
    dialog.incident-briefing { pointer-events:auto;width:min(900px,calc(100vw - 32px));max-width:none;max-height:calc(100vh - 32px);overflow:auto;box-sizing:border-box;border:1px solid #2f4960;border-radius:18px;padding:0;background:#f7fafc;color:#142331;box-shadow:0 28px 90px #06111ccc;font:14px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    dialog.incident-briefing::backdrop { background:rgba(5,14,24,.82);backdrop-filter:blur(5px); }
    .briefing-hero { position:relative;height:210px;overflow:hidden;background:#071a2b; }
    .briefing-hero-image { display:block;width:100%;height:100%;object-fit:cover;object-position:center 47%; }
    .briefing-hero-shade { position:absolute;inset:0;display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:24px;box-sizing:border-box;background:linear-gradient(180deg,rgba(4,16,29,.2),rgba(4,16,29,.12) 38%,rgba(4,16,29,.82)); }
    .briefing-source { display:flex;align-items:center;gap:11px;max-width:70%;padding:10px 13px;border:1px solid #96c8e652;border-radius:12px;background:#071a2bd9;color:#fff;box-shadow:0 8px 24px #0004;backdrop-filter:blur(8px); }
    .briefing-source-icon { position:relative;flex:0 0 auto;width:34px;height:34px;border-radius:10px;background:#163d58;border:1px solid #4dbde26b; }
    .briefing-source-icon::before,.briefing-source-icon::after { content:"";position:absolute;inset:50% auto auto 50%;transform:translate(-50%,-50%); }
    .icon-pulse::before { width:19px;height:10px;border-left:2px solid #54d6ff;border-bottom:2px solid #54d6ff;transform:translate(-50%,-64%) skewY(-32deg); }
    .icon-page::before { width:15px;height:18px;border:2px solid #54d6ff;border-radius:8px 8px 5px 5px; }
    .icon-page::after { width:5px;height:2px;border-radius:2px;background:#54d6ff;top:79%; }
    .icon-ticket::before { width:19px;height:13px;border:2px solid #54d6ff;border-radius:3px; }
    .icon-ticket::after { width:2px;height:9px;border-left:2px dotted #54d6ff; }
    .icon-channel::before { width:18px;height:14px;border:2px solid #54d6ff;border-radius:5px; }
    .icon-channel::after { width:6px;height:6px;border-left:2px solid #54d6ff;transform:translate(-65%,60%) rotate(-35deg); }
    .icon-probe::before { width:6px;height:6px;border:2px solid #54d6ff;border-radius:50%;box-shadow:0 0 0 4px #163d58,0 0 0 6px #54d6ff66; }
    .icon-deploy::before { width:15px;height:15px;border:2px solid #54d6ff;transform:translate(-50%,-50%) rotate(45deg); }
    .briefing-source-copy { min-width:0; }.briefing-source-copy strong,.briefing-source-copy small { display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }.briefing-source-copy strong { font-size:13px; }.briefing-source-copy small { margin-top:2px;color:#add2e6;font-size:11px; }
    .briefing-status { display:flex;gap:7px;align-items:center; }.briefing-status span { padding:6px 9px;border-radius:999px;color:#fff;font-size:11px;font-weight:760;letter-spacing:.055em;text-transform:uppercase;box-shadow:0 5px 18px #0005; }.briefing-severity { background:#c83d2e; }.briefing-state { background:#8c5200; }
    .briefing-main { padding:26px 30px 20px; }
    .briefing-eyebrow { display:flex;align-items:center;gap:9px;color:#a12d22;font-size:11px;font-weight:800;letter-spacing:.09em;text-transform:uppercase; }.briefing-eyebrow span:first-child::before { content:"";display:inline-block;width:7px;height:7px;margin-right:7px;border-radius:50%;background:#d13b2d;box-shadow:0 0 0 5px #d13b2d18; }.briefing-mode { padding-left:9px;border-left:1px solid #bdc9d3;color:#456074; }
    .incident-briefing h1 { max-width:720px;margin:10px 0 8px;font-size:29px;line-height:1.16;letter-spacing:-.025em;color:#0b2030; }.briefing-summary { max-width:780px;margin:0;color:#4b6172;font-size:16px;line-height:1.55; }
    .briefing-metadata { display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:22px 0 18px; }.briefing-metadata-item { min-width:0;padding:12px 14px;border:1px solid #d7e1e8;border-radius:10px;background:#fff;box-shadow:0 3px 12px #18364e0a; }.briefing-metadata dt { margin-bottom:4px;color:#657888;font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase; }.briefing-metadata dd { margin:0;color:#163247;font-size:14px;font-weight:720;white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }.briefing-metadata small { display:block;margin-top:2px;color:#738695;font-size:11px; }
    .briefing-impact { padding:15px 17px;border-left:5px solid #d67a18;border-radius:8px;background:#fff7ea; }.briefing-impact h2 { margin:0 0 4px;color:#7d4304;font-size:11px;letter-spacing:.08em;text-transform:uppercase; }.briefing-impact p { margin:0;color:#493b2b;line-height:1.52; }
    .briefing-signals { display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:14px 0 0;padding:0;list-style:none; }.briefing-signal { position:relative;min-width:0;padding:12px 12px 12px 28px;border:1px solid #d8e2e9;border-radius:9px;background:#eef4f7; }.briefing-signal-dot { position:absolute;left:12px;top:17px;width:7px;height:7px;border-radius:50%;background:#1784a8;box-shadow:0 0 0 4px #1784a815; }.briefing-signal-label,.briefing-signal strong { display:block; }.briefing-signal-label { color:#607786;font-size:10px;font-weight:800;letter-spacing:.065em;text-transform:uppercase; }.briefing-signal strong { margin-top:4px;color:#1d3647;font-size:12px;line-height:1.42; }
    .briefing-footer { position:sticky;bottom:0;display:flex;align-items:center;justify-content:space-between;gap:20px;padding:16px 30px;border-top:1px solid #d6e0e7;background:#fff;box-shadow:0 -8px 28px #1730470c; }.briefing-timing { flex:1;min-width:150px; }.briefing-countdown-copy { display:block;margin-bottom:7px;color:#5c7080;font-size:12px; }.briefing-seconds { color:#163247;font-variant-numeric:tabular-nums; }.briefing-timer-track { display:block;width:min(320px,100%);height:5px;overflow:hidden;border-radius:5px;background:#d9e5ec; }.briefing-timer-fill { display:block;width:100%;height:100%;border-radius:inherit;background:linear-gradient(90deg,#0b8fbe,#43c79e);transform:scaleX(1);transform-origin:left;transition-property:transform;transition-timing-function:linear; }
    .briefing-begin { flex:0 0 auto;border:0;border-radius:8px;padding:10px 16px;background:#0879a5;color:#fff;font:700 13px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 5px 14px #0879a52e;cursor:pointer; }.briefing-begin:hover { background:#06688e; }.briefing-begin:focus-visible { outline:3px solid #55bde4;outline-offset:3px; }
    @media (max-width:700px) { dialog.incident-briefing { width:calc(100vw - 16px);max-height:calc(100vh - 16px);border-radius:13px; }.briefing-hero { height:170px; }.briefing-hero-shade { padding:14px; }.briefing-source { max-width:64%; }.briefing-source-copy small { display:none; }.briefing-status { flex-direction:column;align-items:flex-end; }.briefing-main { padding:20px 18px 16px; }.incident-briefing h1 { font-size:23px; }.briefing-metadata,.briefing-signals { grid-template-columns:1fr; }.briefing-footer { padding:13px 18px; } }
    @media (prefers-reduced-motion:reduce) { .briefing-timer-fill { transition:none!important; } dialog.incident-briefing::backdrop { backdrop-filter:none; } }
  `;
}

globalThis.IncidentBriefing = IncidentBriefing;
