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

// Explains why a KQL query did not do what the learner meant, from nothing but the query text, the
// data view's field names and (when known) the result count. Verified against Kibana 9.5.2 by
// capturing the Elasticsearch request: `field is 503` / `field = 503` go out as one free-text
// multi_match across every field (0 hits), and a bare `503` is free text that only finds the right
// documents by luck. Returns null when there is nothing specific to say, so the caller keeps its
// generic wording.
const QueryExplainer = {
  operator: /(^|[\s(])(?:not\s+)?([A-Za-z_@][\w.@-]*)\s*(?:==?|\s(?:is|equals)\s)\s*("[^"]*"|[^\s()]+)/gi,

  // Clause text outside quoted strings, so a colon inside "/api/x:1" is not read as a field link.
  unquoted(query) {
    return query.replace(/"(?:[^"\\]|\\.)*"/g, match => ' '.repeat(match.length));
  },

  known(field, fields) {
    const base = field.replace(/\.(keyword|text)$/, '');
    return fields.has(field) || fields.has(base);
  },

  distance(left, right) {
    const previous = Array.from({length: right.length + 1}, (_, index) => index);
    for (let i = 1; i <= left.length; i += 1) {
      let diagonal = previous[0];
      previous[0] = i;
      for (let j = 1; j <= right.length; j += 1) {
        const above = previous[j];
        previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
        diagonal = above;
      }
    }
    return previous[right.length];
  },

  closest(field, fields) {
    let best = null;
    for (const candidate of fields) {
      const score = QueryExplainer.distance(field.toLowerCase(), candidate.toLowerCase());
      if (!best || score < best.score || (score === best.score && candidate.length < best.field.length)) best = {field: candidate, score};
    }
    // Only a near miss is worth suggesting; a distant "closest" field would be a guess.
    return best && best.score <= Math.max(2, Math.floor(field.length / 3)) ? best.field : null;
  },

  // {kind, message, fix?, field?, value?} for the first mistake found, or null.
  explain(query, fieldNames = [], {resultCount = null} = {}) {
    const text = String(query || '').trim();
    if (!text) return null;
    const fields = new Set(fieldNames);
    const bare = QueryExplainer.unquoted(text);

    // missing_colon: `field is value`, `field = value`, `field == value`, `field equals value`.
    // Matched on the original text (the value may be quoted), ignoring anything inside quotes.
    const wrong = [...text.matchAll(QueryExplainer.operator)]
      .filter(match => bare[match.index + match[1].length] === text[match.index + match[1].length])
      .filter(match => (fields.size ? QueryExplainer.known(match[2], fields) : match[2].includes('.')));
    if (wrong.length) {
      let fix = text;
      // Rewrite from the end so earlier offsets stay valid.
      for (const match of [...wrong].reverse()) {
        const start = match.index + match[1].length;
        const end = match.index + match[0].length;
        const negated = /^not\s+/i.test(text.slice(start, end));
        fix = `${fix.slice(0, start)}${negated ? 'not ' : ''}${match[2]}: ${match[3]}${fix.slice(end)}`;
      }
      return {
        kind: 'missing_colon',
        field: wrong[0][2],
        message: `Kibana searched every field for the text ‘${text}’. KQL links a field to a value with a colon.`,
        fix,
      };
    }

    const links = [...bare.matchAll(/(?<![\w.@-])([A-Za-z_@][\w.@-]*)\s*:/g)].map(match => ({field: match[1], index: match.index, end: match.index + match[0].length}));

    // unknown_field: the name before a colon is not a field in this data view.
    if (fields.size) {
      const unknown = links.find(link => !link.field.includes('*') && !QueryExplainer.known(link.field, fields));
      if (unknown) {
        const suggestion = QueryExplainer.closest(unknown.field, fields);
        return {
          kind: 'unknown_field',
          field: unknown.field,
          suggestion,
          message: `No field named ${unknown.field} in this data view.${suggestion ? ` Did you mean ${suggestion}?` : ''}`,
          fix: suggestion ? `${text.slice(0, unknown.index)}${suggestion}${text.slice(unknown.index + unknown.field.length)}` : undefined,
        };
      }
    }

    // value_absent: a valid `field: value`, but nothing in the window has that value.
    if (resultCount === 0 && links.length) {
      const link = links[links.length - 1];
      const raw = /^\s*("[^"]*"|[^\s()]+)/.exec(text.slice(link.end));
      const value = raw ? raw[1].replace(/^"|"$/g, '') : '';
      if (value && !/[*<>]/.test(value)) {
        return {
          kind: 'value_absent',
          field: link.field,
          value,
          message: `No ${link.field} values of ‘${value}’ in this window. Check the field's Top values.`,
        };
      }
    }

    // free_text_luck: a bare value with no field that happened to find documents.
    if (resultCount > 0 && !links.length && !/[<>=]/.test(bare) && !/\b(and|or|not)\b/i.test(bare) && !bare.includes('*')) {
      return {
        kind: 'free_text_luck',
        value: text,
        message: `This worked, but it searches every field for ${text}. Naming the field says what you mean.`,
      };
    }
    return null;
  },
};

globalThis.QueryExplainer = QueryExplainer;

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

  async typeValue(element, value, signal, coach) {
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
      coach?.clearActionTarget?.();
      await this.holdAction?.();
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

  async perform(command, coach, {timingScale = 1, signal, readBeat, holdAction} = {}) {
    if (command.type === 'orient') return null;
    if (command.type === 'request_diagnosis' || command.type === 'request_answer') return null;
    this.performing = true;
    this.readBeat = readBeat;
    this.holdAction = holdAction;
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
      this.holdAction = null;
    }
  }

  async pointAt(target, coach, timingScale, signal, activity, {activate = false, showClick = true, hold = true, targetName = null} = {}) {
    // Every application adapter uses this path. Reveal controls inside scrollable panels before
    // placing the spotlight or cursor, so the visible pointer lands on the control we act on.
    const informationOnly = !activate && !showClick;
    // Caption the action before that scroll, so the card says what is happening while the list moves.
    if (!informationOnly && activity) coach.showTarget(null, activity);
    await coach.cursor.reveal(target, {timingScale, signal});
    if (informationOnly) coach.showInfo(target, activity);
    else coach.showTarget(target, activity);
    // A pointer with no click is an explanation, not an action. Use the same timed reading beat
    // as the other cards so the note shows a countdown and advances automatically. Advance can
    // still finish the beat early, and the cursor must land before the action can continue.
    if (informationOnly) {
      const read = this.readBeat ? this.readBeat(activity) : coach.waitForAdvance(signal);
      await Promise.all([coach.cursor.moveTo(target, {timingScale, signal}), read]);
      coach.clearActionTarget?.();
      return;
    }
    await coach.cursor.moveTo(target, {timingScale, signal});
    // Discover can replace a control while the cursor travels to it. Clicking the detached node
    // looks convincing but does nothing, so reacquire the live control and move the cursor there.
    for (let attempts = 0; activate && target.isConnected === false; attempts += 1) {
      if (!targetName || attempts >= 3) throw new Error(`Kibana target disappeared before click: ${targetName || activity}`);
      target = await this.waitFor(targetName, 3000, signal);
      await coach.cursor.reveal(target, {timingScale, signal});
      coach.showTarget(target, activity);
      await coach.cursor.moveTo(target, {timingScale, signal});
    }
    if (showClick) coach.cursor.click();
    if (activate) target.click();
    if (activate && hold) {
      coach.clearActionTarget?.();
      await this.holdAction?.();
    }
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
    let number = null;
    let unit = null;
    let apply = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // Discover may redraw the picker while the first histogram loads. Re-open it and retry the
      // visible controls rather than silently changing the URL and skipping the demonstration.
      const liveToggle = attempt ? await this.waitFor('kibana.time_picker', 5000, signal) : toggle;
      await this.pointAt(liveToggle, coach, timingScale, signal, 'Open the time picker.', {activate: true, targetName: 'kibana.time_picker'});
      number = this.resolve('kibana.time_value');
      unit = this.resolve('kibana.time_unit');
      apply = this.resolve('kibana.time_apply');
      if (number && unit && apply) break;
      const customRange = await this.waitFor('kibana.time_custom_range', 1200, signal).catch(error => {
        if (error.name === 'AbortError') throw error;
        return null;
      });
      if (!customRange) continue;
      try {
        await this.pointAt(customRange, coach, timingScale, signal, 'Choose Custom range.', {activate: true, targetName: 'kibana.time_custom_range'});
      } catch (error) {
        if (error.name === 'AbortError' || attempt === 2) throw error;
        continue;
      }
      number = this.resolve('kibana.time_value');
      unit = this.resolve('kibana.time_unit');
      apply = this.resolve('kibana.time_apply');
      if (number && unit && apply) break;
    }
    if (!number || !unit || !apply) throw new Error('Kibana time picker controls did not remain available. Try this step again.');
    await this.pointAt(number, coach, timingScale, signal, `Click the Time value box, clear its old value, and type ${range.amount}.`, {activate: true, hold: false, targetName: 'kibana.time_value'});
    number = await this.waitFor('kibana.time_value', 3000, signal);
    await this.typeValue(number, range.amount, signal, coach);
    await this.pointAt(unit, coach, timingScale, signal, `Choose ${range.unitLabel} as the unit.`, {activate: true, hold: false, targetName: 'kibana.time_unit'});
    unit = await this.waitFor('kibana.time_unit', 3000, signal);
    const unitPattern = new RegExp(`^${range.unitName}s?(?: ago)?$`, 'i');
    const matchingOption = Array.from(unit.options).find(option => unitPattern.test(option.textContent.trim()));
    unit.value = matchingOption?.value || range.unitCode;
    unit.dispatchEvent(new Event('input', {bubbles: true}));
    unit.dispatchEvent(new Event('change', {bubbles: true}));
    coach.clearActionTarget?.();
    await this.holdAction?.();
    await this.pointAt(apply, coach, timingScale, signal, `Apply the Last ${range.amount} ${range.unitLabel} range.`, {activate: true, targetName: 'kibana.time_apply'});
    return {type: 'time_range_changed', details: command.value, state_after: {time_from: command.value.from, time_to: command.value.to}};
  }

  async enterQuery(query, coach, timingScale, signal, existingInput = null, activity = 'Click the query bar, clear the old search, and type the new query.') {
    const input = existingInput || await this.waitFor('kibana.query_bar', 20000, signal);
    await this.pointAt(input, coach, timingScale, signal, activity, {activate: true, hold: false});
    await this.typeValue(input, query, signal, coach);
    const submit = this.resolve('kibana.query_submit');
    if (submit) {
      await this.pointAt(submit, coach, timingScale, signal, 'Run the query and refresh the results.', {activate: true});
    } else {
      input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', code: 'Enter', bubbles: true}));
      await this.holdAction?.();
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
    await this.pointAt(fieldInput, coach, timingScale, signal, `Choose the ${filter.field} field.`, {activate: true, hold: false});
    await this.typeValue(fieldInput, filter.field, signal, coach);
    await this.pickComboOption(filter.field, signal);
    const operatorLabel = negate ? 'is not' : 'is';
    const operatorInput = await this.waitFor('kibana.filter_operator', 8000, signal);
    await this.pointAt(operatorInput, coach, timingScale, signal, `Set the operator to "${operatorLabel}".`, {activate: true, hold: false});
    await this.typeValue(operatorInput, operatorLabel, signal, coach);
    await this.pickComboOption(operatorLabel, signal, true);
    const valueInput = await this.waitFor('kibana.filter_params', 8000, signal);
    await this.pointAt(valueInput, coach, timingScale, signal, `Enter the value ${filter.value}.`, {activate: true, hold: false});
    await this.typeValue(valueInput, String(filter.value), signal, coach);
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
    await this.holdAction?.();
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

  // The demonstration's "What this shows" beat points at what a step produced, not at the control it
  // used. Resolve that evidence once Kibana has drawn it — the hit count after a refetch, Top values
  // after their stats load, the doc viewer's rows after scrolling them into view. Targets are
  // functions returning the live element, because a virtualized row can be re-rendered while it is
  // ringed; columns are result-table columns to ring. Either may be empty: the beat still explains.
  async findEvidence(command, signal) {
    const columns = command.learning_focus?.length ? command.learning_focus
      : command.type === 'add_column' && command.value?.field ? [command.value.field] : [];
    const focus = command.evidence_focus || this.defaultEvidenceFocus(command);
    if (focus?.kind === 'columns') return {targets: [], columns: focus.fields || columns};
    let targets = [];
    try {
      if (focus) targets = await this.evidenceTargets(focus, signal);
    } catch (error) {
      if (error.name === 'AbortError') throw error;
    }
    return {targets, columns};
  }

  defaultEvidenceFocus(command) {
    const value = command.value || {};
    if (command.type === 'set_time_range') return {kind: 'histogram'};
    if (command.type === 'enter_kql') return {kind: 'query'};
    if (command.type === 'add_filter') return {kind: 'filter', field: value.field, value: value.value};
    if (command.type === 'open_field_statistics' || command.type === 'inspect_field') return {kind: 'top_values', field: value.field};
    if (command.type === 'expand_document') return {kind: 'document', fields: []};
    return null;
  }

  async evidenceTargets(focus, signal) {
    const registered = name => () => this.resolve(name);
    if (focus.kind === 'top_values') return [await this.topValuesEvidence(focus, signal)];
    if (focus.kind === 'document') return this.documentEvidence(focus.fields || [], signal);
    await this.resultsSettled(signal);
    if (focus.kind === 'histogram') return [registered('kibana.histogram'), registered('kibana.result_count')];
    if (focus.kind === 'query') return [registered('kibana.query_bar'), registered('kibana.result_count')];
    if (focus.kind === 'filter') return [() => this.findFilterPill(focus.field, focus.value), registered('kibana.result_count')];
    return [];
  }

  // Discover keeps the previous hit count on screen while it refetches, and its global loading
  // indicator doesn't track that search. Wait for its own busy markers (the same ones the observer
  // reads) to clear — allowing a moment for one to appear — so the beat never rings a stale count.
  async resultsSettled(signal, {grace = 600, timeout = 8000} = {}) {
    const busy = () => document.querySelector("[data-test-subj='discoverDataGridUpdating'], [data-test-subj='loadingSpinner'], [data-test-subj='globalLoadingIndicator']");
    const startedAt = Date.now();
    let sawBusy = false;
    while (Date.now() - startedAt < timeout) {
      if (busy()) sawBusy = true;
      else if (sawBusy || Date.now() - startedAt >= grace) return;
      await this.wait(100, signal);
    }
  }

  // The pill for field (and value, when its test subject carries it); Add filter names the base field
  // and a Top values "+" its `.keyword` multi-field, so compare without the suffix.
  findFilterPill(field, value) {
    const pills = [...document.querySelectorAll("[data-test-subj*='filter-key-']")].map(node => {
      const subject = node.getAttribute('data-test-subj') || '';
      return {
        node,
        field: subject.match(/filter-key-([^\s]+)/)?.[1]?.replace(/\.(keyword|text)$/, ''),
        value: subject.match(/filter-value-([^\s]+)/)?.[1],
      };
    });
    const sameField = pills.filter(pill => pill.field === field);
    return (sameField.find(pill => value != null && pill.value === String(value)) || sameField[0] || pills[pills.length - 1])?.node || null;
  }

  // A field's Top values popover (verified 9.5.2): the list renders once its stats load, one
  // `dscFieldStats-topValues-bucket` per value. Ring the row for `value`, or the whole list.
  async topValuesEvidence({field, value}, signal) {
    const popover = () => [...document.querySelectorAll('[data-popover-panel]')].filter(panel => panel.getClientRects().length)
      .find(panel => !field || panel.querySelector("[data-test-subj='fieldPopoverHeader_fieldDisplayName']")?.textContent?.trim() === field);
    const list = () => popover()?.querySelector("[data-test-subj='dscFieldStats-topValues']");
    const deadline = Date.now() + 8000;
    while (!list() && Date.now() < deadline) await this.wait(100, signal);
    const row = () => value == null ? null : [...(list()?.querySelectorAll("[data-test-subj='dscFieldStats-topValues-bucket']") || [])]
      .find(bucket => bucket.querySelector("[data-test-subj='dscFieldStats-topValues-formattedFieldValue']")?.textContent?.trim() === String(value));
    return () => row() || list() || popover() || null;
  }

  // The expanded event (verified 9.5.2): the doc viewer lists fields as `tableDocViewRow-<field>-name`
  // / `-value` cells, 25 rows to a page, inside a scrolling flyout body — so the fields a step needs
  // can be off-screen or on another page. Walk the page to learn where each sits; if one is on another
  // page, show 100 rows and walk again. Then pin them, which lifts them to the top of the table side
  // by side; without pin controls, scroll so they share the view (or start at the first).
  async documentEvidence(fields, signal) {
    const viewer = await this.waitFor('kibana.doc_viewer', 8000, signal);
    const anyRow = () => viewer.querySelector("[data-test-subj^='tableDocViewRow-']");
    const deadline = Date.now() + 8000;
    while (!anyRow() && Date.now() < deadline) await this.wait(100, signal);
    const row = field => {
      const name = document.querySelector(`[data-test-subj='docViewerFlyout'] [data-test-subj='tableDocViewRow-${String(field).replace(/['\\]/g, '\\$&')}-name']`);
      return name?.closest("[role='row'], tr") || name;
    };
    const scroller = fields.length && anyRow() ? this.scrollableAncestor(anyRow(), viewer) : null;
    if (scroller) {
      let found = await this.locateRows(fields, row, scroller, signal);
      if (found.size < fields.length && await this.showMoreDocumentRows(viewer, signal)) {
        found = await this.locateRows(fields, row, scroller, signal);
      }
      if (found.size && await this.pinDocumentFields([...found.keys()], row, scroller, signal)) {
        scroller.scrollTop = 0;
      } else if (found.size) {
        const top = Math.min(...[...found.values()].map(span => span.top));
        const bottom = Math.max(...[...found.values()].map(span => span.bottom));
        const room = scroller.clientHeight;
        scroller.scrollTop = Math.max(0, bottom - top <= room ? top - (room - (bottom - top)) / 2 : top - 12);
      }
      await this.wait(150, signal);
    }
    return fields.map(field => () => row(field));
  }

  // Pin each field (verified 9.5.2: unifiedDocViewer_pinControlButton_<field>, labelled "Pin field" /
  // "Unpin field"; Kibana keeps pins per data view, and every run has its own). Pinning moves a row,
  // so find each one afresh. False when a field has no pin control to use.
  async pinDocumentFields(fields, row, scroller, signal) {
    for (const field of fields) {
      await this.locateRows([field], row, scroller, signal);
      const pin = document.querySelector(`[data-test-subj='docViewerFlyout'] [data-test-subj='unifiedDocViewer_pinControlButton_${String(field).replace(/['\\]/g, '\\$&')}']`);
      if (!pin) return false;
      if (/unpin/i.test(pin.getAttribute('aria-label') || '')) continue;
      this.performing = true;
      try { pin.click(); } finally { this.performing = false; }
      await this.wait(250, signal);
    }
    return true;
  }

  // Scroll through the doc viewer once, recording where each field's row sits in the scrolled content.
  async locateRows(fields, row, scroller, signal) {
    const found = new Map();
    const record = () => {
      const origin = scroller.getBoundingClientRect().top - scroller.scrollTop;
      for (const field of fields) {
        const rect = row(field)?.getBoundingClientRect();
        if (rect?.height && !found.has(field)) found.set(field, {top: rect.top - origin, bottom: rect.bottom - origin});
      }
    };
    scroller.scrollTop = 0;
    await this.wait(120, signal);
    record();
    while (found.size < fields.length && scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1) {
      scroller.scrollTop += Math.max(80, Math.round(scroller.clientHeight * 0.75));
      await this.wait(120, signal);
      record();
    }
    return found;
  }

  // Put the doc viewer's fields on one page (verified 9.5.2: its "Rows per page" control is
  // tablePaginationPopoverButton → tablePagination-100-rows; Kibana remembers it as discover:pageSize).
  async showMoreDocumentRows(viewer, signal) {
    const button = viewer.querySelector("[data-test-subj='tablePaginationPopoverButton']");
    if (!button) return false;
    this.performing = true;
    try {
      button.click();
      const choice = () => document.querySelector("[data-popover-panel] [data-test-subj='tablePagination-100-rows']");
      const deadline = Date.now() + 2000;
      while (!choice() && Date.now() < deadline) await this.wait(100, signal);
      const option = choice();
      if (!option) return false;
      option.click();
      await this.wait(400, signal);
      return true;
    } finally {
      this.performing = false;
    }
  }

  scrollableAncestor(node, boundary) {
    for (let element = node?.parentElement; element && element !== boundary.parentElement; element = element.parentElement) {
      const overflow = getComputedStyle(element).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && element.scrollHeight > element.clientHeight + 4) return element;
    }
    return null;
  }

  // Close the popovers a demonstration step opened and left up (a field's Top values), so they don't
  // pile up over the next step's controls and evidence. Verified 9.5.2: an Escape keydown inside the
  // panel closes it. The doc viewer is a flyout, not a popover, so an opened event stays open.
  closeTransientPopovers() {
    const panels = [...document.querySelectorAll('[data-popover-panel]')].filter(panel => panel.getClientRects().length);
    this.performing = true;
    try {
      for (const panel of panels) {
        (panel.querySelector('[tabindex], button') || panel)
          .dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true}));
      }
    } finally {
      this.performing = false;
    }
  }

  // Discover's URL state: the parsed `_a` (app) and `_g` (global) rison plus what is needed to write
  // it back. Null when this page has no Discover state to read.
  readDiscoverUrlState() {
    const hash = location.hash || '';
    const split = hash.indexOf('?');
    if (split < 0 || !/\/app\/discover/.test(location.pathname)) return null;
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
    if (!app || !global) return null;
    return {hash, split, params, app, global};
  }

  // The visible candidate for target `name` whose text names `text` (a service, transaction, span,
  // chart value, entity or alert), else `fallback`. A pack names what to pick; a generic selector's
  // first match would be whichever row happens to come first.
  targetNaming(name, text, fallback) {
    if (text == null || text === '') return fallback;
    const wanted = String(text).toLowerCase();
    const candidates = (this.registry?.targets?.[name] || []).flatMap(selector => Array.from(document.querySelectorAll(selector)));
    return candidates.find(element => element.getClientRects().length && element.textContent.trim().toLowerCase().includes(wanted)) || fallback;
  }

  // What the learner is looking at, for the service to check evidence against: the time range, the
  // query (KQL or ES|QL) and the filter pills, read from the URL state Kibana keeps however they were
  // set (`_g`/`_a`, or APM's rangeFrom/rangeTo/kuery parameters). Null when the page carries none.
  currentView() {
    const hash = location.hash || '';
    const split = hash.indexOf('?');
    const raw = split < 0 ? (location.search || '').replace(/^\?/, '') : hash.slice(split + 1);
    const params = new Map(raw.split('&').filter(Boolean).map(part => {
      const at = part.indexOf('=');
      let value = at < 0 ? '' : part.slice(at + 1);
      try { value = decodeURIComponent(value); } catch (_error) { /* keep it encoded */ }
      return [at < 0 ? part : part.slice(0, at), value];
    }));
    const rison = key => {
      if (!params.get(key)) return {};
      try { return KibanaRison.parse(params.get(key)) || {}; } catch (_error) { return null; }
    };
    const app = rison('_a');
    const global = rison('_g');
    if (!app || !global) return null;
    const time = global.time || (params.has('rangeFrom') ? {from: params.get('rangeFrom'), to: params.get('rangeTo')} : null);
    const esql = typeof app.query?.esql === 'string' ? app.query.esql : null;
    const language = esql != null ? 'esql' : app.query?.language === 'lucene' ? 'lucene' : 'kql';
    const query = esql ?? (typeof app.query?.query === 'string' ? app.query.query : params.get('kuery') || '');
    const filters = [...(global.filters || []), ...(app.filters || [])].map(filter => {
      const meta = filter.meta || {};
      const value = meta.type === 'phrases' || meta.type === 'range' ? meta.params : meta.params?.query ?? meta.value;
      return {field: meta.key || null, type: meta.type || 'phrase', value: value ?? null, negate: Boolean(meta.negate), disabled: Boolean(meta.disabled)};
    });
    if (!time && !query && !filters.length) return null;
    return {app: location.pathname.match(/\/app\/([^/?#]+)/)?.[1] || '', time_from: time?.from || null, time_to: time?.to || null, language, query, filters};
  }

  // Put Discover's search back to `state` (see the service's restore_state): drop whatever query and
  // filter pills are applied now and apply the ones the completed steps established instead. The
  // window is kept unless `includeTime` asks for it too (it is only reset when the query and filters
  // alone don't bring results back). `merge` keeps the learner's own query and pills and only re-adds
  // earned filters that are missing; `timeOnly` touches nothing but the window. Returns false when the
  // page has no Discover state to rewrite.
  restoreDiscoverState(state = {}, {includeTime = false, merge = false, timeOnly = false} = {}) {
    const current = this.readDiscoverUrlState();
    if (!current) return false;
    const {hash, split, params, app, global} = current;
    const dataViewId = app.dataSource?.dataViewId || app.index;
    const esql = typeof app.query?.esql === 'string';
    const pill = filter => {
      const value = filter.value == null ? '' : String(filter.value);
      return {
        '$state': {store: 'appState'},
        meta: {alias: null, disabled: false, index: dataViewId, key: filter.field, negate: Boolean(filter.negate), params: {query: value}, type: 'phrase'},
        query: {match_phrase: {[filter.field]: value}},
      };
    };
    if (timeOnly) {
      includeTime = true;
    } else if (merge) {
      const existing = [...(app.filters || []), ...(global.filters || [])];
      const holds = filter => existing.some(item => !item.meta?.disabled
        && String(item.meta?.key || '').replace(/\.(keyword|text)$/, '') === filter.field
        && String(item.meta?.params?.query ?? '') === String(filter.value ?? '')
        && Boolean(item.meta?.negate) === Boolean(filter.negate));
      app.filters = [...(app.filters || []), ...(state.filters || []).filter(filter => !holds(filter)).map(pill)];
    } else {
      if (!esql) app.query = {language: 'kuery', query: state.query || ''};
      app.filters = (state.filters || []).map(pill);
      global.filters = [];
    }
    const time = state.time || state.baseline_time;
    if (includeTime && time?.from) global.time = {from: time.from, to: time.to || 'now'};
    this.writeDiscoverUrlState(current, app, global);
    return true;
  }

  // Run an ES|QL query through Discover's URL state. 9.5's ES|QL editor is Monaco, which ignores
  // synthetic typing, so the coach points at the editor and applies the query this way instead.
  runEsql(query) {
    const current = this.readDiscoverUrlState();
    if (!current) return false;
    this.writeDiscoverUrlState(current, {...current.app, dataSource: {type: 'esql'}, query: {esql: query}}, current.global);
    return true;
  }

  writeDiscoverUrlState({hash, split, params}, app, global) {
    const encode = value => encodeURIComponent(KibanaRison.encode(value)).replace(/%(21|27|28|29|2A|2C|3A|40|24)/gi, escaped => decodeURIComponent(escaped));
    const replaced = new Map([['_a', encode(app)], ['_g', encode(global)]]);
    const rebuilt = params.map(([name, value]) => replaced.has(name)
      ? `${name}=${replaced.get(name)}`
      : value == null ? name : `${name}=${encodeURIComponent(value)}`);
    for (const [name, value] of replaced) if (!params.some(([key]) => key === name)) rebuilt.push(`${name}=${value}`);
    const next = `${hash.slice(0, split)}?${rebuilt.join('&')}`;
    if (next !== hash) location.hash = next;
  }

  // Field names the query explainer can check a query against: the Discover sidebar's field rows
  // plus, once loadFieldNames() has fetched them, every field of the current data view (the sidebar
  // collapses its Empty/Meta groups, so it alone would call real fields unknown).
  fieldNames() {
    const names = new Set(this.dataViewFields?.names || []);
    for (const node of document.querySelectorAll("[data-test-subj^='dscFieldListPanelField-']")) {
      names.add(node.getAttribute('data-test-subj').replace(/^dscFieldListPanelField-/, ''));
    }
    return [...names];
  }

  async loadFieldNames() {
    const dataViewId = (() => {
      const app = this.readDiscoverUrlState()?.app;
      return app?.dataSource?.dataViewId || app?.index;
    })();
    if (!dataViewId || this.dataViewFields?.id === dataViewId) return this.fieldNames();
    const space = location.pathname.match(/^\/s\/([^/]+)/)?.[1];
    try {
      const response = await fetch(`${space ? `/s/${space}` : ''}/api/data_views/data_view/${encodeURIComponent(dataViewId)}`, {credentials: 'same-origin'});
      if (response.ok) {
        const body = await response.json();
        this.dataViewFields = {id: dataViewId, names: Object.keys(body.data_view?.fields || {})};
      }
    } catch (_error) { /* the sidebar's fields are still usable */ }
    return this.fieldNames();
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
