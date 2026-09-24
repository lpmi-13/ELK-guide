class IncidentDebrief {
  constructor(root) {
    this.root = root;
  }

  show(feedback) {
    const dialog = document.createElement('dialog');
    dialog.className = 'incident-debrief';
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
