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
    dialog.innerHTML = `<form method="dialog"><button class="dialog-close" aria-label="Close summary">×</button></form>
      <h2></h2><p class="demo-summary"></p><h3>What was checked</h3><ol class="demo-checks"></ol>
      <h3>Evidence used</h3><p class="demo-evidence"></p><h3>Conclusion</h3><p class="incident-conclusion"></p>`;
    dialog.querySelector('h2').textContent = summary.title || 'Demonstration complete';
    dialog.querySelector('.demo-summary').textContent = summary.summary || '';
    dialog.querySelector('.demo-evidence').textContent = summary.evidence || '';
    dialog.querySelector('.incident-conclusion').textContent = summary.conclusion || '';
    const checks = dialog.querySelector('.demo-checks');
    for (const check of summary.checks || []) {
      const item = document.createElement('li');
      const title = document.createElement('strong');
      const detail = document.createElement('p');
      title.textContent = check.title;
      detail.textContent = check.detail;
      item.append(title, detail);
      checks.append(item);
    }
    this.root.append(dialog);
    dialog.addEventListener('close', () => dialog.remove());
    dialog.showModal();
  }
}

globalThis.IncidentDebrief = IncidentDebrief;
