// Kibana's versioned favicon URLs can retain an older icon in the browser's
// favicon cache after the preparation tab navigates here. Give the existing
// links a distinct lab URL as soon as the head loads, and keep it if Kibana
// updates those links later.
(function useLabFavicon() {
  const svgUrl = '/incident-coach/assets/favicon.svg?lab-mech-helmet=1';
  const pngUrl = '/incident-coach/assets/favicon.png?lab-mech-helmet=1';
  const apply = () => {
    const links = document.head.querySelectorAll('link[rel~="icon"]');
    if (!links.length) {
      const icon = document.createElement('link');
      icon.rel = 'icon';
      icon.type = 'image/svg+xml';
      icon.href = svgUrl;
      document.head.append(icon);
      return;
    }
    for (const link of links) {
      const target = link.type === 'image/png' ? pngUrl : svgUrl;
      if (link.getAttribute('href') !== target) link.setAttribute('href', target);
    }
  };
  apply();
  new MutationObserver(apply).observe(document.head, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['href', 'rel', 'type'],
  });
})();

// Count Kibana's own search requests (verified 9.5.2: Discover POSTs /internal/search/ese, twice per
// search, ~350-650 ms after Enter — even for an unchanged query — and keeps the previous hit count on
// screen until they return). The action observer reads a result only after the search an action started
// has come back, so an old hit count is never reported as the action's result. Installed here, before
// Kibana's own code captures window.fetch.
function trackKibanaSearches() {
  const searchRequest = /\/internal\/(search|bsearch)\b|\/internal\/esql|\/api\/esql/;
  const state = {started: 0, finished: 0, failed: 0, inFlight: 0};
  window.__coachSearches = state;
  const nativeFetch = window.fetch;
  if (typeof nativeFetch !== 'function') return;
  window.fetch = function fetch(input, init) {
    let url = '';
    try { url = typeof input === 'string' ? input : (input && input.url) || String(input); } catch (_error) { /* opaque input */ }
    if (!searchRequest.test(url)) return nativeFetch.apply(this, arguments);
    state.started += 1;
    state.inFlight += 1;
    const settle = ok => {
      state.inFlight = Math.max(0, state.inFlight - 1);
      state.finished += 1;
      if (!ok) state.failed += 1;
    };
    return nativeFetch.apply(this, arguments).then(response => { settle(response.ok); return response; }, error => { settle(false); throw error; });
  };
}

// Seed the same local preferences as each Discover callout's Dismiss action
// before the Kibana application starts, so the prompts never flash into view.
for (const key of [
  'discover:docExplorerCalloutClosed',
  'discover:docExplorerUpdateCalloutClosed',
]) {
  localStorage.setItem(key, JSON.stringify(true));
}

// Kibana surfaces a "Help us improve Elastic" feedback survey in the lower corner
// on its own schedule. It exposes no reliable configuration or storage switch, so
// hide its portal the moment it mounts — the same net effect as a learner clicking
// "Not now" — to keep it out of demonstrations and recordings.
//
// The survey is a React/EuiPortal overlay that Kibana still owns. Removing its node
// from the DOM makes React throw on its next reconcile or unmount (EuiPortal's own
// teardown calls document.body.removeChild on the now-missing node), which Kibana's
// error boundary renders as a full-page "Unable to load page" fault — landing right
// at the end of a demonstration, when the survey tends to appear and dismiss itself.
// Hiding with CSS instead never touches the tree structure React manages, so the
// overlay disappears without ever provoking that crash.
(function suppressFeedbackSurvey() {
  const surveyText = /improve elastic/i;
  // The survey is portalled beside the app, never inside it; guard the app shell so
  // we only ever hide a floating overlay, never Kibana's own content.
  const appShell = '#kibana-body, [data-test-subj="kibanaChrome"], .kbnAppWrapper, #app-fixed-viewport';

  const start = () => {
    const body = document.body;
    const portalObservers = new Map();
    const watch = child => {
      if (child.nodeType !== 1 || child.tagName === 'SCRIPT' || child.tagName === 'STYLE') return;
      if (portalObservers.has(child)) return;
      if (child.matches(appShell) || child.querySelector(appShell)) return;
      const inspect = () => {
        if (child.style.display === 'none') return true;
        if (child.matches(appShell) || child.querySelector(appShell)) return true;
        if (!surveyText.test(child.textContent || '')) return false;
        // Keep the React-owned portal attached so its later unmount remains valid.
        child.style.setProperty('display', 'none', 'important');
        return true;
      };
      if (inspect()) return;
      let scheduled = false;
      const observer = new MutationObserver(() => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
          scheduled = false;
          if (!child.isConnected || inspect()) {
            observer.disconnect();
            portalObservers.delete(child);
          }
        });
      });
      observer.observe(child, {childList: true, subtree: true, characterData: true});
      portalObservers.set(child, observer);
    };
    // Portals are added directly to body; Kibana's much larger app subtree is
    // never observed or searched on every React update.
    new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) watch(node);
        for (const node of record.removedNodes) {
          portalObservers.get(node)?.disconnect();
          portalObservers.delete(node);
        }
      }
    }).observe(body, {childList: true});
    for (const child of body.children) watch(child);
  };

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();

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
// Cover Kibana's own boot screen — a white flash, then the light "Loading Elastic"
// splash — so the investigation tab moves seamlessly from the launcher's dark
// "Preparing…" page straight into the incident briefing, with no logo flash in
// between. This runs synchronously in <head>, before Kibana paints anything, and
// is only raised when a valid coach session is auto-starting (see below). The
// content script tears it down once the briefing is up (or on failure), and a
// safety timeout guarantees the tab can never get stuck behind it.
function showCoachBootOverlay() {
  if (document.getElementById('incident-coach-boot')) return;
  const overlay = document.createElement('div');
  overlay.id = 'incident-coach-boot';
  overlay.setAttribute('role', 'status');
  overlay.setAttribute('aria-label', 'Opening Kibana');
  overlay.innerHTML =
    '<style>' +
    '#incident-coach-boot{position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;' +
    'align-items:center;justify-content:center;gap:18px;background:#0d1721;color:#eef5fb;' +
    'font:15px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
    'opacity:1;transition:opacity .2s ease;}' +
    '#incident-coach-boot[data-hiding]{opacity:0;pointer-events:none;}' +
    '#incident-coach-boot .icb-spinner{width:34px;height:34px;border-radius:50%;' +
    'border:3px solid #23384a;border-top-color:#32b8eb;animation:icb-spin .8s linear infinite;}' +
    '#incident-coach-boot .icb-text{margin:0;color:#c6d4df;}' +
    '@keyframes icb-spin{to{transform:rotate(360deg);}}' +
    '@media (prefers-reduced-motion:reduce){#incident-coach-boot .icb-spinner{animation:none;}' +
    '#incident-coach-boot{transition:none;}}' +
    '</style>' +
    '<div class="icb-spinner" aria-hidden="true"></div>' +
    '<p class="icb-text">Opening Kibana…</p>';
  document.documentElement.append(overlay);

  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    clearTimeout(safety);
    overlay.setAttribute('data-hiding', '');
    // Reveal Kibana after the fade, but drop the node regardless if the transition
    // never fires (e.g. reduced motion, detached tab).
    const drop = () => overlay.remove();
    overlay.addEventListener('transitionend', drop, {once: true});
    setTimeout(drop, 400);
  };
  // Last resort if the content script never signals us (e.g. the auto-connect
  // config is rejected and no session ever starts): never leave the tab dark.
  const safety = setTimeout(remove, 20000);
  window.__coachBootOverlay = {
    // Called once the briefing is showing: cancel the safety timer so the overlay
    // stays put behind the briefing until the learner dismisses it.
    hold() { clearTimeout(safety); },
    release: remove,
  };
}

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
    // A valid coach session is auto-starting: mask Kibana's boot until the briefing.
    showCoachBootOverlay();
  }
}

// The gateway adds this small bootstrap to every Kibana page, including its
// off-screen cache warm-up. Only a tab with a learner session needs the coach's
// other scripts, DOM observers, and search-request instrumentation.
if (sessionStorage.getItem(activeSessionKey)) {
  trackKibanaSearches();
  for (const path of [
    'src/ui/cursor.js',
    'src/ui/spotlight.js',
    'src/ui/incident-briefing.js',
    'src/ui/coach-panel.js',
    'src/ui/debrief.js',
    'src/adapters/common.js',
    'src/adapters/discover.js',
    'src/adapters/dashboard.js',
    'src/adapters/apm.js',
    'src/adapters/infrastructure.js',
    'src/adapters/alerts.js',
    'src/kibana-adapter.js',
    'src/action-observer.js',
    'src/session-client.js',
    'src/content-script.js',
  ]) {
    const script = document.createElement('script');
    script.async = false; // keep the plain-script globals in dependency order
    script.src = `/incident-coach/assets/${path}`;
    document.head.append(script);
  }
}
