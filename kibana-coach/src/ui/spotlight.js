class IncidentSpotlight {
  constructor(root) {
    this.element = document.createElement('div');
    this.element.className = 'incident-spotlight';
    this.element.setAttribute('aria-hidden', 'true');
    this.target = null;
    this.box = null;
    this.element.addEventListener('animationend', event => {
      if (event.animationName === 'ring-pulse' || event.animationName === 'ring-fade') this.element.classList.remove('entering');
    });
    root.append(this.element);
  }

  // The ring arrives on a control with the same entrance as the evidence rings (`.entering`): when it
  // appears, or moves on to another control. Following its control as the page scrolls, or onto the
  // same control re-rendered in place, is not an arrival, so it doesn't replay.
  show(target) {
    if (!target) return this.hide();
    const rect = target.getBoundingClientRect();
    const box = {left: rect.left - 6, top: rect.top - 6, width: rect.width + 12, height: rect.height + 12};
    const arriving = this.element.style.display !== 'block' || (target !== this.target && !IncidentSpotlight.sameBox(box, this.box));
    this.target = target;
    this.box = box;
    this.element.style.cssText = `display:block;left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px`;
    if (arriving) {
      this.element.classList.remove('entering');
      void this.element.offsetWidth;
      this.element.classList.add('entering');
    }
  }

  hide() {
    this.element.style.display = 'none';
    this.target = null;
    this.box = null;
  }

  static sameBox(a, b) {
    return Boolean(a && b) && ['left', 'top', 'width', 'height'].every(side => Math.abs(a[side] - b[side]) < 2);
  }
}

globalThis.IncidentSpotlight = IncidentSpotlight;
