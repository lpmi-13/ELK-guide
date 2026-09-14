class KibanaAdapter {
  constructor() {
    this.registry = null;
    this.performing = false;
    this.typingIntervalMs = 70;
  }

  async initialize() {
    const registryUrl = globalThis.chrome?.runtime?.getURL
      ? chrome.runtime.getURL('selectors/kibana-9.5.json')
      : '/incident-coach/assets/selectors/kibana-9.5.json';
    this.registry = await fetch(registryUrl).then(response => response.json());
  }

  resolve(name) {
    for (const selector of this.registry?.targets?.[name] || []) {
      const element = document.querySelector(selector);
      if (element && element.getClientRects().length) return element;
    }
    return null;
  }

  setNativeValue(element, value, {data = value, inputType = 'insertText', commit = true} = {}) {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(new InputEvent('input', {bubbles: true, inputType, data}));
    if (commit) element.dispatchEvent(new Event('change', {bubbles: true}));
  }

  async typeValue(element, value, signal) {
    element.focus();
    this.setNativeValue(element, '', {data: null, inputType: 'deleteContentBackward', commit: false});
    let typed = '';
    const characters = Array.from(String(value));
    for (const [index, character] of characters.entries()) {
      if (signal?.aborted) throw new DOMException('Demonstration stopped', 'AbortError');
      element.dispatchEvent(new KeyboardEvent('keydown', {key: character, bubbles: true}));
      typed += character;
      this.setNativeValue(element, typed, {data: character, commit: false});
      element.dispatchEvent(new KeyboardEvent('keyup', {key: character, bubbles: true}));
      if (index < characters.length - 1) await this.wait(this.typingIntervalMs, signal);
    }
    element.dispatchEvent(new Event('change', {bubbles: true}));
  }

  async waitFor(name, timeout = 20000, signal) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const element = this.resolve(name);
      if (element) return element;
      await this.wait(100, signal);
    }
    throw new Error(`Kibana target not found: ${name}`);
  }

  async perform(command, coach, {timingScale = 1, signal} = {}) {
    if (command.type === 'orient') return null;
    if (command.type === 'request_diagnosis' || command.type === 'request_answer') return null;
    this.performing = true;
    try {
      const applicationAdapter = (globalThis.KibanaApplicationAdapters || []).find(item => item.commands.has(command.type));
      if (applicationAdapter) return await applicationAdapter.perform(command, this, coach, {timingScale, signal});
      // add_filter drives the Add-filter popover and resolves its own targets, so it must not
      // pre-resolve command.target (packs historically point it at the unregistered filter bar).
      if (command.type === 'add_filter') return await this.addFilter(command.value, coach, timingScale, signal);
      const target = await this.waitFor(command.target, 20000, signal);
      if (command.type === 'set_time_range') return await this.setTimeRange(command, target, coach, timingScale, signal);
      if (command.type === 'enter_query') return await this.enterQuery(command.value, coach, timingScale, signal, target);
      if (command.type === 'open_trace') return await this.openTrace(command, target, coach, timingScale, signal);
      throw new Error(`Unsupported semantic command: ${command.type}`);
    } finally {
      this.performing = false;
    }
  }

  async pointAt(target, coach, timingScale, signal, activity, {activate = false, showClick = true} = {}) {
    coach.showTarget(target, activity);
    await coach.cursor.moveTo(target, {timingScale, signal});
    if (showClick) coach.cursor.click();
    if (activate) target.click();
  }

  relativeTimeRange(value = {}) {
    const relative = /^now-(\d+)([mhdw])$/i.exec(String(value?.from || ''));
    const amount = relative?.[1] || '10';
    const unitCode = (relative?.[2] || 'm').toLowerCase();
    const unitName = {m: 'minute', h: 'hour', d: 'day', w: 'week'}[unitCode] || 'minute';
    return {amount, unitCode, unitName, unitLabel: `${unitName}${amount === '1' ? '' : 's'}`};
  }

  async setTimeRange(command, toggle, coach, timingScale, signal) {
    const range = this.relativeTimeRange(command.value);
    await this.pointAt(toggle, coach, timingScale, signal, 'Open the time picker.', {activate: true});
    await this.wait(250 * timingScale, signal);
    let number = this.resolve('kibana.time_value');
    let unit = this.resolve('kibana.time_unit');
    let apply = this.resolve('kibana.time_apply');
    if (!number || !unit || !apply) {
      const customRange = await this.waitFor('kibana.time_custom_range', 5000, signal).catch(() => null);
      if (customRange) {
        await this.pointAt(customRange, coach, timingScale, signal, 'Choose Custom range.', {activate: true});
        number = await this.waitFor('kibana.time_value', 5000, signal).catch(() => null);
        unit = await this.waitFor('kibana.time_unit', 5000, signal).catch(() => null);
        apply = await this.waitFor('kibana.time_apply', 5000, signal).catch(() => null);
      }
    }
    if (number && unit && apply) {
      await this.pointAt(number, coach, timingScale, signal, `Click the Time value box, clear its old value, and type ${range.amount}.`, {activate: true});
      await this.typeValue(number, range.amount, signal);
      await this.pointAt(unit, coach, timingScale, signal, `Choose ${range.unitLabel} as the unit.`, {activate: true});
      const unitPattern = new RegExp(`^${range.unitName}s?(?: ago)?$`, 'i');
      const matchingOption = Array.from(unit.options).find(option => unitPattern.test(option.textContent.trim()));
      unit.value = matchingOption?.value || range.unitCode;
      unit.dispatchEvent(new Event('input', {bubbles: true}));
      unit.dispatchEvent(new Event('change', {bubbles: true}));
      await this.pointAt(apply, coach, timingScale, signal, `Apply the Last ${range.amount} ${range.unitLabel} range.`, {activate: true});
    } else {
      const hash = location.hash;
      const globalState = `_g=(time:(from:'${command.value.from}',to:'${command.value.to}'))`;
      location.hash = hash.includes('_g=') ? hash.replace(/_g=\([^&]*\)/, globalState) : `${hash}${hash.includes('?') ? '&' : '?'}${globalState}`;
    }
    return {type: 'time_range_changed', details: command.value, state_after: {time_from: command.value.from, time_to: command.value.to}};
  }

  async enterQuery(query, coach, timingScale, signal, existingInput = null, activity = 'Click the query bar, clear the old search, and type the new query.') {
    const input = existingInput || await this.waitFor('kibana.query_bar', 20000, signal);
    await this.pointAt(input, coach, timingScale, signal, activity, {activate: true});
    await this.typeValue(input, query, signal);
    const submit = this.resolve('kibana.query_submit');
    if (submit) {
      await this.pointAt(submit, coach, timingScale, signal, 'Run the query and refresh the results.', {activate: true});
    } else {
      input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', code: 'Enter', bubbles: true}));
    }
    return {type: 'query_submitted', details: {query}, state_after: {query}};
  }

  async addFilter(filter, coach, timingScale, signal) {
    // Kibana 9.5.2 encodes negation in the operator ("is not"); honour an explicit negate flag
    // or a "not" operator. Verified popover selectors: addFilter -> filterFieldSuggestionList ->
    // filterOperatorList -> filterParams -> saveFilter. Any failure falls back to a KQL clause.
    const negate = filter.negate === true || /\bnot\b/i.test(String(filter.operator || ''));
    try {
      return await this.addFilterViaPopover(filter, negate, coach, timingScale, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      const input = await this.waitFor('kibana.query_bar', 20000, signal);
      const clause = `${negate ? 'not ' : ''}${filter.field}: "${filter.value}"`;
      const query = input.value.trim() ? `(${input.value.trim()}) and ${clause}` : clause;
      await this.enterQuery(query, coach, timingScale, signal, input, `Add ${clause} to the query.`);
      return {type: 'filter_added', details: filter, state_after: {query, filters: [{field: filter.field, value: filter.value, negate}]}};
    }
  }

  async addFilterViaPopover(filter, negate, coach, timingScale, signal) {
    const addButton = await this.waitFor('kibana.add_filter', 20000, signal);
    await this.pointAt(addButton, coach, timingScale, signal, 'Open Add filter.', {activate: true});
    const fieldInput = await this.waitFor('kibana.filter_field', 8000, signal);
    await this.pointAt(fieldInput, coach, timingScale, signal, `Choose the ${filter.field} field.`, {activate: true});
    await this.typeValue(fieldInput, filter.field, signal);
    await this.pickComboOption(filter.field, signal);
    const operatorLabel = negate ? 'is not' : 'is';
    const operatorInput = await this.waitFor('kibana.filter_operator', 8000, signal);
    await this.pointAt(operatorInput, coach, timingScale, signal, `Set the operator to "${operatorLabel}".`, {activate: true});
    await this.typeValue(operatorInput, operatorLabel, signal);
    await this.pickComboOption(operatorLabel, signal, true);
    const valueInput = await this.waitFor('kibana.filter_params', 8000, signal);
    await this.pointAt(valueInput, coach, timingScale, signal, `Enter the value ${filter.value}.`, {activate: true});
    await this.typeValue(valueInput, String(filter.value), signal);
    const save = await this.waitFor('kibana.filter_save', 8000, signal);
    await this.pointAt(save, coach, timingScale, signal, `Apply the ${negate ? 'is not' : 'is'} filter.`, {activate: true});
    await this.wait(400 * timingScale, signal);
    return {type: 'filter_added', details: filter, state_after: {filters: [{field: filter.field, value: filter.value, negate}]}};
  }

  async pickComboOption(text, signal, exact = false) {
    await this.wait(400, signal);
    const options = [...document.querySelectorAll("[data-test-subj^='comboBoxOptionsList'] [role='option'], .euiComboBoxOption__content")];
    const norm = value => String(value).trim().toLowerCase();
    const match = options.find(option => exact ? norm(option.textContent) === norm(text) : norm(option.textContent).includes(norm(text))) || options[0];
    if (!match) throw new Error(`No combo option matched "${text}"`);
    match.click();
  }

  async openTrace(command, toggle, coach, timingScale, signal) {
    const visibleTraceElement = this.resolve('kibana.first_trace_value');
    const visibleTrace = visibleTraceElement?.textContent?.trim() || '';
    await this.pointAt(toggle, coach, timingScale, signal, 'Expand the first slow result so we can inspect its fields.', {activate: true});
    await this.wait(350 * timingScale, signal);
    const traceElement = this.resolve('kibana.trace_field');
    const expandedTrace = traceElement?.matches?.("[data-test-subj='tableDocViewRow-trace.id-value']") ? traceElement.textContent.trim() : '';
    const traceId = visibleTrace || expandedTrace;
    if (!traceId) throw new Error('Expanded document did not expose trace.id');
    const traceSource = expandedTrace ? traceElement : visibleTraceElement;
    if (traceSource) {
      await this.pointAt(traceSource, coach, timingScale, signal, 'Read trace.id. Every service involved in this request carries this same ID.', {showClick: false});
    }
    const traceQuery = `scenario.id: "${command.run_id}" and trace.id: "${traceId}"`;
    const queryInput = await this.waitFor('kibana.query_bar', 20000, signal);
    await this.enterQuery(
      traceQuery,
      coach,
      timingScale,
      signal,
      queryInput,
      'Pivot to the trace: replace the service filter with this trace ID so all services in the same request appear.',
    );
    await this.wait(Math.min(6000, 500 * timingScale), signal);
    return {type: 'trace_opened', details: {trace_id: traceId}, state_after: {trace_id: traceId, query: traceQuery}};
  }

  wait(milliseconds, signal) {
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

globalThis.KibanaAdapter = KibanaAdapter;
