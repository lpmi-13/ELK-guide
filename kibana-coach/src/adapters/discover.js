globalThis.KibanaApplicationAdapters ||= [];

// Escape a field name for use inside a [data-test-subj='...'] selector.
function cssEscape(value) {
  return String(value).replace(/['\\]/g, '\\$&');
}

// Poll for a specific field-scoped selector (the registry only holds static targets).
async function waitForSelector(selector, timeout, signal) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException('Demonstration stopped', 'AbortError');
    const element = document.querySelector(selector);
    if (element && element.getClientRects().length) return element;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Kibana target not found: ${selector}`);
}

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
    // Column add/remove drives the verified 9.5.2 field-list toggle `fieldToggle-<field>`
    // (its aria-label flips between "Add field as column" and "Remove field from table").
    // The field name comes from the command; fall back to the registry target otherwise.
    if (command.type === 'add_column' || command.type === 'remove_column') {
      const field = command.value?.field;
      const toggle = field ? await waitForSelector(`[data-test-subj='fieldToggle-${cssEscape(field)}']`, 20000, signal) : null;
      const target = toggle || await host.waitFor(command.target, 20000, signal);
      const verb = command.type === 'add_column' ? 'Add' : 'Remove';
      await host.pointAt(target, coach, timingScale, signal, command.narration || `${verb} the ${field || 'selected'} column from the field list.`, {activate: true});
      const type = command.type === 'add_column' ? 'column_added' : 'column_removed';
      return {type, details: {...(command.value || {})}, state_after: command.value || {}};
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
