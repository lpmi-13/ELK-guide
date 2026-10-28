globalThis.KibanaApplicationAdapters ||= [];
globalThis.KibanaApplicationAdapters.push({
  name: 'apm',
  commands: new Set(['select_apm_service', 'select_apm_environment', 'open_transaction_group', 'select_trace_sample', 'select_span', 'open_error_details', 'navigate_to_correlated_logs']),
  async perform(command, host, coach, {timingScale = 1, signal} = {}) {
    const fallback = await host.waitFor(command.target, 20000, signal);
    // The trace sample's own Logs tab (verified 9.5.2: a role=tab beside Timeline and Metadata, no test
    // subject) lists the logs written during that trace.
    const named = command.type === 'navigate_to_correlated_logs' ? 'Logs'
      : command.value?.service || command.value?.transaction || (command.type === 'select_span' ? command.value?.span : null);
    const target = host.targetNaming(command.target, named, fallback);
    await host.pointAt(target, coach, timingScale, signal, command.narration || 'Open the highlighted APM evidence.', {activate: true});
    const types = {select_apm_service:'apm_service_selected',select_apm_environment:'apm_environment_selected',open_transaction_group:'transaction_group_opened',select_trace_sample:'trace_sample_selected',select_span:'span_selected',open_error_details:'error_details_opened',navigate_to_correlated_logs:'correlated_logs_opened'};
    return {type: types[command.type], details: command.value || {}, state_after: {app: 'apm'}};
  }
});
