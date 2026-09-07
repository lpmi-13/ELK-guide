globalThis.KibanaApplicationAdapters ||= [];
globalThis.KibanaApplicationAdapters.push({
  name: 'common',
  commands: new Set(['navigate_to_app', 'open_saved_object', 'shift_time_range', 'refresh_data', 'set_auto_refresh']),
  async perform(command, host, coach, {timingScale = 1, signal} = {}) {
    if (command.type === 'navigate_to_app' || command.type === 'open_saved_object') {
      const path = command.value?.path || command.value?.url || `/app/${command.value?.app || command.expected_page}`;
      const prefix = location.pathname.match(/^\/s\/[^/]+/)?.[0] || '';
      location.assign(path.startsWith('/s/') ? path : `${prefix}${path}`);
      return {type: command.type === 'navigate_to_app' ? 'app_navigated' : 'saved_object_opened', details: command.value || {}, state_after: {app: command.value?.app || command.expected_page}};
    }
    const target = await host.waitFor(command.target, 20000, signal);
    await host.pointAt(target, coach, timingScale, signal, command.narration || 'Use the selected Kibana control.', {activate: true});
    const types = {shift_time_range: 'time_range_changed', refresh_data: 'data_refreshed', set_auto_refresh: 'auto_refresh_changed'};
    return {type: types[command.type], details: command.value || {}, state_after: command.value || {}};
  }
});
