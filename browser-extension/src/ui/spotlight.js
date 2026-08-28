class IncidentSpotlight {
  constructor(root) {
    this.element = document.createElement('div');
    this.element.className = 'incident-spotlight';
    this.element.setAttribute('aria-hidden', 'true');
    root.append(this.element);
  }

  show(target) {
    if (!target) return this.hide();
    const rect = target.getBoundingClientRect();
    this.element.style.cssText = `display:block;left:${rect.left - 6}px;top:${rect.top - 6}px;width:${rect.width + 12}px;height:${rect.height + 12}px`;
  }

  hide() { this.element.style.display = 'none'; }
}

globalThis.IncidentSpotlight = IncidentSpotlight;
