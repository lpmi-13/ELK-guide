// Kibana 8.15 has no server setting for the Discover onboarding callouts.
// Seed the same local preferences as each callout's Dismiss action before the
// Kibana application starts, so the prompts never flash into view.
for (const key of [
  'discover:docExplorerCalloutClosed',
  'discover:docExplorerUpdateCalloutClosed',
]) {
  localStorage.setItem(key, JSON.stringify(true));
}

// The launcher hands the selected run to this tab in one-use query parameters.
// Consume them before Kibana starts, then remove the token from the address bar.
const activeSessionKey = 'incident-coach:auto-connect';
const coachParameterNames = [
  'incident_coach_server',
  'incident_coach_session',
  'incident_coach_token',
  'incident_coach_run',
  'incident_coach_mode',
];
const launchUrl = new URL(location.href);
const hashSeparator = launchUrl.hash.indexOf('?');
const hashRoute = hashSeparator >= 0 ? launchUrl.hash.slice(0, hashSeparator) : launchUrl.hash;
const hashParameters = new URLSearchParams(hashSeparator >= 0 ? launchUrl.hash.slice(hashSeparator + 1) : '');
const handoffParameters = coachParameterNames.some(name => hashParameters.has(name))
  ? hashParameters
  : launchUrl.searchParams;
if (coachParameterNames.some(name => handoffParameters.has(name))) {
  const config = {
    server: handoffParameters.get('incident_coach_server'),
    session: handoffParameters.get('incident_coach_session'),
    token: handoffParameters.get('incident_coach_token'),
    runId: handoffParameters.get('incident_coach_run'),
    mode: handoffParameters.get('incident_coach_mode'),
  };
  for (const name of coachParameterNames) {
    launchUrl.searchParams.delete(name);
    hashParameters.delete(name);
  }
  const remainingHashParameters = hashParameters.toString();
  launchUrl.hash = `${hashRoute}${remainingHashParameters ? `?${remainingHashParameters}` : ''}`;
  history.replaceState(history.state, '', launchUrl.href);
  sessionStorage.removeItem(activeSessionKey);

  const builtInServer = `${location.origin}/incident-coach/learning`;
  const allowedServers = new Set([builtInServer, 'http://localhost:8091', 'http://127.0.0.1:8091']);
  if (Object.values(config).every(Boolean) && allowedServers.has(config.server.replace(/\/$/, ''))) {
    sessionStorage.setItem(activeSessionKey, JSON.stringify(config));
  }
}
