class IncidentDebrief {
  constructor(root) {
    this.root = root;
    if (root.querySelector && !root.querySelector('style[data-incident-debrief]')) {
      const style = document.createElement('style');
      style.dataset.incidentDebrief = '';
      style.textContent = IncidentDebrief.styles;
      root.append(style);
    }
  }

  // How the score reads at a glance; the colours follow the score bar's red → amber → green ramp.
  static tier(score) {
    if (score >= 80) return {id: 'strong', label: 'Solved independently'};
    if (score >= 40) return {id: 'steady', label: 'Solved with some help'};
    return {id: 'guided', label: 'Mostly guided'};
  }

  static outcomes = {
    independent: {label: 'On your own', note: 'full credit'},
    hinted: {label: 'With a hint', note: 'half credit'},
    shown: {label: 'Shown to you', note: 'no credit'},
    incomplete: {label: 'Not completed', note: 'no credit'},
  };

  show(feedback) {
    const dialog = document.createElement('dialog');
    dialog.className = 'incident-debrief';
    if (feedback.assistance?.step_count != null) {
      const help = feedback.assistance;
      const steps = help.step_count;
      const score = Math.max(0, Math.min(100, Number(feedback.total) || 0));
      const phaseCredit = steps ? Number((100 / steps).toFixed(1)) : 0;
      const hintCredit = steps ? Number((50 / steps).toFixed(1)) : 0;
      const tier = IncidentDebrief.tier(score);
      // The ring is an SVG circle of circumference 100 (r ≈ 15.915), so the dash length is the score.
      dialog.className = `incident-debrief guided-debrief tier-${tier.id}`;
      dialog.style.setProperty('--score', `${score}%`);
      dialog.style.setProperty('--score-num', String(score));
      dialog.innerHTML = `<div class="gd-hero">
          <form method="dialog"><button class="dialog-close" aria-label="Close debrief">×</button></form>
          <div class="gd-hero-copy">
            <div class="gd-eyebrow"><span class="gd-eyebrow-dot" aria-hidden="true"></span><span>Guided practice</span><span class="gd-badge">Debrief</span></div>
            <h2>Guided investigation complete</h2>
            <p class="gd-summary"></p>
            <span class="gd-tier">${tier.label}</span>
          </div>
          <div class="gd-ring" aria-hidden="true">
            <svg viewBox="0 0 36 36"><circle class="gd-ring-track" cx="18" cy="18" r="15.915"></circle><circle class="gd-ring-fill" cx="18" cy="18" r="15.915" pathLength="100"></circle></svg>
            <div class="gd-ring-value"><strong>${score}%</strong><small>score</small></div>
          </div>
        </div>
        <div class="gd-body">
          <section class="guided-score">
            <div class="guided-score-heading"><strong>Guided practice score</strong><strong>${score}%</strong></div>
            <div class="guided-score-track" role="progressbar" aria-label="Guided investigation score" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${score}" style="--score:${score}%">
              <span class="guided-score-unearned" aria-hidden="true"></span>
              <span class="guided-score-ticks" aria-hidden="true">${Array.from({length: 6}, () => '<i></i>').join('')}</span>
            </div>
            <div class="guided-score-labels" aria-hidden="true">${Array.from({length: 6}, (_, index) => `<span>${index * 20}%</span>`).join('')}</div>
            <p class="guided-score-rule">Per phase: ${phaseCredit}% without help · ${hintCredit}% with hints only · 0% with Show me</p>
          </section>
          <section class="gd-steps-section" hidden>
            <h3>Step by step</h3>
            <ol class="gd-steps"></ol>
          </section>
          <ul class="gd-stats">
            <li class="gd-stat stat-solo"><span>Steps completed without help</span><strong>${help.independent_steps} of ${steps}</strong></li>
            <li class="gd-stat stat-hint"><span>Hints requested</span><strong>${help.hints} across ${help.hinted_steps} of ${steps} steps</strong></li>
            <li class="gd-stat stat-shown"><span>Show me used</span><strong>${help.demonstrated_steps} times across ${help.shown_steps} of ${steps} steps</strong></li>
          </ul>
        </div>
        <footer class="gd-footer"><form method="dialog"><button class="gd-done" autofocus>Done</button></form></footer>`;
      dialog.querySelector('.gd-summary').textContent = feedback.summary;
      const list = dialog.querySelector('.gd-steps');
      for (const [index, step] of (feedback.steps || []).entries()) {
        const outcome = IncidentDebrief.outcomes[step.outcome] || IncidentDebrief.outcomes.incomplete;
        const item = document.createElement('li');
        item.className = `gd-step outcome-${step.outcome in IncidentDebrief.outcomes ? step.outcome : 'incomplete'}`;
        item.style.setProperty('--i', String(index));
        item.innerHTML = '<span class="gd-step-marker" aria-hidden="true"></span><span class="gd-step-text"><span class="gd-step-title"></span><span class="gd-step-detail"></span></span><span class="gd-step-chip"></span>';
        item.querySelector('.gd-step-title').textContent = step.title || step.id;
        // Unscored context: time spent, check-ins, and dead ends recovered from.
        item.querySelector('.gd-step-detail').textContent = step.detail || '';
        item.querySelector('.gd-step-detail').hidden = !step.detail;
        item.querySelector('.gd-step-chip').textContent = outcome.label;
        item.querySelector('.gd-step-chip').title = outcome.note;
        list.append(item);
      }
      dialog.querySelector('.gd-steps-section').hidden = !list.children.length;
      this.root.append(dialog);
      dialog.addEventListener('close', () => dialog.remove());
      dialog.showModal();
      return;
    }
    const components = Object.entries(feedback.components || {}).map(([name, score]) => `<li><span>${name.replaceAll('_', ' ')}</span><strong>${score}</strong></li>`).join('');
    const detourSteps = feedback.step_detours || [];
    const result = feedback.scored === false
      ? `Completion: ${feedback.completion ?? 'unscored walkthrough'}${feedback.completion != null ? '%' : ''}`
      : `Score: ${feedback.total}/100`;
    dialog.innerHTML = `<form method="dialog"><button class="dialog-close" aria-label="Close debrief">×</button></form>
      <h2>Investigation debrief</h2><p>${feedback.summary}</p><p class="total">${result}</p>
      <ul>${components}</ul><p>Assistance: ${feedback.assistance.hints} hints; ${feedback.assistance.demonstrated_steps} demonstrated steps.</p>
      <p><strong>Reference route:</strong> ${feedback.reference_route.join(' → ')}</p>
      <section class="debrief-detours" hidden><h3>Detours</h3><ul></ul></section>`;
    // Challenge mode has no live feedback, so the dead ends and drift it recorded are shown here.
    const detours = dialog.querySelector('.debrief-detours');
    for (const step of detourSteps) {
      const item = document.createElement('li');
      const lines = [...(step.dead_ends || []).map(label => `Dead end: ${label}`), ...(step.drift || [])];
      item.innerHTML = '<strong></strong><span></span>';
      item.querySelector('strong').textContent = step.title || step.id;
      item.querySelector('span').textContent = lines.join(' · ');
      detours.querySelector('ul').append(item);
    }
    detours.hidden = !detourSteps.length;
    this.root.append(dialog);
    dialog.addEventListener('close', () => dialog.remove());
    dialog.showModal();
  }

  showDemonstration(summary) {
    const dialog = document.createElement('dialog');
    dialog.className = 'incident-debrief';
    // A compact recap: the finding, then one short line per step. The demonstration already carried
    // the reasoning as it went, so the summary drops the intro sentence, the per-step headings, and
    // the separate evidence/conclusion prose — it is a summary, not a re-teach.
    dialog.innerHTML = `<form method="dialog"><button class="dialog-close" aria-label="Close summary">×</button></form>
      <h2></h2>
      <div class="incident-problem"><strong>Problem found</strong><p></p></div>
      <ul class="demo-checks"></ul>`;
    dialog.querySelector('h2').textContent = summary.title || 'Demonstration complete';
    const problem = summary.answer?.conclusion || summary.conclusion || '';
    const problemBox = dialog.querySelector('.incident-problem');
    problemBox.querySelector('p').textContent = problem;
    problemBox.hidden = !problem;
    const checks = dialog.querySelector('.demo-checks');
    for (const check of summary.checks || []) {
      const item = document.createElement('li');
      // Checks are one-line recaps; only the detail is shown (the title is an internal label).
      item.textContent = typeof check === 'string' ? check : (check.detail || check.title || '');
      checks.append(item);
    }
    checks.hidden = !checks.children.length;
    this.root.append(dialog);
    dialog.addEventListener('close', () => dialog.remove());
    dialog.showModal();
  }
}

IncidentDebrief.styles = `
    dialog.guided-debrief { --accent:#148d61;--accent-soft:#148d6122;width:min(760px,calc(100vw - 32px));padding:0;border:1px solid #2f4960;border-radius:18px;background:#f7fafc;box-shadow:0 28px 90px #06111ccc;font:14px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;animation:gd-rise .45s cubic-bezier(.22,1,.36,1); }
    dialog.guided-debrief.tier-steady { --accent:#d98c00;--accent-soft:#d98c0022; }
    dialog.guided-debrief.tier-guided { --accent:#d84227;--accent-soft:#d8422722; }
    dialog.guided-debrief::backdrop { background:rgba(5,14,24,.82);backdrop-filter:blur(5px); }
    @keyframes gd-rise { from{opacity:0;transform:translateY(14px) scale(.985)} to{opacity:1;transform:none} }
    .gd-hero { position:relative;display:flex;align-items:center;gap:26px;padding:28px 30px 26px;color:#fff;overflow:hidden;background:radial-gradient(120% 140% at 100% 0%,#1d5b7a 0%,#0c2c44 45%,#071a2b 100%); }
    .gd-hero::after { content:"";position:absolute;inset:auto 0 0 0;height:4px;background:linear-gradient(90deg,#0b8fbe,#43c79e 55%,var(--accent)); }
    .gd-hero .dialog-close { position:absolute;top:14px;right:16px;float:none;width:32px;height:32px;border:1px solid #96c8e640;border-radius:50%;background:#071a2b99;color:#d8ecf7;font-size:20px;line-height:1;padding:0;cursor:pointer; }
    .gd-hero .dialog-close:hover { background:#163d58; }
    .gd-hero-copy { flex:1;min-width:0; }
    .gd-eyebrow { display:flex;align-items:center;gap:9px;color:#9fd9ef;font-size:11px;font-weight:800;letter-spacing:.09em;text-transform:uppercase; }
    .gd-eyebrow-dot { width:7px;height:7px;border-radius:50%;background:#43c79e;box-shadow:0 0 0 5px #43c79e26; }
    .gd-badge { padding:3px 8px;border:1px solid #96c8e652;border-radius:999px;color:#d8ecf7;background:#071a2b8c;letter-spacing:.07em; }
    .guided-debrief h2 { margin:10px 0 8px;font-size:27px;line-height:1.15;letter-spacing:-.022em;color:#fff;text-transform:none; }
    .guided-debrief .gd-summary { margin:0 0 14px;max-width:440px;color:#c3dcea;font-size:14px;line-height:1.5; }
    .gd-tier { display:inline-block;padding:6px 11px;border-radius:999px;background:var(--accent);color:#fff;font-size:11px;font-weight:780;letter-spacing:.06em;text-transform:uppercase;box-shadow:0 5px 18px #0006; }
    .gd-ring { position:relative;flex:0 0 auto;width:132px;height:132px;margin-right:18px; }
    .gd-ring svg { width:100%;height:100%;transform:rotate(-90deg); }
    .gd-ring circle { fill:none;stroke-width:3.2; }
    .gd-ring-track { stroke:#ffffff1f; }
    .gd-ring-fill { stroke:var(--accent);stroke-linecap:round;stroke-dasharray:var(--score-num) 100;animation:gd-ring 1.1s .2s cubic-bezier(.22,1,.36,1) both; }
    .gd-ring::before { content:"";position:absolute;inset:12px;border-radius:50%;background:radial-gradient(circle,var(--accent-soft),transparent 70%); }
    @keyframes gd-ring { from{stroke-dasharray:0 100} }
    .gd-ring-value { position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;line-height:1; }
    .gd-ring-value strong { display:block;margin:0;font-size:29px;line-height:1;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums; }
    .gd-ring-value small { display:block;margin:0;color:#9fc4d8;font-size:10px;line-height:1;font-weight:700;letter-spacing:.12em;text-transform:uppercase; }
    .gd-body { display:grid;gap:18px;padding:22px 30px 8px; }
    .guided-debrief .guided-score { margin:0;padding:18px 20px;border:1px solid #d8e2e9;border-radius:12px;background:#fff;box-shadow:0 3px 12px #18364e0a; }
    .guided-debrief .guided-score-unearned { animation:gd-bar 1.1s .2s cubic-bezier(.22,1,.36,1) both; }
    @keyframes gd-bar { from{left:0} }
    .gd-steps-section h3 { margin:0 0 9px;color:#456074;font-size:11px;font-weight:800;letter-spacing:.09em;text-transform:uppercase; }
    .gd-steps { position:relative;display:grid;gap:8px;margin:0;padding:0;list-style:none; }
    .guided-debrief .gd-step { --tone:#8a99a6;--tone-soft:#8a99a61a;display:flex;align-items:center;gap:12px;padding:10px 14px;border:1px solid #d8e2e9;border-left:4px solid var(--tone);border-radius:10px;background:#fff;animation:gd-step .4s calc(.35s + var(--i) * 70ms) cubic-bezier(.22,1,.36,1) both; }
    @keyframes gd-step { from{opacity:0;transform:translateX(-8px)} }
    .gd-step.outcome-independent { --tone:#12a56b;--tone-soft:#12a56b1c; }
    .gd-step.outcome-hinted { --tone:#d98c00;--tone-soft:#d98c001f; }
    .gd-step.outcome-shown { --tone:#1f78c1;--tone-soft:#1f78c11c; }
    .gd-step-marker { flex:0 0 auto;width:10px;height:10px;border-radius:50%;background:var(--tone);box-shadow:0 0 0 4px var(--tone-soft); }
    .gd-step-text { flex:1;min-width:0;display:flex;flex-direction:column;gap:2px; }
    .gd-step-title { color:#17304a;font-weight:600; }
    .gd-step-detail { color:#5b6b78;font-size:12px;line-height:1.35; }
    .debrief-detours h3 { margin:14px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#3f5060; }
    .incident-debrief .debrief-detours li { display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:6px 0;border-top:1px solid #e1e7ec; }
    .debrief-detours li span { color:#3f5060;font-size:13px; }
    .gd-step-chip { flex:0 0 auto;padding:3px 9px;border-radius:999px;background:var(--tone-soft);color:var(--tone);font-size:11px;font-weight:780;letter-spacing:.04em;text-transform:uppercase;filter:saturate(1.1) brightness(.85); }
    .guided-debrief .gd-stats { display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:0;padding:0;list-style:none; }
    .guided-debrief .gd-stat { --tone:#12a56b;display:flex;flex-direction:column-reverse;justify-content:flex-end;gap:6px;padding:14px 15px;border:1px solid #d8e2e9;border-top:4px solid var(--tone);border-radius:10px;background:linear-gradient(180deg,color-mix(in srgb,var(--tone) 7%,#fff),#fff 70%); }
    .gd-stat.stat-hint { --tone:#d98c00; } .gd-stat.stat-shown { --tone:#1f78c1; }
    .gd-stat span { color:#536170;font-size:12px;line-height:1.35; }
    .gd-stat strong { color:#0f2231;font-size:16px;line-height:1.3; }
    .gd-footer { position:sticky;bottom:0;display:flex;justify-content:flex-end;margin-top:14px;padding:14px 30px;border-top:1px solid #d6e0e7;background:#fff;box-shadow:0 -8px 28px #1730470c; }
    .gd-footer form { margin:0; }
    .gd-done { border:0;border-radius:8px;padding:10px 20px;background:#0879a5;color:#fff;font:700 13px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 5px 14px #0879a52e;cursor:pointer; }
    .gd-done:hover { background:#06688e; } .gd-done:focus-visible { outline:3px solid #55bde4;outline-offset:3px; }
    @media (max-width:640px) { .gd-hero { flex-direction:column-reverse;align-items:flex-start;padding:22px 18px; } .gd-ring { width:104px;height:104px; } .gd-body { padding:18px 18px 6px; } .guided-debrief .gd-stats { grid-template-columns:1fr; } .gd-footer { padding:12px 18px; } }
    @media (prefers-reduced-motion:reduce) { dialog.guided-debrief,.gd-ring-fill,.guided-debrief .guided-score-unearned,.guided-debrief .gd-step { animation:none!important; } dialog.guided-debrief::backdrop { backdrop-filter:none; } }
`;

globalThis.IncidentDebrief = IncidentDebrief;
