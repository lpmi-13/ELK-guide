// Kibana 8.15 has no server setting for the Discover onboarding callouts.
// Seed the same local preferences as each callout's Dismiss action before the
// Kibana application starts, so the prompts never flash into view.
for (const key of [
  'discover:docExplorerCalloutClosed',
  'discover:docExplorerUpdateCalloutClosed',
]) {
  localStorage.setItem(key, JSON.stringify(true));
}
