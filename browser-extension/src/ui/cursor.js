class IncidentCursor {
  constructor(root) {
    this.element = document.createElement('div');
    this.element.className = 'incident-cursor';
    this.element.setAttribute('aria-hidden', 'true');
    this.element.innerHTML = '<span></span>';
    root.append(this.element);
  }

  async moveTo(target) {
    if (!target) return;
    const rect = target.getBoundingClientRect();
    this.element.classList.add('visible');
    this.element.style.transform = `translate(${Math.round(rect.left + rect.width / 2)}px,${Math.round(rect.top + rect.height / 2)}px)`;
    await new Promise(resolve => setTimeout(resolve, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 650));
  }

  click() {
    this.element.classList.remove('clicked');
    void this.element.offsetWidth;
    this.element.classList.add('clicked');
  }

  hide() { this.element.classList.remove('visible'); }
}

globalThis.IncidentCursor = IncidentCursor;
