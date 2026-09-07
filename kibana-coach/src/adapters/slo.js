globalThis.KibanaApplicationAdapters ||= [];
globalThis.KibanaApplicationAdapters.push({
  name: 'slo',
  commands: new Set(['open_slo', 'inspect_slo_indicator', 'inspect_slo_error_budget', 'inspect_slo_burn_rate']),
  async perform(command, host, coach, {timingScale = 1, signal} = {}) {
    const target = await host.waitFor(command.target, 20000, signal);
    await host.pointAt(target, coach, timingScale, signal, command.narration || 'Inspect the supplied SLO.', {activate: true});
    const types = {open_slo:'slo_opened',inspect_slo_indicator:'slo_indicator_inspected',inspect_slo_error_budget:'slo_error_budget_inspected',inspect_slo_burn_rate:'slo_burn_rate_inspected'};
    return {type: types[command.type], details: command.value || {}, state_after: {app: 'slos'}};
  }
});
