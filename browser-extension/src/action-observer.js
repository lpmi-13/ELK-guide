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

  onKey(event) {
    if (this.adapter.performing || event.key !== 'Enter') return;
    if (event.target === this.adapter.resolve('kibana.query_bar')) {
      setTimeout(() => this.report({type: 'query_submitted', details: {query: this.queryValue()}, state_after: {query: this.queryValue()}}), 50);
    }
  }

  onClick(event) {
    if (this.adapter.performing) return;
    const subject = event.target.closest?.('[data-test-subj]')?.getAttribute('data-test-subj') || '';
    if (subject === 'querySubmitButton') {
      setTimeout(() => this.report({type: 'query_submitted', details: {query: this.queryValue()}, state_after: {query: this.queryValue()}}), 50);
    } else if (subject === 'superDatePickerApplyTimeButton' || subject.includes('CommonlyUsed')) {
      this.report({type: 'time_range_changed', details: {from: 'browser-selected'}, state_after: {time_from: 'browser-selected'}});
    } else if (subject.includes('saveFilter')) {
      setTimeout(() => {
        const pill = [...document.querySelectorAll("[data-test-subj*='filter']")].map(node => node.textContent).find(text => text.includes('service.name')) || '';
        const value = pill.split(':').slice(1).join(':').trim().replace(/^"|"$/g, '');
        this.report({type: 'filter_added', details: {field: 'service.name', value}});
      }, 250);
    } else if (subject === 'docTableExpandToggleColumn' || subject.includes('docTableExpand')) {
      const visibleTrace = this.adapter.resolve('kibana.first_trace_value')?.textContent?.trim() || '';
      setTimeout(() => {
        const expanded = this.adapter.resolve('kibana.trace_field');
        const trace = visibleTrace || (expanded?.matches?.("[data-test-subj='tableDocViewRow-trace.id-value']") ? expanded.textContent.trim() : '');
        this.report({type: trace ? 'trace_opened' : 'document_expanded', details: {trace_id: trace}, state_after: {trace_id: trace}});
      }, 350);
    }
  }
}

globalThis.KibanaActionObserver = KibanaActionObserver;
