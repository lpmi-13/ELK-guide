globalThis.KibanaApplicationAdapters ||= [];
globalThis.KibanaApplicationAdapters.push({
  name: 'infrastructure',
  commands: new Set(['select_inventory_type', 'select_infrastructure_entity', 'filter_infrastructure_entities', 'group_infrastructure_entities', 'select_metric', 'compare_metric_period', 'navigate_from_metrics_to_logs']),
  async perform(command, host, coach, {timingScale = 1, signal} = {}) {
    const target = await host.waitFor(command.target, 20000, signal);
    await host.pointAt(target, coach, timingScale, signal, command.narration || 'Use the highlighted infrastructure control.', {activate: true});
    const types = {select_inventory_type:'inventory_type_selected',select_infrastructure_entity:'infrastructure_entity_selected',filter_infrastructure_entities:'infrastructure_entities_filtered',group_infrastructure_entities:'infrastructure_entities_grouped',select_metric:'metric_selected',compare_metric_period:'metric_period_compared',navigate_from_metrics_to_logs:'metrics_logs_opened'};
    return {type: types[command.type], details: command.value || {}, state_after: {app: 'metrics'}};
  }
});
