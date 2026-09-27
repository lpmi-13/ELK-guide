class IncidentCursor {
  constructor(root) {
    this.element = document.createElement('div');
    this.element.className = 'incident-cursor';
    this.element.setAttribute('aria-hidden', 'true');
    this.element.innerHTML = '<span></span>';
    root.append(this.element);
  }

  // The pointer must land inside the viewport and every scrollable pane that contains the target.
  visibleBounds(target) {
    const bounds = {left: 0, top: 0, right: innerWidth, bottom: innerHeight};
    let scrollRegion = null;
    for (let parent = target.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const overflow = `${style.overflowX} ${style.overflowY}`;
      if (!/(auto|scroll|hidden|clip)/.test(overflow)) continue;
      const clip = parent.getBoundingClientRect();
      if (!scrollRegion && /(auto|scroll)/.test(overflow)) {
        const visible = {
          left: Math.max(0, clip.left), top: Math.max(0, clip.top),
          right: Math.min(innerWidth, clip.right), bottom: Math.min(innerHeight, clip.bottom),
        };
        if (visible.right - visible.left > 40 && visible.bottom - visible.top > 40) scrollRegion = visible;
      }
      bounds.left = Math.max(bounds.left, clip.left);
      bounds.top = Math.max(bounds.top, clip.top);
      bounds.right = Math.min(bounds.right, clip.right);
      bounds.bottom = Math.min(bounds.bottom, clip.bottom);
    }
    return {bounds, scrollRegion};
  }

  isVisible(target) {
    const rect = target.getBoundingClientRect();
    const {bounds} = this.visibleBounds(target);
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    return x > bounds.left + 8 && x < bounds.right - 8 &&
      y > bounds.top + 8 && y < bounds.bottom - 8;
  }

  // Move over the pane first, scroll it like a user, then let moveTo() travel to the revealed
  // control. This shared path covers Discover's field list and controls in other scrollable views.
  async reveal(target, {timingScale = 1, signal} = {}) {
    if (signal?.aborted) throw new DOMException('Demonstration stopped', 'AbortError');
    if (this.isVisible(target)) return;
    const rect = target.getBoundingClientRect();
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reducedMotion) {
      const region = this.visibleBounds(target).scrollRegion || {left: 0, top: 0, right: innerWidth, bottom: innerHeight};
      const x = Math.max(region.left + 16, Math.min(region.right - 16, rect.left + rect.width / 2));
      const y = (region.top + region.bottom) / 2;
      await this.moveToPoint(x, y, {timingScale, signal});
    }
    target.scrollIntoView({block: 'center', inline: 'nearest', behavior: reducedMotion ? 'instant' : 'smooth'});
    if (!reducedMotion) {
      const deadline = performance.now() + 2500;
      let previous = null;
      let stillSince = null;
      while (performance.now() < deadline) {
        await IncidentCursor.wait(32, signal);
        const position = target.getBoundingClientRect();
        const center = {x: position.left + position.width / 2, y: position.top + position.height / 2};
        const still = previous && Math.abs(center.x - previous.x) < 0.5 && Math.abs(center.y - previous.y) < 0.5;
        stillSince = this.isVisible(target) && still ? (stillSince ?? performance.now()) : null;
        if (stillSince !== null && performance.now() - stillSince >= 96) break;
        previous = center;
      }
      // Browsers without smooth scroll support still need a visible target before the click.
      if (!this.isVisible(target)) target.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'});
    }
    if (signal?.aborted) throw new DOMException('Demonstration stopped', 'AbortError');
  }

  async moveTo(target, {timingScale = 1, signal} = {}) {
    if (!target) return;
    const rect = target.getBoundingClientRect();
    await this.moveToPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, {timingScale, signal});
  }

  async moveToPoint(x, y, {timingScale = 1, signal} = {}) {
    const duration = matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 0
      : Math.min(900, 650 * timingScale);
    this.element.classList.add('visible');
    this.element.style.setProperty('--incident-cursor-duration', `${duration}ms`);
    this.element.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
    await IncidentCursor.wait(duration, signal);
  }

  click() {
    this.element.classList.remove('clicked');
    void this.element.offsetWidth;
    this.element.classList.add('clicked');
  }

  hide() { this.element.classList.remove('visible'); }

  static wait(milliseconds, signal) {
    if (signal?.aborted) return Promise.reject(new DOMException('Demonstration stopped', 'AbortError'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        resolve();
      }, milliseconds);
      const abort = () => {
        clearTimeout(timer);
        reject(new DOMException('Demonstration stopped', 'AbortError'));
      };
      signal?.addEventListener('abort', abort, {once: true});
    });
  }
}

globalThis.IncidentCursor = IncidentCursor;
