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
    this.lastSort = this.sortSignature();
    this.rebaselineFilters();
    this.deliverPivot();
    this.timePoll = setInterval(() => {
      if (this.adapter.performing) {
        this.coachActed = true;
        return;
      }
      // What the coach just did (a pill it applied, a window it set) is its own action, not the learner's.
      if (this.coachActed) {
        this.coachActed = false;
        this.rebaseline();
        return;
      }
      this.captureTimeRange(false);
      this.captureFilterRemoval();
      const app = this.appName();
      if (app === 'discover') this.captureSort();
      if (app === 'apm') this.captureApmTrace();
    }, 700);
  }

  // Adopt the window currently applied as the new baseline, so a change the coach made itself (a
  // restored search) is not later reported by the poll as the learner's.
  rebaseline() {
    this.lastTimeSignature = this.timeSignature();
    this.lastSort = this.sortSignature();
    this.rebaselineFilters();
    this.lastTraceId = this.apmTraceInView();
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
  // popover, its clear button, "Clear all", browser back). In Discover additions only move the
  // baseline; the click that applied them reports filter_added. A dashboard pill usually comes from a
  // click on a chart (a bar on the canvas, a legend entry's "Filter for") with no control to recognise,
  // so there a new pill reports filter_added itself.
  captureFilterRemoval(since = null) {
    const filters = this.readFilterPills();
    const key = filter => `${filter.negate ? '-' : ''}${filter.field}=${filter.value}`;
    const active = new Set(filters.filter(filter => !filter.disabled).map(key));
    const before = new Set((this.lastFilters || []).filter(filter => !filter.disabled).map(key));
    const lost = (this.lastFilters || []).filter(filter => !filter.disabled && !active.has(key(filter)));
    const added = this.appName() === 'dashboards' && !this.filterClickPending ? filters.filter(filter => !filter.disabled && !before.has(key(filter))) : [];
    this.lastFilters = filters;
    if (added.length) {
      this.report({type: 'filter_added', details: {...added[added.length - 1]}, state_after: {filters, query: this.queryValue(), app: 'dashboard'}});
      return;
    }
    if (!lost.length) return;
    const disabled = lost.every(filter => filters.some(item => item.disabled && key(item) === key(filter)));
    this.reportWithCount({type: disabled ? 'filter_disabled' : 'filter_removed', details: {...lost[0]}, state_after: {filters, query: this.queryValue()}}, since);
  }

  stop() {
    this.stopped = true;
    document.removeEventListener('click', this.boundClick, true);
    document.removeEventListener('keydown', this.boundKey, true);
    clearInterval(this.timePoll);
    clearInterval(this.pivotWatch);
  }

  // Wait up to `timeout` ms for `check()` to return something truthy, and resolve with it (or null).
  waitUntil(check, timeout) {
    return new Promise(resolve => {
      const startedAt = Date.now();
      const poll = () => {
        let value = null;
        try { value = check(); } catch (_error) { value = null; }
        if (value) resolve(value);
        else if (this.stopped || Date.now() - startedAt >= timeout) resolve(null);
        else setTimeout(poll, 50);
      };
      poll();
    });
  }

  // How many searches Kibana had started when an action began (see kibana-bootstrap.js).
  searchMark() { return globalThis.__coachSearches?.started ?? 0; }

  queryValue() { return this.adapter.resolve('kibana.query_bar')?.value || ''; }

  // How many documents Discover shows once the search an action started has settled, and whether it
  // did. A search action (a submitted query, an added or removed pill) always refetches in Discover
  // (verified 9.5.2, even for an unchanged query), and the previous hit count stays on screen until that
  // search returns, so its count is read only after a search begun since the action (`since`, a
  // searchMark()) has finished and Discover's busy markers (the grid's "updating" overlay, the loading
  // spinner) have cleared. If none starts before `timeout` the result is unsettled: count null, settled
  // false, and the service won't let it complete a step. Without `requireSearch` (a restored search,
  // say) a view that shows no search within `fetchGrace` is read as it stands. `settled` is null outside
  // Discover's document view (another app, an ES|QL chart), where there is no count to read.
  async searchOutcome({timeout = KibanaActionObserver.SEARCH_WAIT_MS, fetchGrace = 1000, since = null, requireSearch = false} = {}) {
    if (this.appName() !== 'discover') return {count: null, settled: null};
    const resultsUi = () => document.querySelector("[data-test-subj='discoverQueryHits']") || KibanaActionObserver.noResultsShown();
    if (!resultsUi()) return {count: null, settled: null};
    const busy = () => document.querySelector("[data-test-subj='discoverDataGridUpdating'], [data-test-subj='loadingSpinner'], [data-test-subj='globalLoadingIndicator']");
    const network = () => globalThis.__coachSearches;
    const mark = since ?? this.searchMark();
    const startedAt = Date.now();
    let sawBusy = false;
    let sawSearch = false;
    while (Date.now() - startedAt < timeout) {
      const searches = network();
      if (searches && searches.started > mark) sawSearch = true;
      const searching = Boolean(searches?.inFlight);
      if (busy()) sawBusy = true;
      else if (!searching && (sawBusy || sawSearch || (!requireSearch && Date.now() - startedAt > fetchGrace))) {
        if (KibanaActionObserver.noResultsShown()) return {count: 0, settled: true};
        const hits = document.querySelector("[data-test-subj='discoverQueryHits']")?.textContent || '';
        const count = Number(hits.replace(/[^\d]/g, ''));
        if (hits && Number.isFinite(count)) return {count, settled: true};
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return {count: null, settled: false};
  }

  // The settled count alone (null when unknown). Kept for callers that only need the number.
  async resultCount(timeout = 8000, fetchGrace = 1000) {
    return (await this.searchOutcome({timeout, fetchGrace})).count;
  }

  // The open document viewer, or null.
  static documentViewer() {
    const viewer = document.querySelector("[data-test-subj='docViewerFlyout']");
    return viewer && viewer.getClientRects().length ? viewer : null;
  }

  // A field's open preview popover (its header), or null.
  fieldPopover() {
    const header = document.querySelector("[data-popover-panel] [data-test-subj='fieldPopoverHeader_fieldDisplayName']");
    return header && header.getClientRects().length ? header : null;
  }

  static noResultsShown() {
    const prompt = document.querySelector("[data-test-subj='discoverNoResults']");
    return Boolean(prompt && prompt.getClientRects().length);
  }

  // Report a search-shaping action once its search settles, carrying the measured count — or, if it
  // never settled, saying so (result_settled: false) so the service does not take a stale view as its result.
  reportWithCount(action, since = null) {
    this.searchOutcome({since, requireSearch: true}).then(({count, settled}) => {
      if (this.stopped) return;
      action.state_after = {...(action.state_after || {})};
      if (count != null) action.state_after.result_count = count;
      if (settled === false) action.state_after.result_settled = false;
      this.report(action);
    });
  }

  // The trace APM is showing, once its waterfall is on screen (verified 9.5.2: the transaction page
  // shows a sample and names it in `traceId`; its rows are `traceItemRowContent`). '' otherwise.
  apmTraceInView() {
    if (this.appName() !== 'apm') return '';
    const traceId = new URLSearchParams(location.search).get('traceId') || '';
    const row = document.querySelector("[data-test-subj='traceItemRowContent']");
    const rect = row?.getBoundingClientRect();
    return traceId && rect && rect.height && rect.bottom > 0 && rect.top < innerHeight ? traceId : '';
  }

  // APM opens a trace sample by itself when a transaction group loads, so there is no click to
  // recognise: report the trace once its waterfall is in view, and again when another sample is.
  captureApmTrace() {
    const traceId = this.apmTraceInView();
    if (!traceId || traceId === this.lastTraceId) return;
    this.lastTraceId = traceId;
    const root = document.querySelector("[data-test-subj='traceItemRowContent'] [data-test-subj='apmBarDetailsName']")?.textContent?.trim() || '';
    this.report({type: 'trace_sample_selected', details: {trace_id: traceId, value: root}, state_after: {app: 'apm', trace_id: traceId}});
  }

  // A click in APM (verified 9.5.2), or null when it is none of these.
  apmAction(event, subject) {
    if (this.appName() !== 'apm') return null;
    const target = event.target;
    const row = target.closest?.("[data-test-subj='traceItemRowContent']");
    if (row && !target.closest('a')) {
      const value = row.querySelector("[data-test-subj='apmBarDetailsName']")?.textContent?.trim() || '';
      return {type: 'span_selected', details: {value}, state_after: {app: 'apm'}};
    }
    const tab = target.closest?.("[data-test-subj='apmTransactionDistributionTabContent'] [role='tab']");
    if (tab && /^logs$/i.test(tab.textContent.trim())) return {type: 'correlated_logs_opened', details: {}, state_after: {app: 'apm'}};
    if (target.closest?.("nav[aria-label='Trace sample pages'], [data-test-subj='apmFullTraceButtonViewFullTraceButton']")) {
      // The sample it moves to is reported by captureApmTrace once its waterfall shows.
      return {type: null};
    }
    const link = target.closest?.('a[href]');
    const href = link?.getAttribute('href') || '';
    const value = link?.textContent?.trim() || '';
    if (subject === 'apmTransactionDetailLinkLink' || /\/transactions\/view\?/.test(href)) return {type: 'transaction_group_opened', details: {value}, state_after: {app: 'apm'}};
    if (/\/app\/apm\/services\/[^/?]+(\/overview)?(\?|$)/.test(href)) return {type: 'apm_service_selected', details: {value}, state_after: {app: 'apm'}};
    return null;
  }

  // A click on an alert (verified 9.5.2 Observability → Alerts), or null when it is none of these.
  alertsAction(event, subject) {
    const target = event.target;
    const expand = target.closest?.("[data-gridcell-column-id='expandColumn']");
    // A grid cell's text ends in a screen-reader marker ("↦").
    const ruleIn = row => row == null ? '' : document.querySelector(`[data-gridcell-column-id='kibana.alert.rule.name'][data-gridcell-row-index='${row}']`)?.textContent?.replace(/↦/g, '').trim() || '';
    if (expand && target.closest('button') && document.querySelector("[data-gridcell-column-id='kibana.alert.rule.name']")) {
      return [{type: 'alert_opened', details: {value: ruleIn(expand.getAttribute('data-gridcell-row-index'))}, state_after: {app: 'alerts'}}];
    }
    const flyoutAlert = () => document.querySelector("[data-test-subj='alertsFlyoutTitle']")?.textContent?.trim() || '';
    // The alert's details page shows its Reason, status and history; from the row menu it also opens it.
    if (subject === 'alertsFlyoutAlertDetailsButton') return [{type: 'alert_reason_inspected', details: {value: flyoutAlert()}, state_after: {app: 'alerts'}}];
    if (subject === 'viewAlertDetailsPage') {
      const value = ruleIn(target.closest?.('[data-gridcell-row-index]')?.getAttribute('data-gridcell-row-index')) || ruleIn('0');
      return [{type: 'alert_opened', details: {value}, state_after: {app: 'alerts'}}, {type: 'alert_reason_inspected', details: {value}, state_after: {app: 'alerts'}}];
    }
    if (subject === 'relatedAlertsTab') return [{type: 'alert_history_inspected', details: {}, state_after: {app: 'alerts'}}];
    if (subject.startsWith('alertDetailsPage_viewInDiscover_')) {
      // A pivot: reported from Discover once it opens there (see holdPivot).
      this.holdPivot({type: 'alert_source_opened', details: {}, state_after: {app: 'alerts'}});
      return [];
    }
    return null;
  }

  // A click in the Infrastructure inventory (verified 9.5.2), or null when it is none of these.
  infrastructureAction(event, subject) {
    if (this.appName() !== 'metrics') return null;
    const target = event.target;
    const app = {app: 'metrics'};
    // Opening the Show or Metric menu chooses nothing yet.
    if (subject === 'openInventorySwitcher' || subject === 'infraInventoryMetricDropdown') return {type: null};
    if (/^goTo/.test(subject) && target.closest?.('[data-popover-panel]')) return {type: 'inventory_type_selected', details: {value: node(target, subject)}, state_after: app};
    if (target.closest?.("[data-test-subj='infraInventoryMetricsContextMenu'] button") && !/infraModeSwitcher/.test(subject)) {
      return {type: 'metric_selected', details: {value: target.closest('button').textContent.trim()}, state_after: app};
    }
    const entity = target.closest?.("[data-test-subj='nodeContainer']");
    if (entity) return {type: 'infrastructure_entity_selected', details: {value: entity.querySelector("[data-test-subj='nodeName']")?.textContent?.trim() || ''}, state_after: app};
    // A host's or pod's own logs: a host's details flyout Logs tab (or its Open in Discover), a pod's
    // "Kubernetes Pod logs" menu link.
    if (['infraAssetDetailsLogsTab', 'infraAssetDetailsLogsTabOpenInLogsButton', 'viewLogsContextMenuItem'].includes(subject)) return {type: 'metrics_logs_opened', details: {}, state_after: app};
    if (subject === 'infraAssetDetailsMetricsTab') return {type: 'metric_period_compared', details: {}, state_after: app};
    return null;
    function node(element, fallback) { return element.closest('button')?.textContent?.trim() || fallback; }
  }

  // The title of the dashboard panel a control belongs to.
  panelTitle(node) {
    return node?.closest?.("[data-test-subj='dashboardPanel']")?.querySelector("[data-test-subj='embeddablePanelTitle']")?.textContent?.trim() || '';
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
      // The test subject drops a value's spaces ("filter-value-failedtransactions"); the pill's text keeps them.
      const fromText = withoutNot.split(':').slice(1).join(':').trim();
      const spaced = valueToken && fromText.replace(/\s+/g, '') === valueToken[1] ? fromText : null;
      const value = (spaced ?? (valueToken ? valueToken[1] : fromText)).replace(/^"|"$/g, '');
      const negate = /(^|\s)filter-negated(\s|$)/.test(subject) || /^NOT\s+/i.test(text);
      const disabled = /(^|\s)filter-disabled(\s|$)/.test(subject);
      return disabled ? {field, value, negate, disabled} : {field, value, negate};
    }).filter(filter => filter.field);
  }

  // The field name of a column toggle (`fieldToggle-<field>`, `fieldPopoverHeader_addField-<field>`).
  // Steps check it: a column completes "check the evidence" only on the field the step names.
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

  // Discover's table sort from the `_a` app state in the URL (verified 9.5.2: the @timestamp header's
  // "Sort Old-New" gives `sort:!(!('@timestamp',asc))`), however it was chosen: a column header's menu,
  // the toolbar's "Sort fields" popover, or browser back. The first entry is the sort that orders rows.
  readSort() {
    const href = (typeof location !== 'undefined' && location.href) || '';
    let text = href;
    try { text = decodeURIComponent(href); } catch (_error) { /* malformed escape */ }
    const match = text.match(/sort:!\(!\(([^,]+),(asc|desc)\)/);
    if (!match) return null;
    return {field: match[1].replace(/^['"]|['"]$/g, ''), direction: match[2]};
  }

  sortSignature() {
    const sort = this.readSort();
    return sort ? `${sort.field}|${sort.direction}` : '';
  }

  // Report a change of sort as sort_changed. Only a change between two known states counts, so the
  // view's own default sort, read as the page loads, is never reported as the learner's.
  captureSort() {
    const signature = this.sortSignature();
    const previous = this.lastSort;
    this.lastSort = signature;
    if (!signature || signature === previous || previous === undefined) return;
    const sort = this.readSort();
    // Discover writing its own default (newest first) into a URL that had no sort is not a choice.
    if (!previous && sort.field === '@timestamp' && sort.direction === 'desc') return;
    this.report({type: 'sort_changed', details: {field: sort.field, direction: sort.direction}, state_after: {sort: [[sort.field, sort.direction]]}});
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
    const mark = this.searchMark();
    if (event.target === this.adapter.resolve('kibana.query_bar')) {
      const query = event.target.value;
      setTimeout(() => this.reportSearch(query, mark), 50);
    } else if ((event.ctrlKey || event.metaKey) && event.target.closest?.("[data-test-subj='ESQLEditor']")) {
      // The ES|QL editor runs its query on Ctrl/Cmd+Enter (plain Enter is a new line).
      setTimeout(() => this.reportSearch(null, mark), 50);
    }
  }

  // Report a submitted search once Discover settles, as KQL or ES|QL by what Discover's URL state
  // says then: in 9.5 the ES|QL editor is Monaco (no textarea value to read) and shares the KQL
  // bar's querySubmitButton, so neither the clicked control nor the editor tells them apart.
  reportSearch(kqlQuery = null, since = null) {
    this.searchOutcome({since, requireSearch: true}).then(({count, settled}) => {
      if (this.stopped) return;
      const view = this.adapter.currentView?.();
      const esql = view?.language === 'esql';
      const query = esql ? view.query : (kqlQuery ?? this.queryValue());
      const action = esql
        ? {type: 'esql_submitted', details: {query, language: 'esql'}, state_after: {query, query_language: 'esql'}}
        : {type: 'query_submitted', details: {query, language: 'kql'}, state_after: {...this.searchState(), query, query_language: 'kql'}};
      if (count != null) action.state_after.result_count = count;
      if (settled === false) action.state_after.result_settled = false;
      this.report(action);
    });
  }

  // A pivot to another page (Explore in Discover, View in Discover) counts once that page is reached,
  // not when its control is clicked: a click that goes nowhere must not complete a step. The action is
  // held in this tab's sessionStorage, so the destination page's observer reports it (the coach
  // reconnects there); a pivot that has not arrived within PIVOT_WAIT_MS is dropped.
  holdPivot(action) {
    const pending = {action, from: `${location.pathname}${location.search || ''}${location.hash || ''}`, app: this.appName(), at: Date.now()};
    try { sessionStorage.setItem(KibanaActionObserver.PIVOT_KEY, JSON.stringify(pending)); } catch (_error) { return; }
    clearInterval(this.pivotWatch);
    // Kibana may also move within the page (no reload): then this observer delivers it.
    this.pivotWatch = setInterval(() => {
      if (this.appName() !== pending.app) {
        clearInterval(this.pivotWatch);
        this.deliverPivot();
      } else if (Date.now() - pending.at > KibanaActionObserver.PIVOT_WAIT_MS) {
        clearInterval(this.pivotWatch);
        try { sessionStorage.removeItem(KibanaActionObserver.PIVOT_KEY); } catch (_error) { /* storage unavailable */ }
      }
    }, 250);
  }

  // Report a pivot held by the page it came from, now that it has arrived here.
  deliverPivot() {
    let pending = null;
    try { pending = JSON.parse(sessionStorage.getItem(KibanaActionObserver.PIVOT_KEY) || 'null'); } catch (_error) { pending = null; }
    if (!pending?.action) return;
    if (Date.now() - pending.at > KibanaActionObserver.PIVOT_WAIT_MS + 30000 || this.appName() === pending.app) {
      // Too old to be this navigation, or still on the page it came from (the poll above decides there).
      if (this.appName() !== pending.app) sessionStorage.removeItem(KibanaActionObserver.PIVOT_KEY);
      return;
    }
    sessionStorage.removeItem(KibanaActionObserver.PIVOT_KEY);
    // Both pivots open a Kibana /app/r locator link, which the page then redirects to Discover in place
    // (the coach starts while it is still on /app/r): wait for the destination itself.
    const destination = this.appName() === 'r'
      ? this.waitUntil(() => (this.appName() !== 'r' ? this.appName() : null), KibanaActionObserver.SEARCH_WAIT_MS * 2)
      : Promise.resolve(this.appName());
    // Discover is the destination of both pivots: report once its results are on screen and no search
    // is still running (a fresh page has no stale count to wait out). One that never shows them is not
    // reported. Another destination counts on arrival.
    const resultsShown = () => document.querySelector("[data-test-subj='discoverQueryHits']") || KibanaActionObserver.noResultsShown();
    let app = '';
    destination.then(reached => {
      app = reached || '';
      if (!app) return null;
      return app === 'discover' ? this.waitUntil(resultsShown, KibanaActionObserver.SEARCH_WAIT_MS * 2) : true;
    }).then(shown => (shown ? (app === 'discover' ? this.searchOutcome({since: -1}) : {count: null}) : null)).then(outcome => {
      if (!outcome || this.stopped) return;
      const action = {...pending.action, state_after: {...(pending.action.state_after || {}), app, arrived_from: pending.app}};
      if (outcome.count != null) action.state_after.result_count = outcome.count;
      this.report(action);
    });
  }

  onClick(event) {
    if (this.adapter.performing) return;
    const node = event.target.closest?.('[data-test-subj]');
    const subject = node?.getAttribute('data-test-subj') || '';
    const apm = this.apmAction(event, subject);
    if (apm) {
      if (apm.type) this.report(apm);
      return;
    }
    const infrastructure = this.infrastructureAction(event, subject);
    if (infrastructure) {
      if (infrastructure.type) this.report(infrastructure);
      return;
    }
    const alerts = this.alertsAction(event, subject);
    if (alerts) {
      for (const action of alerts) this.report(action);
      return;
    }
    if (subject === 'querySubmitButton' || /esql.*(submit|run)/i.test(subject)) {
      setTimeout(() => this.reportSearch(), 50);
    } else if (/queryLanguage|select-text-based-language/i.test(subject)) {
      // 9.5's "Query in ES|QL" button; the URL state names the language once Discover has switched.
      setTimeout(() => {
        const language = this.adapter.currentView?.()?.language || (this.adapter.resolve('kibana.esql_editor') ? 'esql' : 'kql');
        this.report({type: 'query_language_changed', details: {language}, state_after: {query_language: language}});
      }, 1500);
    } else if (/superDatePickerApplyTimeButton|euiQuickSelect__applyButton|dateRangePicker\w*Apply|dateRangePickerPresetItem-|superDatePickerCommonlyUsed_/i.test(subject)) {
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
    } else if (subject.includes('saveFilter') || /^(plus|minus)-/.test(subject) || /filterFor|filterOut|addFilterForValue|addFilterOutValue|-filter(In|Out)$/i.test(subject)) {
      // A pill was applied — via the Add-filter popover's Save (`saveFilter`), or a
      // filter-for / filter-out on a field's top value (`plus-<field>-<value>` /
      // `minus-<field>-<value>`, verified in Kibana 9.5.2), or a document-cell filter.
      // Read the resulting pills generically so the run's decisive field/value/negate are
      // captured for ANY scenario. The legacy branch hard-coded service.name and dropped
      // the negate state, so it only matched one pack and never lit the filter-out route.
      // A chart legend's Filter for / Filter out (`legend-<value>-filterIn|Out`, verified 9.5.2) lands here
      // too; the poll must leave that pill to this report.
      // The pill appears a moment after the click (after Save, or once the popover closes); report the
      // one this click added, with its search's settled count. A click that adds no pill (Save on an
      // incomplete filter, a value already filtered) is no filter_added, and an existing pill is never
      // reported in its place.
      const before = this.readFilterPills();
      const key = filter => `${filter.negate ? '-' : ''}${filter.field}=${filter.value}${filter.disabled ? '/off' : ''}`;
      const known = new Set(before.map(key));
      const mark = this.searchMark();
      this.filterClickPending = true;
      this.waitUntil(() => this.readFilterPills().find(filter => !filter.disabled && !known.has(key(filter))), KibanaActionObserver.UI_WAIT_MS).then(added => {
        this.filterClickPending = false;
        const filters = this.readFilterPills();
        this.lastFilters = filters;
        if (!added || this.stopped) return;
        this.reportWithCount({type: 'filter_added', details: {...added}, state_after: {filters, query: this.queryValue()}}, mark);
      });
    } else if (/fieldToggle|fieldPopoverHeader_addField|FieldListPanel(Add|Remove)|dscFieldDetails(Add|Remove)|removeColumn|add.?column|remove.?column/i.test(subject)) {
      // Column add/remove. `fieldToggle-<field>` is the verified 9.5.2 field-list toggle; it
      // both adds and removes, and its aria-label ("Add field as column" / "Remove field
      // from table") tells which. The grid header cell menu also removes a column.
      const label = node?.getAttribute('aria-label') || '';
      const removing = /remove/i.test(label) || /remove|delete/i.test(subject);
      this.report({type: removing ? 'column_removed' : 'column_added', details: {field: this.fieldFromSubject(subject, event.target)}});
    } else if (/filter.*(remove|delete|disable)|(remove|delete|disable).*filter/i.test(subject)) {
      // Read which pill went, and what is left, once Kibana has applied the change.
      const mark = this.searchMark();
      setTimeout(() => this.captureFilterRemoval(mark), 300);
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
      // Only once its popover is open (verified 9.5.2: `fieldPopoverHeader_fieldDisplayName` in the
      // popover panel). The same button closes an open popover, and a closing click opens nothing.
      const wasOpen = Boolean(this.fieldPopover());
      this.waitUntil(() => !wasOpen && this.fieldPopover(), KibanaActionObserver.UI_WAIT_MS).then(open => {
        if (open && !this.stopped) this.report({type: 'field_statistics_opened', details: {field, subject: containerSubject}});
      });
    } else if (/surrounding/i.test(subject)) {
      this.report({type: 'surrounding_documents_opened', details: {subject}});
    } else if (/field.*(action|name|value)/i.test(subject)) {
      this.report({type: 'field_inspected', details: {subject}});
    } else if (subject === 'docTableExpandToggleColumn' || subject.includes('docTableExpand')) {
      // Report the document once its viewer is open (verified 9.5.2: `docViewerFlyout`, ~750 ms after
      // the click), reading the trace from it. A click that opens nothing reports nothing; the same
      // toggle closes an open document, and moving to another row keeps the viewer open.
      const visibleTrace = this.adapter.resolve('kibana.first_trace_value')?.textContent?.trim() || '';
      const wasOpen = Boolean(KibanaActionObserver.documentViewer());
      const opened = wasOpen
        ? new Promise(resolve => setTimeout(() => resolve(KibanaActionObserver.documentViewer()), 400))
        : this.waitUntil(() => KibanaActionObserver.documentViewer(), KibanaActionObserver.DOCUMENT_WAIT_MS);
      opened.then(viewer => {
        if (!viewer || this.stopped) return;
        const expanded = this.adapter.resolve('kibana.trace_field');
        const inViewer = expanded?.matches?.("[data-test-subj='tableDocViewRow-trace.id-value']") ? expanded.textContent.trim() : '';
        const trace = inViewer || visibleTrace;
        this.report({type: trace ? 'trace_opened' : 'document_expanded', details: {trace_id: trace}, state_after: {trace_id: trace}});
      });
    } else if (/control-frame|controlGroup|optionsListControl/i.test(subject)) {
      this.report({type: 'dashboard_control_changed', details: {subject}, state_after: {app: 'dashboard'}});
    } else if (/openInspector|inspectPanel/i.test(subject)) {
      // A panel's Inspect hover action (`embeddablePanelAction-openInspector`, verified 9.5.2). Opening
      // the panel menu itself inspects nothing.
      this.report({type: 'panel_inspected', details: {subject, panel: this.panelTitle(node)}, state_after: {app: 'dashboard'}});
    } else if (/underlyingData|viewData|OPEN_IN_DISCOVER/i.test(subject)) {
      // "Explore in Discover" (`embeddablePanelAction-ACTION_OPEN_IN_DISCOVER`, verified 9.5.2) opens the
      // panel's records with its filters and time; the dashboard adapter keeps it in this tab. A pivot:
      // reported from Discover once it opens there (see holdPivot).
      this.holdPivot({type: 'panel_underlying_data_opened', details: {subject, panel: this.panelTitle(node)}, state_after: {app: 'dashboard'}});
    } else if (/drilldown/i.test(subject)) {
      this.report({type: 'panel_drilldown_opened', details: {subject}, state_after: {app: 'dashboard'}});
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

// How long a click's result may take to appear (a pill, a popover), a document to open, and a pivot to
// reach its page before the click is taken to have done nothing.
KibanaActionObserver.SEARCH_WAIT_MS = 8000;
KibanaActionObserver.UI_WAIT_MS = 3000;
KibanaActionObserver.DOCUMENT_WAIT_MS = 8000;
KibanaActionObserver.PIVOT_WAIT_MS = 10000;
KibanaActionObserver.PIVOT_KEY = 'incident-coach:pending-pivot';

globalThis.KibanaActionObserver = KibanaActionObserver;
