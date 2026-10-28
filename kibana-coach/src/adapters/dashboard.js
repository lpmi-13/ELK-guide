globalThis.KibanaApplicationAdapters ||= [];

// Kibana's "Explore in Discover" panel action opens the panel's records in a new tab (verified 9.5.2:
// window.open of an /app/r?l=DISCOVER_APP_LOCATOR link), which would leave the coach — and the
// learner's session — behind in this one. Keep that one navigation in this tab instead. When the coach
// clicks it, hold the link so the step can report before the page goes (see `navigate`).
(() => {
  const nativeOpen = window.open;
  window.open = function open(url, target, features) {
    try {
      const destination = new URL(url, location.href);
      if (/\/app\/dashboards/.test(location.pathname) && destination.origin === location.origin && /\/app\/(r|discover)(\/|$)/.test(destination.pathname)) {
        const deferred = globalThis.__coachDeferredNavigation;
        if (deferred) deferred.url = destination.href;
        else location.assign(destination.href);
        return null;
      }
    } catch (_error) { /* not a URL we keep */ }
    return nativeOpen.call(window, url, target, features);
  };
})();

globalThis.KibanaApplicationAdapters.push({
  name: 'dashboard',
  commands: new Set(['set_dashboard_control', 'interact_with_panel_value', 'open_panel_drilldown', 'inspect_panel', 'view_panel_underlying_data']),
  async perform(command, host, coach, {timingScale = 1, signal} = {}) {
    const value = command.value || {};
    const narration = command.narration || 'Interact with the supplied dashboard in view mode.';
    if (command.type === 'interact_with_panel_value') {
      await this.filterForValue(value, host, coach, timingScale, signal, narration);
      return {type: 'panel_value_selected', details: {value: String(value.value), panel: value.panel}, state_after: {app: 'dashboard'}};
    }
    if (command.type === 'inspect_panel' || command.type === 'view_panel_underlying_data') {
      const panel = await this.panel(value.panel, host, signal);
      const subject = command.type === 'inspect_panel' ? 'embeddablePanelAction-openInspector' : 'embeddablePanelAction-ACTION_OPEN_IN_DISCOVER';
      const action = panel?.querySelector(`[data-test-subj='${subject}']`) || await host.waitFor(command.target, 20000, signal);
      if (command.type === 'inspect_panel') {
        await host.pointAt(action, coach, timingScale, signal, narration, {activate: true});
        await this.showRequests(host, signal);
        return {type: 'panel_inspected', details: {panel: value.panel}, state_after: {app: 'dashboard'}};
      }
      const deferred = globalThis.__coachDeferredNavigation = {url: null};
      try {
        await host.pointAt(action, coach, timingScale, signal, narration, {activate: true});
        const deadline = Date.now() + 5000;
        while (!deferred.url && Date.now() < deadline) await host.wait(100, signal);
      } finally {
        globalThis.__coachDeferredNavigation = null;
      }
      return {type: 'panel_underlying_data_opened', details: {panel: value.panel}, state_after: {app: 'dashboard'}, navigate: deferred.url};
    }
    const target = host.targetNaming(command.target, value.value, await host.waitFor(command.target, 20000, signal));
    await host.pointAt(target, coach, timingScale, signal, narration, {activate: true});
    const types = {set_dashboard_control: 'dashboard_control_changed', open_panel_drilldown: 'panel_drilldown_opened'};
    return {type: types[command.type], details: value, state_after: {app: 'dashboard'}};
  },

  // The dashboard panel titled `title` (verified 9.5.2: `dashboardPanel` wrapping the hover actions
  // and an `embeddablePanelTitle`), or null when none carries that title.
  async panel(title, host, signal) {
    const find = () => [...document.querySelectorAll("[data-test-subj='dashboardPanel']")]
      .find(panel => panel.querySelector("[data-test-subj='embeddablePanelTitle']")?.textContent?.trim() === title) || null;
    const deadline = Date.now() + 20000;
    while (title && !find() && Date.now() < deadline) await host.wait(100, signal);
    return find();
  },

  // Filter every panel to one chart value the way a learner can see and repeat (verified 9.5.2 Lens):
  // each legend entry carries a `legend-<value>` actions button whose menu offers
  // `legend-<value>-filterIn` ("Filter for"). A bar on the canvas has no element to point at.
  async filterForValue({value, panel: title}, host, coach, timingScale, signal, narration) {
    const panel = await this.panel(title, host, signal);
    const scope = panel || document;
    const subject = `legend-${value}`;
    const actions = () => [...scope.querySelectorAll("[data-test-subj^='legend-']")].find(node => node.getAttribute('data-test-subj') === subject && node.getClientRects().length);
    const deadline = Date.now() + 20000;
    while (!actions() && Date.now() < deadline) await host.wait(100, signal);
    const button = actions();
    if (!button) throw new Error(`Kibana target not found: legend entry ${value}`);
    // Point at the entry itself (its actions button only shows on hover), then open its menu.
    await host.pointAt(button.closest('.echLegendItem') || button, coach, timingScale, signal, narration, {activate: false, hold: false});
    button.click();
    const filterFor = () => [...document.querySelectorAll("[data-test-subj$='-filterIn']")].find(node => node.getAttribute('data-test-subj') === `${subject}-filterIn`);
    const menuDeadline = Date.now() + 5000;
    while (!filterFor() && Date.now() < menuDeadline) await host.wait(100, signal);
    if (!filterFor()) throw new Error(`Kibana target not found: Filter for ${value}`);
    await host.pointAt(filterFor(), coach, timingScale, signal, `Filter for ${value}, so every panel shows only it.`, {activate: true});
    // Let the pill land before the step reports, so the observer takes it as the coach's, not the learner's.
    const pillDeadline = Date.now() + 3000;
    while (!document.querySelector(`[data-test-subj*='filter-value-${CSS.escape(String(value))}']`) && Date.now() < pillDeadline) await host.wait(100, signal);
  },

  // Open the inspector's Requests view, which shows the query behind the panel's number (verified 9.5.2:
  // inspectorViewChooser → inspectorViewChooserRequests). The Data view only repeats the chart's buckets.
  async showRequests(host, signal) {
    const chooser = await host.waitFor('kibana.inspector_view_chooser', 8000, signal).catch(() => null);
    if (!chooser) return;
    chooser.click();
    const option = () => document.querySelector("[data-test-subj='inspectorViewChooserRequests']");
    const deadline = Date.now() + 3000;
    while (!option() && Date.now() < deadline) await host.wait(100, signal);
    option()?.click();
  },
});
