class KibanaAdapter {
  constructor() {
    this.registry = null;
    this.performing = false;
  }

  async initialize() {
    this.registry = await fetch(chrome.runtime.getURL('selectors/kibana-8.15.json')).then(response => response.json());
  }

  resolve(name) {
    for (const selector of this.registry?.targets?.[name] || []) {
      const element = document.querySelector(selector);
      if (element && element.getClientRects().length) return element;
    }
    return null;
  }

  setNativeValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertText', data: value}));
    element.dispatchEvent(new Event('change', {bubbles: true}));
  }

  async waitFor(name, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const element = this.resolve(name);
      if (element) return element;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Kibana target not found: ${name}`);
  }

  async perform(command, coach) {
    if (command.type === 'orient') return null;
    if (command.type === 'request_diagnosis') return null;
    this.performing = true;
    try {
      const target = await this.waitFor(command.target);
      await coach.cursor.moveTo(target);
      coach.cursor.click();
      if (command.type === 'set_time_range') return await this.setTimeRange(command, target);
      if (command.type === 'enter_query') return await this.enterQuery(command.value);
      if (command.type === 'add_filter') return await this.addFilter(command.value);
      if (command.type === 'open_trace') return await this.openTrace(target);
      throw new Error(`Unsupported semantic command: ${command.type}`);
    } finally {
      this.performing = false;
    }
  }

  async setTimeRange(command, toggle) {
    toggle.click();
    await new Promise(resolve => setTimeout(resolve, 250));
    const number = this.resolve('kibana.time_value');
    const unit = this.resolve('kibana.time_unit');
    const apply = this.resolve('kibana.time_apply');
    if (number && unit && apply) {
      this.setNativeValue(number, '10');
      unit.value = 'm';
      unit.dispatchEvent(new Event('change', {bubbles: true}));
      apply.click();
    } else {
      const hash = location.hash;
      const globalState = `_g=(time:(from:'${command.value.from}',to:'${command.value.to}'))`;
      location.hash = hash.includes('_g=') ? hash.replace(/_g=\([^&]*\)/, globalState) : `${hash}${hash.includes('?') ? '&' : '?'}${globalState}`;
    }
    return {type: 'time_range_changed', details: command.value, state_after: {time_from: command.value.from, time_to: command.value.to}};
  }

  async enterQuery(query) {
    const input = await this.waitFor('kibana.query_bar');
    input.focus();
    this.setNativeValue(input, query);
    const submit = this.resolve('kibana.query_submit');
    if (submit) submit.click(); else input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', code: 'Enter', bubbles: true}));
    return {type: 'query_submitted', details: {query}, state_after: {query}};
  }

  async addFilter(filter) {
    const input = await this.waitFor('kibana.query_bar');
    const clause = `${filter.field}: "${filter.value}"`;
    const query = input.value.trim() ? `(${input.value.trim()}) and ${clause}` : clause;
    await this.enterQuery(query);
    return {type: 'filter_added', details: filter, state_after: {query}};
  }

  async openTrace(toggle) {
    const visibleTrace = this.resolve('kibana.first_trace_value')?.textContent?.trim() || '';
    toggle.click();
    await new Promise(resolve => setTimeout(resolve, 350));
    const traceElement = this.resolve('kibana.trace_field');
    const expandedTrace = traceElement?.matches?.("[data-test-subj='tableDocViewRow-trace.id-value']") ? traceElement.textContent.trim() : '';
    const traceId = visibleTrace || expandedTrace;
    if (!traceId) throw new Error('Expanded document did not expose trace.id');
    return {type: 'trace_opened', details: {trace_id: traceId}, state_after: {trace_id: traceId}};
  }
}

globalThis.KibanaAdapter = KibanaAdapter;
