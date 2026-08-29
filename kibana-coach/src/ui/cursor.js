class IncidentCursor {
  constructor(root) {
    this.element = document.createElement('div');
    this.element.className = 'incident-cursor';
    this.element.setAttribute('aria-hidden', 'true');
    this.element.innerHTML = '<span></span>';
    root.append(this.element);
  }

  async moveTo(target, {timingScale = 1, signal} = {}) {
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const duration = matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 0
      : Math.min(900, 650 * timingScale);
    this.element.classList.add('visible');
    this.element.style.setProperty('--incident-cursor-duration', `${duration}ms`);
    this.element.style.transform = `translate(${Math.round(rect.left + rect.width / 2)}px,${Math.round(rect.top + rect.height / 2)}px)`;
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
