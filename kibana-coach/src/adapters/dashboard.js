globalThis.KibanaApplicationAdapters ||= [];
globalThis.KibanaApplicationAdapters.push({
  name: 'dashboard',
  commands: new Set(['set_dashboard_control', 'interact_with_panel_value', 'open_panel_drilldown', 'inspect_panel', 'view_panel_underlying_data']),
  async perform(command, host, coach, {timingScale = 1, signal} = {}) {
    const target = await host.waitFor(command.target, 20000, signal);
    await host.pointAt(target, coach, timingScale, signal, command.narration || 'Interact with the supplied dashboard in view mode.', {activate: true});
    const types = {set_dashboard_control: 'dashboard_control_changed', interact_with_panel_value: 'panel_value_selected', open_panel_drilldown: 'panel_drilldown_opened', inspect_panel: 'panel_inspected', view_panel_underlying_data: 'panel_underlying_data_opened'};
    return {type: types[command.type], details: command.value || {}, state_after: {app: 'dashboard'}};
  }
});
