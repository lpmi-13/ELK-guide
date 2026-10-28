globalThis.KibanaApplicationAdapters ||= [];

// The alert details page's "View in Discover" (verified 9.5.2: `alertDetailsPage_viewInDiscover_<rule
// type>`, an /app/r?l=DISCOVER_APP_LOCATOR link) opens with target=_blank, which would leave the coach —
// and the learner's session — behind in this tab. Follow it here instead, a moment after the click, so
// the observer's report of it goes out before the page does.
document.addEventListener('click', event => {
  const link = event.target.closest?.("a[data-test-subj^='alertDetailsPage_viewInDiscover_'][href]");
  if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
  event.preventDefault();
  const destination = new URL(link.getAttribute('href'), location.href).href;
  setTimeout(() => location.assign(destination), 150);
}, true);

globalThis.KibanaApplicationAdapters.push({
  name: 'alerts',
  commands: new Set(['open_alert', 'filter_alerts', 'inspect_alert_reason', 'inspect_alert_history', 'navigate_from_alert_to_source']),
  async perform(command, host, coach, {timingScale = 1, signal} = {}) {
    const value = command.value || {};
    const narration = command.narration || 'Inspect the controller-provisioned alert.';
    if (command.type === 'open_alert') {
      const button = await this.expandButton(value.value, host, signal);
      await host.pointAt(button, coach, timingScale, signal, narration, {activate: true});
      await host.waitFor('kibana.alert_reason', 10000, signal).catch(() => null);
      return {type: 'alert_opened', details: {value: value.value}, state_after: {app: 'alerts'}};
    }
    if (command.type === 'navigate_from_alert_to_source') {
      // Point at the link without following it: the step reports first, then the coach opens it here.
      const link = await host.waitFor(command.target, 20000, signal);
      await host.pointAt(link, coach, timingScale, signal, narration, {activate: false});
      return {type: 'alert_source_opened', details: {}, state_after: {app: 'alerts'}, navigate: new URL(link.getAttribute('href'), location.href).href};
    }
    const target = host.targetNaming(command.target, value.value, await host.waitFor(command.target, 20000, signal));
    await host.pointAt(target, coach, timingScale, signal, narration, {activate: true});
    if (command.type === 'inspect_alert_reason') await host.waitFor('kibana.alert_source_link', 15000, signal).catch(() => null);
    const types = {filter_alerts: 'alerts_filtered', inspect_alert_reason: 'alert_reason_inspected', inspect_alert_history: 'alert_history_inspected'};
    return {type: types[command.type], details: {value: value.value}, state_after: {app: 'alerts'}};
  },

  // The expand (open details) button on the alerts table row whose rule is `name` (verified 9.5.2: the
  // data grid's `expandColumn` cell beside a `kibana.alert.rule.name` cell in the same row).
  async expandButton(name, host, signal) {
    const find = () => {
      const cells = [...document.querySelectorAll("[data-gridcell-column-id='kibana.alert.rule.name']")];
      // A grid cell's text ends in a screen-reader marker ("↦"), so match on containment.
      const cell = cells.find(item => !name || item.textContent.includes(name)) || cells[0];
      const row = cell?.getAttribute('data-gridcell-row-index');
      return row == null ? null : document.querySelector(`[data-gridcell-column-id='expandColumn'][data-gridcell-row-index='${row}'] button`);
    };
    const deadline = Date.now() + 20000;
    while (!find() && Date.now() < deadline) await host.wait(100, signal);
    const button = find();
    if (!button) throw new Error(`Kibana target not found: alert ${name}`);
    return button;
  },
});
