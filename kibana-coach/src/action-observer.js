class KibanaActionObserver {
  constructor(adapter, report) {
    this.adapter = adapter;
    this.report = report;
    this.boundClick = event => this.onClick(event);
    this.boundKey = event => this.onKey(event);
  }

  start() {
    document.addEventListener('click', this.boundClick, true);
    document.addEventListener('keydown', this.boundKey, true);
    // Establish the current window as the baseline so we only report the learner's own change,
    // then poll the global-state time range. Polling catches windows set without a recognisable
    // click — dragging a selection on the date histogram, or browser back/forward — which the
    // click handler alone would miss.
    this.lastTimeSignature = this.timeSignature();
    this.rebaselineFilters();
    this.timePoll = setInterval(() => {
      if (this.adapter.performing) return;
      this.captureTimeRange(false);
      this.captureFilterRemoval();
    }, 700);
  }

  // Adopt the window currently applied as the new baseline, so a change the coach made itself (a
  // restored search) is not later reported by the poll as the learner's.
  rebaseline() {
    this.lastTimeSignature = this.timeSignature();
    this.rebaselineFilters();
  }

  rebaselineFilters() {
    this.lastFilters = this.readFilterPills();
  }

  // The search a report leaves behind — every pill and the query text — so the service can tell
  // when a filter an earlier step earned is no longer in force.
  searchState() {
    return {filters: this.readFilterPills(), query: this.queryValue()};
  }

  // Report a pill the learner took away — deleted or disabled — however they did it (the pill's own
  // popover, its clear button, "Clear all", browser back). Additions only move the baseline; the
  // click that applied them reports filter_added.
  captureFilterRemoval() {
    const filters = this.readFilterPills();
    const key = filter => `${filter.negate ? '-' : ''}${filter.field}=${filter.value}`;
    const active = new Set(filters.filter(filter => !filter.disabled).map(key));
    const lost = (this.lastFilters || []).filter(filter => !filter.disabled && !active.has(key(filter)));
    this.lastFilters = filters;
    if (!lost.length) return;
    const disabled = lost.every(filter => filters.some(item => item.disabled && key(item) === key(filter)));
    this.reportWithCount({type: disabled ? 'filter_disabled' : 'filter_removed', details: {...lost[0]}, state_after: {filters, query: this.queryValue()}});
  }

  stop() {
    document.removeEventListener('click', this.boundClick, true);
    document.removeEventListener('keydown', this.boundKey, true);
    clearInterval(this.timePoll);
  }

  queryValue() { return this.adapter.resolve('kibana.query_bar')?.value || ''; }

  // How many documents Discover shows once the search settles: 0 on its "No results" prompt, the
  // hit counter otherwise, null when it can't tell (another app, or still loading at the deadline).
  // A search that leaves nothing to read is a dead end, so the service must see the count rather
  // than accept a query that merely mentions the right field and value.
  async resultCount(timeout = 8000, fetchGrace = 1000) {
    if (this.appName() !== 'discover') return null;
    const resultsUi = () => document.querySelector("[data-test-subj='discoverQueryHits']") || KibanaActionObserver.noResultsShown();
    if (!resultsUi()) return null; // not a document view (e.g. an ES|QL chart), nothing to count
    // Discover keeps the previous hit count on screen for the ~1s its refetch takes, and Kibana's
    // global loading indicator does not track that search. So wait for Discover's own busy markers
    // (verified 9.5.2: the grid's "updating" overlay, the loading spinner) to appear and then clear;
    // if none shows within `fetchGrace`, no refetch happened and the count on screen is current.
    const busy = () => document.querySelector("[data-test-subj='discoverDataGridUpdating'], [data-test-subj='loadingSpinner'], [data-test-subj='globalLoadingIndicator']");
    const startedAt = Date.now();
    let sawBusy = false;
    while (Date.now() - startedAt < timeout) {
      if (busy()) sawBusy = true;
      else if (sawBusy || Date.now() - startedAt > fetchGrace) {
        if (KibanaActionObserver.noResultsShown()) return 0;
        const hits = document.querySelector("[data-test-subj='discoverQueryHits']")?.textContent || '';
        const count = Number(hits.replace(/[^\d]/g, ''));
        if (hits && Number.isFinite(count)) return count;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return null;
  }

  static noResultsShown() {
    const prompt = document.querySelector("[data-test-subj='discoverNoResults']");
    return Boolean(prompt && prompt.getClientRects().length);
  }

  // Report a search-shaping action once its results settle, carrying the measured count.
  reportWithCount(action) {
    this.resultCount().then(count => {
      if (count != null) action.state_after = {...(action.state_after || {}), result_count: count};
      this.report(action);
    });
  }

  appName() {
    return location.pathname.match(/\/app\/([^/?#]+)/)?.[1] || '';
  }

  // Read every applied filter pill as {field, value, negate}. Kibana encodes the field in a
  // `filter-key-<field>` token and negation in a `filter-negated` token on the pill's
  // data-test-subj, and renders "<field>: <value>" (or "NOT <field>: <value>") as its text;
  // we prefer the structured tokens and fall back to the text so a filter-out is recognised
  // even if only one signal is present. Version-specific — verify against live Kibana 9.5.2.
  readFilterPills() {
    const pills = [...document.querySelectorAll("[data-test-subj*='filter-key-'], [data-test-subj^='filter filter-enabled']")];
    return pills.map(node => {
      const subject = node.getAttribute('data-test-subj') || '';
      const text = (node.textContent || '').trim();
      const withoutNot = text.replace(/^NOT\s+/i, '');
      const keyToken = subject.match(/filter-key-([^\s]+)/);
      const valueToken = subject.match(/filter-value-([^\s]+)/);
      // Filtering from a field's top values applies the `.keyword` multi-field
      // (e.g. service.name.keyword); the scenario truth names the base field, so
      // normalize. The Add-filter popover already uses the base field name.
      const field = (keyToken ? keyToken[1] : withoutNot.split(':')[0].trim()).replace(/\.(keyword|text)$/, '');
      const value = (valueToken ? valueToken[1] : withoutNot.split(':').slice(1).join(':').trim()).replace(/^"|"$/g, '');
      const negate = /(^|\s)filter-negated(\s|$)/.test(subject) || /^NOT\s+/i.test(text);
      const disabled = /(^|\s)filter-disabled(\s|$)/.test(subject);
      return disabled ? {field, value, negate, disabled} : {field, value, negate};
    }).filter(filter => filter.field);
  }

  // Best-effort field name for a column toggle. The inspect goal accepts column_added /
  // column_removed without validating the field, so an empty result still progresses it.
  fieldFromSubject(subject, target) {
    const suffix = subject.match(/[-_]([\w.@]+)$/);
    if (suffix && !/^(button|column|field|add|remove)$/i.test(suffix[1])) return suffix[1];
    const cell = target?.closest?.('[data-gridcell-column-id]');
    return cell?.getAttribute('data-gridcell-column-id') || '';
  }

  // The data-test-subj of the field-list row whose preview popover a click opened, or '' when the
  // click was not on one. Kibana 9.5.2 wraps each field as `dscFieldListPanelField-<field>` around a
  // `field-<field>-showDetails` "Preview" button; a click can land on either or an inner icon, so we
  // resolve the container and confirm its subject really is a field row before reporting it.
  fieldPreviewSubject(target) {
    const container = target?.closest?.("[data-test-subj^='dscFieldListPanelField-'], [data-test-subj$='-showDetails']");
    const subject = container?.getAttribute?.('data-test-subj') || '';
    return /^dscFieldListPanelField-|-showDetails$/.test(subject) ? subject : '';
  }

  readAutoRefresh() {
    const toggle = document.querySelector("[data-test-subj='superDatePickerToggleRefreshButton']");
    const interval = document.querySelector("[data-test-subj='superDatePickerRefreshIntervalInput']")?.value || '';
    const paused = toggle ? /play|start|resume|paused/i.test(toggle.getAttribute('aria-label') || '') : undefined;
    return {type: 'auto_refresh_changed', details: {interval, paused}, state_after: {interval, paused}};
  }

  // Read Kibana's applied time window from the `_g` global state in the URL — the source of truth
  // however the range was set — falling back to the date picker's label. Kibana 9.5.2 renamed the
  // picker (dateRangePicker*/euiQuickSelect*), so we read the resulting state rather than depend on
  // any single control's data-test-subj.
  readTimeRange() {
    const href = (typeof location !== 'undefined' && location.href) || '';
    const candidates = [href];
    try { candidates.push(decodeURIComponent(href)); } catch (_error) { /* malformed escape */ }
    for (const text of candidates) {
      const match = text.match(/time:\(from:([^,]+),to:([^)]+)\)/);
      if (match) {
        const clean = value => value.replace(/^['"]|['"]$/g, '').trim();
        return {from: clean(match[1]), to: clean(match[2]), source: 'global_state'};
      }
    }
    const label = this.datePickerLabel();
    if (label) return {...this.labelToRange(label), source: 'picker_label'};
    return {from: '', to: '', source: 'unknown'};
  }

  datePickerLabel() {
    const node = document.querySelector("[data-test-subj='dateRangePickerControlButton']")
      || document.querySelector("[data-test-subj='superDatePickerShowDatesButton']")
      || document.querySelector("[data-test-subj='dateRangePickerInput']");
    return (node?.textContent || node?.value || '').trim();
  }

  // Turn a relative label like "Last 15 minutes" into an { from: 'now-15m', to: 'now' } range.
  labelToRange(label) {
    const match = /last\s+(\d+)\s*(second|minute|hour|day|week|month|year)s?/i.exec(label);
    if (!match) return {from: label, to: ''};
    const unit = {second: 's', minute: 'm', hour: 'h', day: 'd', week: 'w', month: 'M', year: 'y'}[match[2].toLowerCase()];
    return {from: `now-${match[1]}${unit}`, to: 'now'};
  }

  timeSignature() {
    const range = this.readTimeRange();
    return `${range.from}|${range.to}`;
  }

  // Minutes of look-back for a window that ends at (or near) now, so the evaluator can check the
  // window reaches back far enough to include when the incident was noticed. Returns null when the
  // window is historical or unparseable, which the evaluator treats as "accept any applied window".
  timeRangeMinutes(from, to) {
    const unitMinutes = {s: 1 / 60, m: 1, h: 60, d: 1440, w: 10080, M: 43200, y: 525600};
    const relative = /^now-(\d+(?:\.\d+)?)([smhdwMy])$/.exec(String(from).trim());
    let minutes = null;
    if (relative) minutes = Number(relative[1]) * unitMinutes[relative[2]];
    else {
      const parsed = Date.parse(from);
      if (!Number.isNaN(parsed)) minutes = (Date.now() - parsed) / 60000;
    }
    if (minutes == null) return null;
    const toText = String(to || 'now').trim();
    if (!/^now$/i.test(toText)) {
      const end = Date.parse(toText);
      if (!Number.isNaN(end) && Date.now() - end > 5 * 60000) return null; // window ends in the past
    }
    return Math.round(minutes * 100) / 100;
  }

  // Report the applied window as time_range_changed carrying its real from/to and look-back. `force`
  // reports even when the value is unchanged (a deliberate Apply/preset click), while the poll passes
  // false so it only fires on an actual change; a short cooldown collapses the two into one report.
  captureTimeRange(force = false) {
    const range = this.readTimeRange();
    const signature = `${range.from}|${range.to}`;
    const previous = this.lastTimeSignature;
    const changed = signature !== previous;
    this.lastTimeSignature = signature;
    if (!range.from && !range.to) return;
    // Poll path: never fire while we are only just learning the initial window (empty -> value as
    // the app loads), or it would auto-complete the step without the learner acting. Report only a
    // change between two known windows; a deliberate Apply/preset click (force) always reports.
    if (!force) {
      const hadBaseline = Boolean(previous) && !previous.startsWith('|');
      if (!changed || !hadBaseline) return;
    }
    const now = Date.now();
    if (now - (this.lastTimeReportAt || 0) < 600) return;
    this.lastTimeReportAt = now;
    const details = {from: range.from, to: range.to, source: range.source};
    const minutes = this.timeRangeMinutes(range.from, range.to);
    if (minutes != null) details.from_minutes = minutes;
    this.report({type: 'time_range_changed', details, state_after: {time_from: range.from, time_to: range.to}});
  }

  onKey(event) {
    if (this.adapter.performing || event.key !== 'Enter') return;
    if (event.target === this.adapter.resolve('kibana.query_bar') || event.target === this.adapter.resolve('kibana.esql_editor')) {
      const esql = event.target === this.adapter.resolve('kibana.esql_editor');
      const query = event.target.value;
      setTimeout(() => this.reportWithCount({type: esql ? 'esql_submitted' : 'query_submitted', details: {query, language: esql ? 'esql' : 'kql'}, state_after: esql ? {query, query_language: 'esql'} : {...this.searchState(), query, query_language: 'kql'}}), 50);
    }
  }

  onClick(event) {
    if (this.adapter.performing) return;
    const node = event.target.closest?.('[data-test-subj]');
    const subject = node?.getAttribute('data-test-subj') || '';
    if (subject === 'querySubmitButton') {
      setTimeout(() => this.reportWithCount({type: 'query_submitted', details: {query: this.queryValue()}, state_after: this.searchState()}), 50);
    } else if (/esql.*(submit|run)/i.test(subject)) {
      const query = this.adapter.resolve('kibana.esql_editor')?.value || '';
      setTimeout(() => this.reportWithCount({type: 'esql_submitted', details: {query, language: 'esql'}, state_after: {query, query_language: 'esql'}}), 50);
    } else if (/queryLanguage/i.test(subject)) {
      setTimeout(() => this.report({type: 'query_language_changed', details: {language: this.adapter.resolve('kibana.esql_editor') ? 'esql' : 'kql'}, state_after: {query_language: this.adapter.resolve('kibana.esql_editor') ? 'esql' : 'kql'}}), 100);
    } else if (/superDatePickerApplyTimeButton|euiQuickSelect__applyButton|dateRangePicker\w*Apply|dateRangePickerPresetItem|CommonlyUsed|superDatePickerQuickMenu/i.test(subject)) {
      // A window was applied — via custom-range Apply (`dateRangePickerCustomRangeApplyButton`),
      // or a preset / recent quick pick. In Kibana 9.5.2 both the Presets and Recent lists render
      // each option as `dateRangePickerPresetItem-<label>` (e.g. Last_15_minutes, now-30m-now),
      // verified live; the Custom-range and Calendar *NavItem* tab switches are deliberately not
      // matched so merely opening a tab does not complete the step. Read the real range just after
      // the click so the URL global state has settled; the poll from start() is the safety net for
      // a drag-selection on the histogram. Force a report even when the value is unchanged: picking
      // a preset equal to the view's current window (the saved search opens at now-1h) is still a
      // deliberate step.
      setTimeout(() => this.captureTimeRange(true), 250);
    } else if (subject.includes('saveFilter') || /^(plus|minus)-/.test(subject) || /filterFor|filterOut|addFilterForValue|addFilterOutValue/i.test(subject)) {
      // A pill was applied — via the Add-filter popover's Save (`saveFilter`), or a
      // filter-for / filter-out on a field's top value (`plus-<field>-<value>` /
      // `minus-<field>-<value>`, verified in Kibana 9.5.2), or a document-cell filter.
      // Read the resulting pills generically so the run's decisive field/value/negate are
      // captured for ANY scenario. The legacy branch hard-coded service.name and dropped
      // the negate state, so it only matched one pack and never lit the filter-out route.
      setTimeout(() => {
        const filters = this.readFilterPills();
        const latest = filters[filters.length - 1] || {};
        this.lastFilters = filters;
        this.reportWithCount({type: 'filter_added', details: {...latest}, state_after: {filters, query: this.queryValue()}});
      }, 250);
    } else if (/fieldToggle|fieldPopoverHeader_addField|FieldListPanel(Add|Remove)|dscFieldDetails(Add|Remove)|removeColumn|add.?column|remove.?column/i.test(subject)) {
      // Column add/remove. `fieldToggle-<field>` is the verified 9.5.2 field-list toggle; it
      // both adds and removes, and its aria-label ("Add field as column" / "Remove field
      // from table") tells which. The grid header cell menu also removes a column.
      const label = node?.getAttribute('aria-label') || '';
      const removing = /remove/i.test(label) || /remove|delete/i.test(subject);
      this.report({type: removing ? 'column_removed' : 'column_added', details: {field: this.fieldFromSubject(subject, event.target)}});
    } else if (/filter.*(remove|delete|disable)|(remove|delete|disable).*filter/i.test(subject)) {
      // Read which pill went, and what is left, once Kibana has applied the change.
      setTimeout(() => this.captureFilterRemoval(), 300);
    } else if (/superDatePicker.*[Rr]efresh|refreshInterval|autoRefresh/i.test(subject)) {
      // Auto-refresh interval / pause toggle. Kibana 9.5.2 Discover ships the new
      // dateRangePicker with NO auto-refresh control (verified: no refresh-* subj on the
      // page), so this branch is dormant there and kept only for builds that expose one.
      setTimeout(() => this.report(this.readAutoRefresh()), 100);
    } else if (/fieldStats|fieldStatistics/i.test(subject)) {
      this.report({type: 'field_statistics_opened', details: {subject}});
    } else if (this.fieldPreviewSubject(event.target)) {
      // A field's preview popover was opened from the sidebar. Kibana 9.5.2 renders each field row
      // as `dscFieldListPanelField-<field>` wrapping a `field-<field>-showDetails` "Preview" button;
      // a click can land on either (or an inner icon), so resolve the field container and surface the
      // field name. That lets a survey step validate WHICH field's distribution was inspected.
      const containerSubject = this.fieldPreviewSubject(event.target);
      const field = containerSubject.replace(/^dscFieldListPanelField-/, '').replace(/^field-/, '').replace(/-showDetails$/, '');
      this.report({type: 'field_statistics_opened', details: {field, subject: containerSubject}});
    } else if (/surrounding/i.test(subject)) {
      this.report({type: 'surrounding_documents_opened', details: {subject}});
    } else if (/field.*(action|name|value)/i.test(subject)) {
      this.report({type: 'field_inspected', details: {subject}});
    } else if (subject === 'docTableExpandToggleColumn' || subject.includes('docTableExpand')) {
      const visibleTrace = this.adapter.resolve('kibana.first_trace_value')?.textContent?.trim() || '';
      setTimeout(() => {
        const expanded = this.adapter.resolve('kibana.trace_field');
        const trace = visibleTrace || (expanded?.matches?.("[data-test-subj='tableDocViewRow-trace.id-value']") ? expanded.textContent.trim() : '');
        this.report({type: trace ? 'trace_opened' : 'document_expanded', details: {trace_id: trace}, state_after: {trace_id: trace}});
      }, 350);
    } else if (/control-frame|controlGroup|optionsListControl/i.test(subject)) {
      this.report({type: 'dashboard_control_changed', details: {subject}, state_after: {app: 'dashboard'}});
    } else if (/embeddablePanel.*(inspect|toggleMenu)|inspectPanel/i.test(subject)) {
      this.report({type: 'panel_inspected', details: {subject}, state_after: {app: 'dashboard'}});
    } else if (/underlyingData|viewData/i.test(subject)) {
      this.report({type: 'panel_underlying_data_opened', details: {subject}, state_after: {app: 'dashboard'}});
    } else if (/drilldown/i.test(subject)) {
      this.report({type: 'panel_drilldown_opened', details: {subject}, state_after: {app: 'dashboard'}});
    } else if (/legend|xyVisSeries|partitionVis/i.test(subject)) {
      this.report({type: 'panel_value_selected', details: {value: event.target.textContent?.trim() || subject}, state_after: {app: 'dashboard'}});
    } else if (/transactionSample|traceSample/i.test(subject)) {
      this.report({type: 'trace_sample_selected', details: {value: event.target.textContent?.trim()}, state_after: {app: 'apm'}});
    } else if (/waterfall.*span|spanFlyout/i.test(subject)) {
      this.report({type: 'span_selected', details: {value: event.target.textContent?.trim()}, state_after: {app: 'apm'}});
    } else if (/errorMarker|errorDetail/i.test(subject)) {
      this.report({type: 'error_details_opened', details: {}, state_after: {app: 'apm'}});
    } else if (/correlatedLogs/i.test(subject)) {
      this.report({type: 'correlated_logs_opened', details: {}, state_after: {app: 'apm'}});
    } else if (/inventorySwitcher/i.test(subject)) {
      this.report({type: 'inventory_type_selected', details: {value: event.target.textContent?.trim()}, state_after: {app: 'metrics'}});
    } else if (/inventoryItem|nodeDetails/i.test(subject)) {
      this.report({type: 'infrastructure_entity_selected', details: {value: event.target.textContent?.trim()}, state_after: {app: 'metrics'}});
    } else if (/metric.*select/i.test(subject)) {
      this.report({type: 'metric_selected', details: {value: event.target.textContent?.trim()}, state_after: {app: 'metrics'}});
    } else if (/openInLogs/i.test(subject)) {
      this.report({type: 'metrics_logs_opened', details: {}, state_after: {app: 'metrics'}});
    } else if (/alert.*reason/i.test(subject)) {
      this.report({type: 'alert_reason_inspected', details: {}, state_after: {app: 'alerts'}});
    } else if (/alert.*history/i.test(subject)) {
      this.report({type: 'alert_history_inspected', details: {}, state_after: {app: 'alerts'}});
    } else if (/alert/i.test(subject) && event.target.closest?.('tr')) {
      this.report({type: 'alert_opened', details: {value: event.target.textContent?.trim()}, state_after: {app: 'alerts'}});
    } else if (event.target.closest?.("a[href*='/app/apm/services/']")) {
      this.report({type: 'apm_service_selected', details: {value: event.target.textContent?.trim()}, state_after: {app: 'apm'}});
    }
  }
}

globalThis.KibanaActionObserver = KibanaActionObserver;
