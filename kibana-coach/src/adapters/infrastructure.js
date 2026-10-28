globalThis.KibanaApplicationAdapters ||= [];
globalThis.KibanaApplicationAdapters.push({
  name: 'infrastructure',
  commands: new Set(['select_inventory_type', 'select_infrastructure_entity', 'filter_infrastructure_entities', 'group_infrastructure_entities', 'select_metric', 'compare_metric_period', 'navigate_from_metrics_to_logs']),
  async perform(command, host, coach, {timingScale = 1, signal} = {}) {
    const value = command.value || {};
    const narration = command.narration || 'Use the highlighted infrastructure control.';
    this.dismissTour();
    // The inventory switcher ("Show") and the Metric menu open a list to choose from (verified 9.5.2:
    // `goToHost` / `goToPods` …, and buttons in `infraInventoryMetricsContextMenu`).
    if (command.type === 'select_inventory_type' || command.type === 'select_metric') {
      const choice = command.type === 'select_inventory_type' ? value.type : value.metric;
      const opener = await host.waitFor(command.target, 20000, signal);
      await host.pointAt(opener, coach, timingScale, signal, narration, {activate: true, hold: false});
      const option = await this.option(command.type === 'select_inventory_type' ? 'kibana.inventory_option' : 'kibana.metric_option', choice, host, signal);
      await host.pointAt(option, coach, timingScale, signal, `Choose ${choice}.`, {activate: true});
      const type = command.type === 'select_inventory_type' ? 'inventory_type_selected' : 'metric_selected';
      return {type, details: {value: choice}, state_after: {app: 'metrics'}};
    }
    const named = command.type === 'select_infrastructure_entity' ? value.value : null;
    // The entity's details close between steps (a pod's menu is a popover the last step's reading beat
    // dismisses), so open the entity again when its logs pivot isn't on screen.
    if (command.type === 'navigate_from_metrics_to_logs' && value.value && !(await host.waitFor(command.target, 2000, signal).catch(() => null))) {
      const entity = host.targetNaming('kibana.infrastructure_entity', value.value, await host.waitFor('kibana.infrastructure_entity', 20000, signal));
      await host.pointAt(entity, coach, timingScale, signal, `Open ${value.value} again.`, {activate: true, hold: false});
    }
    const target = host.targetNaming(command.target, named, await host.waitFor(command.target, 20000, signal));
    // A host opens a details flyout whose Logs tab stays here; a pod opens a menu whose "Kubernetes Pod
    // logs" link leaves for Discover (verified 9.5.2), so the step reports first and the coach follows it.
    if (command.type === 'navigate_from_metrics_to_logs' && target.matches?.('a[href]')) {
      await host.pointAt(target, coach, timingScale, signal, narration, {activate: false});
      return {type: 'metrics_logs_opened', details: {}, state_after: {app: 'metrics'}, navigate: new URL(target.getAttribute('href'), location.href).href};
    }
    await host.pointAt(target, coach, timingScale, signal, narration, {activate: true});
    const types = {select_infrastructure_entity: 'infrastructure_entity_selected', filter_infrastructure_entities: 'infrastructure_entities_filtered', group_infrastructure_entities: 'infrastructure_entities_grouped', compare_metric_period: 'metric_period_compared', navigate_from_metrics_to_logs: 'metrics_logs_opened'};
    return {type: types[command.type], details: named ? {value: named} : {}, state_after: {app: 'metrics'}};
  },

  // The list entry for `choice` once its menu has opened.
  async option(name, choice, host, signal) {
    const wanted = String(choice || '').toLowerCase();
    const find = () => (host.registry?.targets?.[name] || []).flatMap(selector => [...document.querySelectorAll(selector)])
      .find(node => node.getClientRects().length && node.textContent.trim().toLowerCase() === wanted);
    const deadline = Date.now() + 5000;
    while (!find() && Date.now() < deadline) await host.wait(100, signal);
    if (!find()) throw new Error(`Kibana target not found: ${choice}`);
    return find();
  },

  // Kibana's "see your infrastructure in different ways" tour opens over the inventory switcher. (The
  // observer is muted while the coach performs, so this click is not reported.)
  dismissTour() {
    document.querySelector("[data-test-subj='infra-kubernetesTour-dismiss']")?.click();
  },
});
