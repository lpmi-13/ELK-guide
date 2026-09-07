globalThis.KibanaApplicationAdapters ||= [];
globalThis.KibanaApplicationAdapters.push({
  name: 'discover',
  commands: new Set(['select_data_view', 'enter_kql', 'switch_query_language', 'enter_esql', 'edit_filter', 'remove_filter', 'disable_filter', 'add_column', 'remove_column', 'sort_column', 'expand_document', 'inspect_field', 'open_field_statistics', 'open_surrounding_documents']),
  async perform(command, host, coach, {timingScale = 1, signal} = {}) {
    if (command.type === 'enter_kql' || command.type === 'enter_esql') {
      const value = typeof command.value === 'string' ? command.value : command.value?.query || '';
      const input = await host.waitFor(command.type === 'enter_esql' ? 'kibana.esql_editor' : 'kibana.query_bar', 20000, signal);
      await host.enterQuery(value, coach, timingScale, signal, input);
      return {type: command.type === 'enter_esql' ? 'esql_submitted' : 'query_submitted', details: {query: value, language: command.type === 'enter_esql' ? 'esql' : 'kql'}, state_after: {query: value, query_language: command.type === 'enter_esql' ? 'esql' : 'kql'}};
    }
    const target = await host.waitFor(command.target, 20000, signal);
    await host.pointAt(target, coach, timingScale, signal, command.narration || 'Use the highlighted Discover control.', {activate: true});
    const observations = {
      select_data_view: 'data_view_selected', switch_query_language: 'query_language_changed', edit_filter: 'filter_changed', remove_filter: 'filter_removed', disable_filter: 'filter_disabled',
      add_column: 'column_added', remove_column: 'column_removed', sort_column: 'sort_changed', expand_document: 'document_expanded', inspect_field: 'field_inspected',
      open_field_statistics: 'field_statistics_opened', open_surrounding_documents: 'surrounding_documents_opened'
    };
    const details = {...(command.value || {})};
    if (command.type === 'switch_query_language') details.language ||= 'esql';
    return {type: observations[command.type], details, state_after: command.value || {}};
  }
});
