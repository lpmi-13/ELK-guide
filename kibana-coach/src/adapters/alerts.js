globalThis.KibanaApplicationAdapters ||= [];
globalThis.KibanaApplicationAdapters.push({
  name: 'alerts',
  commands: new Set(['open_alert', 'filter_alerts', 'inspect_alert_reason', 'inspect_alert_history', 'navigate_from_alert_to_source']),
  async perform(command, host, coach, {timingScale = 1, signal} = {}) {
    const target = await host.waitFor(command.target, 20000, signal);
    await host.pointAt(target, coach, timingScale, signal, command.narration || 'Inspect the controller-provisioned alert.', {activate: true});
    const types = {open_alert:'alert_opened',filter_alerts:'alerts_filtered',inspect_alert_reason:'alert_reason_inspected',inspect_alert_history:'alert_history_inspected',navigate_from_alert_to_source:'alert_source_opened'};
    return {type: types[command.type], details: command.value || {}, state_after: {app: 'alerts'}};
  }
});
