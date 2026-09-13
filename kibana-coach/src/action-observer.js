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
  }

  stop() {
    document.removeEventListener('click', this.boundClick, true);
    document.removeEventListener('keydown', this.boundKey, true);
  }

  queryValue() { return this.adapter.resolve('kibana.query_bar')?.value || ''; }

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
      return {field, value, negate};
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

  readAutoRefresh() {
    const toggle = document.querySelector("[data-test-subj='superDatePickerToggleRefreshButton']");
    const interval = document.querySelector("[data-test-subj='superDatePickerRefreshIntervalInput']")?.value || '';
    const paused = toggle ? /play|start|resume|paused/i.test(toggle.getAttribute('aria-label') || '') : undefined;
    return {type: 'auto_refresh_changed', details: {interval, paused}, state_after: {interval, paused}};
  }

  onKey(event) {
    if (this.adapter.performing || event.key !== 'Enter') return;
    if (event.target === this.adapter.resolve('kibana.query_bar') || event.target === this.adapter.resolve('kibana.esql_editor')) {
      const esql = event.target === this.adapter.resolve('kibana.esql_editor');
      setTimeout(() => this.report({type: esql ? 'esql_submitted' : 'query_submitted', details: {query: event.target.value, language: esql ? 'esql' : 'kql'}, state_after: {query: event.target.value, query_language: esql ? 'esql' : 'kql'}}), 50);
    }
  }

  onClick(event) {
    if (this.adapter.performing) return;
    const node = event.target.closest?.('[data-test-subj]');
    const subject = node?.getAttribute('data-test-subj') || '';
    if (subject === 'querySubmitButton') {
      setTimeout(() => this.report({type: 'query_submitted', details: {query: this.queryValue()}, state_after: {query: this.queryValue()}}), 50);
    } else if (/esql.*(submit|run)/i.test(subject)) {
      const query = this.adapter.resolve('kibana.esql_editor')?.value || '';
      setTimeout(() => this.report({type: 'esql_submitted', details: {query, language: 'esql'}, state_after: {query, query_language: 'esql'}}), 50);
    } else if (/queryLanguage/i.test(subject)) {
      setTimeout(() => this.report({type: 'query_language_changed', details: {language: this.adapter.resolve('kibana.esql_editor') ? 'esql' : 'kql'}, state_after: {query_language: this.adapter.resolve('kibana.esql_editor') ? 'esql' : 'kql'}}), 100);
    } else if (subject === 'superDatePickerApplyTimeButton' || subject.includes('CommonlyUsed')) {
      this.report({type: 'time_range_changed', details: {from: 'browser-selected'}, state_after: {time_from: 'browser-selected'}});
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
        this.report({type: 'filter_added', details: {...latest}, state_after: {filters}});
      }, 250);
    } else if (/fieldToggle|fieldPopoverHeader_addField|FieldListPanel(Add|Remove)|dscFieldDetails(Add|Remove)|removeColumn|add.?column|remove.?column/i.test(subject)) {
      // Column add/remove. `fieldToggle-<field>` is the verified 9.5.2 field-list toggle; it
      // both adds and removes, and its aria-label ("Add field as column" / "Remove field
      // from table") tells which. The grid header cell menu also removes a column.
      const label = node?.getAttribute('aria-label') || '';
      const removing = /remove/i.test(label) || /remove|delete/i.test(subject);
      this.report({type: removing ? 'column_removed' : 'column_added', details: {field: this.fieldFromSubject(subject, event.target)}});
    } else if (/filter.*(remove|delete)/i.test(subject)) {
      this.report({type: 'filter_removed', details: {subject}});
    } else if (/filter.*disable/i.test(subject)) {
      this.report({type: 'filter_disabled', details: {subject}});
    } else if (/superDatePicker.*[Rr]efresh|refreshInterval|autoRefresh/i.test(subject)) {
      // Auto-refresh interval / pause toggle. Kibana 9.5.2 Discover ships the new
      // dateRangePicker with NO auto-refresh control (verified: no refresh-* subj on the
      // page), so this branch is dormant there and kept only for builds that expose one.
      setTimeout(() => this.report(this.readAutoRefresh()), 100);
    } else if (/fieldStats|fieldStatistics/i.test(subject)) {
      this.report({type: 'field_statistics_opened', details: {subject}});
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
