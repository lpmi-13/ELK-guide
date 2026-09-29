class IncidentDebrief {
  constructor(root) {
    this.root = root;
  }

  show(feedback) {
    const dialog = document.createElement('dialog');
    dialog.className = 'incident-debrief';
    if (feedback.assistance?.step_count != null) {
      const help = feedback.assistance;
      const steps = help.step_count;
      const score = Math.max(0, Math.min(100, Number(feedback.total) || 0));
      const phaseCredit = steps ? Number((100 / steps).toFixed(1)) : 0;
      const hintCredit = steps ? Number((50 / steps).toFixed(1)) : 0;
      dialog.innerHTML = `<form method="dialog"><button class="dialog-close" aria-label="Close debrief">×</button></form>
        <h2>Guided investigation complete</h2>
        <p></p>
        <div class="guided-score">
          <div class="guided-score-heading"><strong>Guided practice score</strong><strong>${score}%</strong></div>
          <div class="guided-score-track" role="progressbar" aria-label="Guided investigation score" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${score}" style="--score:${score}%">
            <span class="guided-score-unearned" aria-hidden="true"></span>
            <span class="guided-score-ticks" aria-hidden="true">${Array.from({length: 6}, () => '<i></i>').join('')}</span>
          </div>
          <div class="guided-score-labels" aria-hidden="true">${Array.from({length: 6}, (_, index) => `<span>${index * 20}%</span>`).join('')}</div>
          <p class="guided-score-rule">Per phase: ${phaseCredit}% without help · ${hintCredit}% with hints only · 0% with Show me</p>
        </div>
        <ul>
          <li><span>Steps completed without help</span><strong>${help.independent_steps} of ${steps}</strong></li>
          <li><span>Hints requested</span><strong>${help.hints} across ${help.hinted_steps} of ${steps} steps</strong></li>
          <li><span>Show me used</span><strong>${help.demonstrated_steps} times across ${help.shown_steps} of ${steps} steps</strong></li>
        </ul>`;
      dialog.querySelector('p').textContent = feedback.summary;
      this.root.append(dialog);
      dialog.addEventListener('close', () => dialog.remove());
      dialog.showModal();
      return;
    }
    const components = Object.entries(feedback.components || {}).map(([name, score]) => `<li><span>${name.replaceAll('_', ' ')}</span><strong>${score}</strong></li>`).join('');
    const result = feedback.scored === false
      ? `Completion: ${feedback.completion ?? 'unscored walkthrough'}${feedback.completion != null ? '%' : ''}`
      : `Score: ${feedback.total}/100`;
    dialog.innerHTML = `<form method="dialog"><button class="dialog-close" aria-label="Close debrief">×</button></form>
      <h2>Investigation debrief</h2><p>${feedback.summary}</p><p class="total">${result}</p>
      <ul>${components}</ul><p>Assistance: ${feedback.assistance.hints} hints; ${feedback.assistance.demonstrated_steps} demonstrated steps.</p>
      <p><strong>Reference route:</strong> ${feedback.reference_route.join(' → ')}</p>`;
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

globalThis.IncidentDebrief = IncidentDebrief;
