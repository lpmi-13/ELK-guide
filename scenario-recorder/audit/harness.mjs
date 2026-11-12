// Shared machinery for the real-coach browser audit (coach-audit.mjs): launching Playwright, the
// passive in-page instrumentation, reading the coach's on-screen state, geometry checks, the learning
// service's API, and the per-case record (events, step screenshots, and a DOM snapshot and trace on
// failure). Nothing here drives the coach: it never calls the adapter, never sends on the learning
// socket and never submits the reference answer. The audit acts only as a learner would — clicking
// the coach's own buttons and, in the recovery and challenge cases, Kibana's controls.
import {execFile} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdir, writeFile, appendFile} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';

const require = createRequire(import.meta.url);
const run = promisify(execFile);

export const config = {
  launcher: (process.env.LAUNCHER_URL || 'http://localhost:8090').replace(/\/$/, ''),
  learning: (process.env.LEARNING_URL || 'http://localhost:8091').replace(/\/$/, ''),
  kibana: (process.env.KIBANA_URL || 'http://localhost:5601').replace(/\/$/, ''),
  repo: process.env.REPO_ROOT || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..'),
};

// Playwright from this package (npm ci), or from PW_PATH (a global @playwright/test install).
export function playwright() {
  try { return require('playwright'); } catch (_error) { /* not installed here */ }
  if (process.env.PW_PATH) return require(process.env.PW_PATH);
  throw new Error('Playwright is not installed: run `npm ci` in scenario-recorder/ or set PW_PATH to a @playwright/test install.');
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ------------------------------------------------------------------------------------------------
// The learning service and the controller's manifest

export async function api(pathname, {method = 'GET', body, token} = {}) {
  const response = await fetch(`${config.learning}${pathname}`, {
    method,
    headers: {'Content-Type': 'application/json', ...(token ? {Authorization: `Bearer ${token}`} : {})},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try { payload = await response.json(); } catch (_error) { payload = null; }
  return {status: response.status, body: payload};
}

export async function runState(runId) {
  const {status, body} = await api(`/api/runs/${runId}`);
  return status === 200 ? body.state : `HTTP ${status}`;
}

// The manifest holds the run's answers, so the controller keeps it off HTTP; read it from its container.
export async function manifest(runId) {
  const {stdout} = await run('docker', ['compose', 'exec', '-T', 'scenario-controller', 'cat', `/tmp/scenario-manifests/${runId}.json`], {cwd: config.repo, maxBuffer: 16 * 1024 * 1024});
  return JSON.parse(stdout);
}

export async function deleteRun(runId) {
  if (runId) await api(`/api/runs/${runId}`, {method: 'DELETE'}).catch(() => {});
}

// ------------------------------------------------------------------------------------------------
// In-page instrumentation (an init script: observes only)

export const INSTRUMENT = () => {
  if (window.top !== window || window.__audit) return;
  const audit = {events: []};
  window.__audit = audit;
  const push = (kind, data) => audit.events.push({t: Date.now(), kind, path: location.pathname, ...data});
  const describe = node => {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    if (!element) return null;
    const subject = element.closest?.('[data-test-subj]')?.getAttribute('data-test-subj') || '';
    const rect = element.getBoundingClientRect?.();
    const root = element.getRootNode?.();
    return {
      subject: subject.slice(0, 120), tag: element.tagName?.toLowerCase(), text: (element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
      inCoach: Boolean(root?.host?.id === 'adaptive-incident-coach' || element.closest?.('#adaptive-incident-coach')),
      rect: rect ? {left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height)} : null,
    };
  };
  document.addEventListener('click', event => push('click', {trusted: event.isTrusted, target: describe(event.composedPath?.()[0] || event.target)}), true);
  document.addEventListener('input', event => push('input', {trusted: event.isTrusted, target: describe(event.target), value: String(event.target?.value ?? '').slice(0, 200)}), true);
  document.addEventListener('keydown', event => { if (event.key === 'Enter') push('enter', {trusted: event.isTrusted, target: describe(event.target)}); }, true);
  const summarize = message => {
    const pick = (source, keys) => Object.fromEntries(keys.filter(key => source?.[key] !== undefined).map(key => [key, source[key]]));
    const result = pick(message, ['message_type', 'command_id', 'step_id', 'step_title', 'step_index', 'step_count', 'type', 'mode', 'target', 'error', 'reason', 'level', 'text', 'paused']);
    if (typeof message.narration === 'string') result.narration = message.narration.slice(0, 300);
    if (typeof message.evidence === 'string') result.evidence = message.evidence.slice(0, 300);
    if (message.value !== undefined) result.value = JSON.stringify(message.value).slice(0, 300);
    if (message.evaluation) result.evaluation = pick(message.evaluation, ['outcome', 'reason_code', 'goals_progressed', 'step_id', 'headline']);
    if (message.action) result.action = message.action;
    return result;
  };
  const NativeSocket = window.WebSocket;
  window.WebSocket = class AuditedWebSocket extends NativeSocket {
    constructor(url, protocols) {
      super(url, protocols);
      if (!/incident-coach\/learning/.test(String(url))) return;
      push('ws_connect', {});
      this.addEventListener('open', () => push('ws_open', {}));
      this.addEventListener('close', event => push('ws_close', {code: event.code}));
      this.addEventListener('message', event => { try { push('ws_in', {message: summarize(JSON.parse(event.data))}); } catch (_error) { /* not JSON */ } });
      const send = this.send.bind(this);
      this.send = data => {
        try {
          const message = JSON.parse(data);
          if (message.message_type !== 'heartbeat') {
            const action = message.action || {};
            push('ws_out', {message: {message_type: message.message_type, type: action.type, actor: action.actor, details: action.details, state_after: action.state_after, command_id: message.command_id, status: message.status}});
          }
        } catch (_error) { /* not JSON */ }
        return send(data);
      };
    }
  };
  // The coach's own pointer shows a click (a 'clicked' class on its cursor) when it presses a control, even
  // where it then follows a link itself: that is the click a learner sees.
  const watchCursor = () => {
    const cursor = document.querySelector('#adaptive-incident-coach')?.shadowRoot?.querySelector('.incident-cursor');
    if (!cursor) return setTimeout(watchCursor, 500);
    new MutationObserver(() => {
      if (!cursor.classList.contains('clicked')) return;
      const box = cursor.getBoundingClientRect();
      const under = document.elementsFromPoint(box.left + box.width / 2, box.top + box.height / 2).find(element => element.id !== 'adaptive-incident-coach');
      push('pointer_click', {target: describe(under)});
    }).observe(cursor, {attributes: true, attributeFilter: ['class']});
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchCursor, {once: true}); else watchCursor();
  audit.drain = () => audit.events.splice(0);
};

// Kibana-internal requests that fail only because this lab runs without security, with nothing shown to
// the learner (verified 2026-11-12): the ES|QL editor's lookup-index privilege check and a dashboard's
// per-user view tracking. Recorded as notes, not failures.
export const KNOWN_SILENT_FAILURES = [/\/internal\/esql\/lookup_index\/privileges/, /\/internal\/dashboard\/user_activity\//];

// What the coach shows right now, read from its (open) shadow root and the page around it.
export const READ_COACH = () => {
  const host = document.querySelector('#adaptive-incident-coach');
  const root = host?.shadowRoot;
  const box = element => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return rect.width && rect.height ? {left: Math.round(rect.left), top: Math.round(rect.top), right: Math.round(rect.right), bottom: Math.round(rect.bottom)} : null;
  };
  const shown = element => element && !element.hidden && getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden';
  const page = {
    url: location.href,
    viewport: {width: innerWidth, height: innerHeight},
    busy: Boolean(document.querySelector("[data-test-subj='discoverDataGridUpdating'], [data-test-subj='loadingSpinner']")),
    hits: document.querySelector("[data-test-subj='discoverQueryHits']")?.textContent?.trim() || null,
    noResults: Boolean(document.querySelector("[data-test-subj='discoverNoResults']")),
    flyouts: [...document.querySelectorAll('.euiFlyout')].map(box).filter(Boolean),
    toasts: [...document.querySelectorAll('.euiToast')].map(element => ({box: box(element), text: element.textContent.trim().replace(/\s+/g, ' ').slice(0, 200)})).filter(toast => toast.box),
    pills: [...document.querySelectorAll("[data-test-subj*='filter-key-']")].map(element => element.textContent.trim()),
    documentOpen: Boolean(document.querySelector("[data-test-subj='docViewerFlyout']")),
    queryBar: document.querySelector("[data-test-subj='queryInput']")?.value ?? null,
    unableToLoad: /Unable to load page/i.test(document.body?.innerText?.slice(0, 4000) || ''),
  };
  if (!root) return {present: false, page};
  const query = selector => root.querySelector(selector);
  const panel = query('aside.panel');
  const stage = query('#stage');
  const buttons = {};
  for (const id of ['pause', 'advance', 'incident-info', 'hint', 'demonstrate', 'review-feedback', 'stop']) {
    const button = query(`#${id}`);
    buttons[id] = button && !button.hidden ? {text: button.textContent.trim(), disabled: button.disabled} : null;
  }
  const status = query('#status');
  const briefing = query('dialog.incident-briefing');
  const debrief = query('dialog.incident-debrief');
  const cursor = query('.incident-cursor');
  const spotlight = query('.incident-spotlight');
  const countdown = query('#countdown');
  return {
    present: true, page,
    panelVisible: Boolean(panel && !panel.hidden && !host.hidden),
    panel: panel && !panel.hidden ? box(panel) : null,
    objective: query('#objective')?.textContent || '',
    modeLine: query('#mode')?.textContent || '',
    eyebrow: query('#phase-eyebrow')?.textContent || '',
    headline: query('#phase-headline')?.textContent || '',
    detail: shown(query('#phase-detail')) ? query('#phase-detail').textContent : '',
    stage: stage && !stage.hidden ? [...stage.classList] : null,
    choices: [...(query('#stage-actions')?.querySelectorAll('button') || [])].map(button => button.textContent.trim()),
    buttons,
    status: status ? {text: status.textContent.trim(), error: status.classList.contains('error')} : null,
    briefing: briefing?.open ? briefing.innerText.slice(0, 3000) : null,
    debrief: debrief?.open ? {className: debrief.className, text: debrief.innerText.slice(0, 6000)} : null,
    diagnosisForm: Boolean(query('#diagnosis') && !query('#diagnosis').hidden),
    cursor: shown(cursor) && getComputedStyle(cursor).opacity !== '0' ? box(cursor) : null,
    spotlight: spotlight?.style.display === 'block' ? box(spotlight) : null,
    rings: [...root.querySelectorAll('.incident-evidence-highlight')].filter(ring => !ring.hidden).map(box).filter(Boolean),
    countdown: countdown && !countdown.hidden ? {working: countdown.classList.contains('working'), width: countdown.querySelector('span')?.getBoundingClientRect().width || 0} : null,
  };
};

// Evaluate in the page, retrying only the transient failures a navigation causes.
export async function evaluate(page, fn, arg) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await page.evaluate(fn, arg);
    } catch (error) {
      const transient = /Execution context was destroyed|Cannot find context|navigation|Target page, context or browser has been closed|frame was detached/i.test(error.message);
      if (!transient || attempt >= 8 || page.isClosed()) throw error;
      await sleep(400);
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Geometry

export function overlapShare(panel, target) {
  if (!panel || !target) return 0;
  const width = Math.min(panel.right, target.right) - Math.max(panel.left, target.left);
  const height = Math.min(panel.bottom, target.bottom) - Math.max(panel.top, target.top);
  if (width <= 0 || height <= 0) return 0;
  const area = (target.right - target.left) * (target.bottom - target.top);
  return area > 0 ? (width * height) / area : 0;
}

export function insideViewport(box, viewport) {
  if (!box) return true;
  const x = (box.left + box.right) / 2;
  const y = (box.top + box.bottom) / 2;
  return x >= 0 && y >= 0 && x <= viewport.width && y <= viewport.height;
}

export const appOf = url => (String(url).match(/\/app\/([^/?#]+)/) || [])[1] || '';

// ------------------------------------------------------------------------------------------------
// The per-case record

export class Record {
  constructor(directory, spec) {
    this.directory = directory;
    this.spec = spec;
    this.findings = [];
    this.notes = [];
    this.steps = [];
    this.shots = 0;
  }

  async open() {
    await mkdir(path.join(this.directory, 'screenshots'), {recursive: true});
  }

  async event(entry) {
    await appendFile(path.join(this.directory, 'events.jsonl'), `${JSON.stringify({t: Date.now(), ...entry})}\n`);
  }

  // A requirement the run broke. `code` groups findings in the summary.
  fail(code, message, detail = {}) {
    if (this.findings.some(item => item.code === code && item.message === message)) return;
    this.findings.push({code, message, ...detail});
    console.log(`    ✗ ${code}: ${message}`);
  }

  note(message) {
    this.notes.push(message);
    console.log(`    · ${message}`);
  }

  async screenshot(page, label) {
    this.shots += 1;
    const file = path.join('screenshots', `${String(this.shots).padStart(3, '0')}-${label.replace(/[^\w.-]+/g, '-').slice(0, 60)}.png`);
    await page.screenshot({path: path.join(this.directory, file)}).catch(() => {});
    return file;
  }

  // On failure: the page's DOM, the coach's shadow DOM, and the trace.
  async snapshot(page, context) {
    if (page && !page.isClosed()) {
      await writeFile(path.join(this.directory, 'dom.html'), await page.content().catch(error => `<!-- ${error.message} -->`));
      const coach = await page.evaluate(() => document.querySelector('#adaptive-incident-coach')?.shadowRoot?.innerHTML || '').catch(() => '');
      await writeFile(path.join(this.directory, 'coach.html'), coach);
      await this.screenshot(page, 'failure');
    }
    if (context) await context.tracing.stop({path: path.join(this.directory, 'trace.zip')}).catch(() => {});
  }

  async save(extra = {}) {
    const summary = {...this.spec, ...extra, passed: this.findings.length === 0, findings: this.findings, notes: this.notes, steps: this.steps};
    await writeFile(path.join(this.directory, 'summary.json'), JSON.stringify(summary, null, 2));
    return summary;
  }
}
