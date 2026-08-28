class IncidentDebrief {
  constructor(root) {
    this.root = root;
  }

  show(feedback) {
    const dialog = document.createElement('dialog');
    dialog.className = 'incident-debrief';
    const components = Object.entries(feedback.components || {}).map(([name, score]) => `<li><span>${name.replaceAll('_', ' ')}</span><strong>${score}</strong></li>`).join('');
    dialog.innerHTML = `<form method="dialog"><button class="dialog-close" aria-label="Close debrief">×</button></form>
      <h2>Incident debrief</h2><p>${feedback.summary}</p><p class="total">Score: ${feedback.total}/100</p>
      <ul>${components}</ul><p>Assistance: ${feedback.assistance.hints} hints; ${feedback.assistance.demonstrated_steps} demonstrated steps.</p>
      <p><strong>Reference route:</strong> ${feedback.reference_route.join(' → ')}</p>`;
    this.root.append(dialog);
    dialog.addEventListener('close', () => dialog.remove());
    dialog.showModal();
  }
}

globalThis.IncidentDebrief = IncidentDebrief;
