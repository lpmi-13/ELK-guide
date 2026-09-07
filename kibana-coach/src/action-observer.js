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

  onKey(event) {
    if (this.adapter.performing || event.key !== 'Enter') return;
    if (event.target === this.adapter.resolve('kibana.query_bar') || event.target === this.adapter.resolve('kibana.esql_editor')) {
      const esql = event.target === this.adapter.resolve('kibana.esql_editor');
      setTimeout(() => this.report({type: esql ? 'esql_submitted' : 'query_submitted', details: {query: event.target.value, language: esql ? 'esql' : 'kql'}, state_after: {query: event.target.value, query_language: esql ? 'esql' : 'kql'}}), 50);
    }
  }

  onClick(event) {
    if (this.adapter.performing) return;
    const subject = event.target.closest?.('[data-test-subj]')?.getAttribute('data-test-subj') || '';
    if (subject === 'querySubmitButton') {
      setTimeout(() => this.report({type: 'query_submitted', details: {query: this.queryValue()}, state_after: {query: this.queryValue()}}), 50);
    } else if (/esql.*(submit|run)/i.test(subject)) {
      const query = this.adapter.resolve('kibana.esql_editor')?.value || '';
      setTimeout(() => this.report({type: 'esql_submitted', details: {query, language: 'esql'}, state_after: {query, query_language: 'esql'}}), 50);
    } else if (/queryLanguage/i.test(subject)) {
      setTimeout(() => this.report({type: 'query_language_changed', details: {language: this.adapter.resolve('kibana.esql_editor') ? 'esql' : 'kql'}, state_after: {query_language: this.adapter.resolve('kibana.esql_editor') ? 'esql' : 'kql'}}), 100);
    } else if (subject === 'superDatePickerApplyTimeButton' || subject.includes('CommonlyUsed')) {
      this.report({type: 'time_range_changed', details: {from: 'browser-selected'}, state_after: {time_from: 'browser-selected'}});
    } else if (subject.includes('saveFilter')) {
      setTimeout(() => {
        const pill = [...document.querySelectorAll("[data-test-subj*='filter']")].map(node => node.textContent).find(text => text.includes('service.name')) || '';
        const value = pill.split(':').slice(1).join(':').trim().replace(/^"|"$/g, '');
        this.report({type: 'filter_added', details: {field: 'service.name', value}});
      }, 250);
    } else if (/filter.*(remove|delete)/i.test(subject)) {
      this.report({type: 'filter_removed', details: {subject}});
    } else if (/filter.*disable/i.test(subject)) {
      this.report({type: 'filter_disabled', details: {subject}});
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
