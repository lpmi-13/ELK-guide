globalThis.KibanaApplicationAdapters ||= [];
globalThis.KibanaApplicationAdapters.push({
  name: 'apm',
  commands: new Set(['select_apm_service', 'select_apm_environment', 'open_transaction_group', 'select_trace_sample', 'select_span', 'open_error_details', 'navigate_to_correlated_logs']),
  async perform(command, host, coach, {timingScale = 1, signal} = {}) {
    let target = await host.waitFor(command.target, 20000, signal);
    const expectedService = command.type === 'select_apm_service' ? command.value?.service : null;
    if (expectedService) {
      const candidates = (host.registry?.targets?.[command.target] || []).flatMap(selector => Array.from(document.querySelectorAll(selector)));
      target = candidates.find(element => element.getClientRects().length && element.textContent.trim().toLowerCase().includes(String(expectedService).toLowerCase())) || target;
    }
    await host.pointAt(target, coach, timingScale, signal, command.narration || 'Open the highlighted APM evidence.', {activate: true});
    const types = {select_apm_service:'apm_service_selected',select_apm_environment:'apm_environment_selected',open_transaction_group:'transaction_group_opened',select_trace_sample:'trace_sample_selected',select_span:'span_selected',open_error_details:'error_details_opened',navigate_to_correlated_logs:'correlated_logs_opened'};
    return {type: types[command.type], details: command.value || {}, state_after: {app: 'apm'}};
  }
});
