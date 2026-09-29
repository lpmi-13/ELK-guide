// Minimal rison codec for Discover's URL state (`_g` / `_a`). Rewriting that state is the reliable
// way to put a search back as it should be: Discover re-syncs its query, filters and time window
// from the URL, which avoids driving several fragile popovers just to delete what the learner added.
const KibanaRison = {
  notIdChar: " '!:(),*@$",

  parse(text) {
    let index = 0;
    const fail = () => { throw new Error(`Unreadable URL state near "${text.slice(index, index + 12)}"`); };
    const value = () => {
      const char = text[index];
      if (char === '(') {
        index += 1;
        const object = {};
        while (text[index] !== ')') {
          if (index >= text.length) fail();
          const key = value();
          if (text[index] !== ':') fail();
          index += 1;
          object[key] = value();
          if (text[index] === ',') index += 1;
        }
        index += 1;
        return object;
      }
      if (char === '!') {
        const next = text[index + 1];
        index += 2;
        if (next === 't') return true;
        if (next === 'f') return false;
        if (next === 'n') return null;
        if (next !== '(') fail();
        const list = [];
        while (text[index] !== ')') {
          if (index >= text.length) fail();
          list.push(value());
          if (text[index] === ',') index += 1;
        }
        index += 1;
        return list;
      }
      if (char === "'") {
        index += 1;
        let result = '';
        while (text[index] !== "'") {
          if (index >= text.length) fail();
          if (text[index] === '!') index += 1;
          result += text[index];
          index += 1;
        }
        index += 1;
        return result;
      }
      const number = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(index));
      if (number) {
        index += number[0].length;
        return Number(number[0]);
      }
      const start = index;
      while (index < text.length && !KibanaRison.notIdChar.includes(text[index])) index += 1;
      if (index === start) fail();
      return text.slice(start, index);
    };
    const result = value();
    if (index !== text.length) fail();
    return result;
  },

  encode(value) {
    if (value === null || value === undefined) return '!n';
    if (value === true) return '!t';
    if (value === false) return '!f';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '!n';
    if (Array.isArray(value)) return `!(${value.map(item => KibanaRison.encode(item)).join(',')})`;
    if (typeof value === 'object') {
      return `(${Object.entries(value).map(([key, item]) => `${KibanaRison.encode(key)}:${KibanaRison.encode(item)}`).join(',')})`;
    }
    const text = String(value);
    const bareId = text && !/^[-0-9]/.test(text) && ![...text].some(char => KibanaRison.notIdChar.includes(char));
    return bareId ? text : `'${text.replace(/!/g, '!!').replace(/'/g, "!'")}'`;
  },
};

globalThis.KibanaRison = KibanaRison;

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
    const typing = {skip: false};
    this.activeTyping = typing;
    try {
      for (const [index, character] of characters.entries()) {
        if (signal?.aborted) throw new DOMException('Demonstration stopped', 'AbortError');
        if (typing.skip) {
          this.setNativeValue(element, String(value), {data: String(value).slice(typed.length), commit: false});
          break;
        }
        element.dispatchEvent(new KeyboardEvent('keydown', {key: character, bubbles: true}));
        typed += character;
        this.setNativeValue(element, typed, {data: character, commit: false});
        element.dispatchEvent(new KeyboardEvent('keyup', {key: character, bubbles: true}));
        if (index < characters.length - 1) await this.wait(this.typingIntervalMs, signal);
      }
      element.dispatchEvent(new Event('change', {bubbles: true}));
    } finally {
      if (this.activeTyping === typing) this.activeTyping = null;
    }
  }

  advanceTyping() {
    if (!this.activeTyping) return false;
    this.activeTyping.skip = true;
    return true;
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

  // Resolve a step's anchor for the opening spotlight, tolerating a target the registry does not hold
  // (some packs point add_filter at the filter bar) or one that never appears — returning null instead
  // of throwing. The anchor is only the control to highlight while the "what / why" cards are read;
  // perform() resolves and drives the controls the step actually acts on, so a missing anchor must
  // never abort the demonstration. A stop/pause (AbortError) still propagates so the run unwinds.
  async resolveAnchor(name, signal) {
    if (!name || !this.registry?.targets?.[name]) return this.resolve(name);
    try {
      return await this.waitFor(name, 20000, signal);
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      return null;
    }
  }

  async perform(command, coach, {timingScale = 1, signal, readBeat} = {}) {
    if (command.type === 'orient') return null;
    if (command.type === 'request_diagnosis' || command.type === 'request_answer') return null;
    this.performing = true;
    this.readBeat = readBeat;
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
      this.readBeat = null;
    }
  }

  async pointAt(target, coach, timingScale, signal, activity, {activate = false, showClick = true} = {}) {
    // Every application adapter uses this path. Reveal controls inside scrollable panels before
    // placing the spotlight or cursor, so the visible pointer lands on the control we act on.
    await coach.cursor.reveal(target, {timingScale, signal});
    const informationOnly = !activate && !showClick;
    if (informationOnly) coach.showInfo(target, activity);
    else coach.showTarget(target, activity);
    // A pointer with no click is an explanation, not an action. Use the same timed reading beat
    // as the other cards so the note shows a countdown and advances automatically. Advance can
    // still finish the beat early, and the cursor must land before the action can continue.
    if (informationOnly) {
      const read = this.readBeat ? this.readBeat(activity) : coach.waitForAdvance(signal);
      await Promise.all([coach.cursor.moveTo(target, {timingScale, signal}), read]);
      return;
    }
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

  // Read the window Kibana currently has applied — from the `_g` global state in the URL (the source
  // of truth however it was set), falling back to the date picker's button label. Mirrors the action
  // observer's readTimeRange so the demonstration can tell when a range is already what it would set.
  currentTimeRange() {
    const href = (typeof location !== 'undefined' && location.href) || '';
    const candidates = [href];
    try { candidates.push(decodeURIComponent(href)); } catch (_error) { /* malformed escape */ }
    for (const text of candidates) {
      const match = text.match(/time:\(from:([^,]+),to:([^)]+)\)/);
      if (match) {
        const clean = value => value.replace(/^['"]|['"]$/g, '').trim();
        return {from: clean(match[1]), to: clean(match[2])};
      }
    }
    const node = document.querySelector("[data-test-subj='dateRangePickerControlButton']")
      || document.querySelector("[data-test-subj='superDatePickerShowDatesButton']")
      || document.querySelector("[data-test-subj='dateRangePickerInput']");
    const label = (node?.textContent || node?.value || '').trim();
    const relative = /last\s+(\d+)\s*(second|minute|hour|day|week)s?/i.exec(label);
    if (relative) {
      const unit = {second: 's', minute: 'm', hour: 'h', day: 'd', week: 'w'}[relative[2].toLowerCase()];
      return {from: `now-${relative[1]}${unit}`, to: 'now'};
    }
    return {from: '', to: ''};
  }

  async setTimeRange(command, toggle, coach, timingScale, signal) {
    const range = this.relativeTimeRange(command.value);
    // If the window is already exactly what we'd set, opening the picker to re-enter the same range
    // is a confusing no-op (e.g. an incident whose recommended window matches the view's default).
    // Point at the picker, say it's already correct, and complete the step without touching it.
    const target = {from: String(command.value?.from ?? '').trim().toLowerCase(), to: String(command.value?.to ?? 'now').trim().toLowerCase()};
    const current = this.currentTimeRange();
    if (target.from && current.from.toLowerCase() === target.from && (current.to || 'now').toLowerCase() === target.to) {
      await this.pointAt(toggle, coach, timingScale, signal, `The window is already the last ${range.amount} ${range.unitLabel}, so there's nothing to change here.`, {showClick: false});
      return {type: 'time_range_changed', details: command.value, state_after: {time_from: command.value.from, time_to: command.value.to}};
    }
    await this.pointAt(toggle, coach, timingScale, signal, 'Open the time picker.', {activate: true});
    await this.settle(250, timingScale, signal);
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
    await this.settle(400, timingScale, signal);
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
    await this.settle(350, timingScale, signal);
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

  // Put Discover's search back to `state` (see the service's restore_state): drop whatever query and
  // filter pills are applied now and apply the ones the completed steps established instead. The
  // window is kept unless `includeTime` asks for it too (it is only reset when the query and filters
  // alone don't bring results back). Returns false when the page has no Discover state to rewrite.
  restoreDiscoverState(state = {}, {includeTime = false} = {}) {
    const hash = location.hash || '';
    const split = hash.indexOf('?');
    if (split < 0 || !/\/app\/discover/.test(location.pathname)) return false;
    const params = hash.slice(split + 1).split('&').map(part => {
      const at = part.indexOf('=');
      return at < 0 ? [part, null] : [part.slice(0, at), decodeURIComponent(part.slice(at + 1))];
    });
    const read = key => {
      const entry = params.find(([name]) => name === key);
      if (!entry?.[1]) return {};
      try { return KibanaRison.parse(entry[1]); } catch (_error) { return null; }
    };
    const app = read('_a');
    const global = read('_g');
    if (!app || !global) return false;
    const dataViewId = app.dataSource?.dataViewId || app.index;
    const esql = typeof app.query?.esql === 'string';
    if (!esql) app.query = {language: 'kuery', query: state.query || ''};
    app.filters = (state.filters || []).map(filter => {
      const value = filter.value == null ? '' : String(filter.value);
      return {
        '$state': {store: 'appState'},
        meta: {alias: null, disabled: false, index: dataViewId, key: filter.field, negate: Boolean(filter.negate), params: {query: value}, type: 'phrase'},
        query: {match_phrase: {[filter.field]: value}},
      };
    });
    global.filters = [];
    const time = state.time || state.baseline_time;
    if (includeTime && time?.from) global.time = {from: time.from, to: time.to || 'now'};
    const encode = value => encodeURIComponent(KibanaRison.encode(value)).replace(/%(21|27|28|29|2A|2C|3A|40|24)/gi, escaped => decodeURIComponent(escaped));
    const replaced = new Map([['_a', encode(app)], ['_g', encode(global)]]);
    const rebuilt = params.map(([name, value]) => replaced.has(name)
      ? `${name}=${replaced.get(name)}`
      : value == null ? name : `${name}=${encodeURIComponent(value)}`);
    for (const [name, value] of replaced) if (!params.some(([key]) => key === name)) rebuilt.push(`${name}=${value}`);
    const next = `${hash.slice(0, split)}?${rebuilt.join('&')}`;
    if (next !== hash) location.hash = next;
    return true;
  }

  // A brief pause that only lets Kibana's DOM catch up after a click — a popover opening, a filter
  // applying. Unlike cursor moves and reading beats, a settle must NOT stretch with the demonstration's
  // slow timingScale (30×), or a quarter-second wait becomes a multi-second stall — e.g. the time
  // picker sitting open on "Open the time picker" for ~7s. Cap it at a short, deliberate beat while
  // leaving the un-scaled guided/"Show me" pace (timingScale 1) exactly as it was.
  settle(base, timingScale, signal) {
    return this.wait(Math.min(750, base * timingScale), signal);
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
