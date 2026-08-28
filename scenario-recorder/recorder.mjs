import {chromium} from 'playwright';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import selectors from './selectors.json' with {type: 'json'};

const learningUrl = (process.env.LEARNING_URL || 'http://learning-service:8091').replace(/\/$/, '');
const kibanaUrl = process.env.KIBANA_URL || 'http://kibana:5601/app/discover#/view/incident-investigation';
const seed = Number(process.env.SCENARIO_SEED || 20260822);
const outputDir = process.env.RECORDING_DIR || '/recordings';
const viewport = {width: 1440, height: 900};

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {...options, headers: {'Content-Type': 'application/json', ...(options.headers || {})}});
  const result = await response.json();
  if (!response.ok) throw new Error(`${url}: ${result.error || response.status}`);
  return result;
}

async function waitReady(runId) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const run = await jsonRequest(`${learningUrl}/api/runs/${runId}`);
    if (run.state === 'READY') return run;
    if (run.state === 'FAILED') throw new Error(run.error || 'Scenario failed');
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error('Scenario readiness timed out');
}

function resolve(page, target) {
  return page.locator((selectors.targets[target] || []).join(',')).first();
}

async function setInput(locator, value) {
  await locator.waitFor({state: 'visible'});
  await locator.fill(value);
}

async function perform(page, command) {
  if (command.type === 'orient') return null;
  if (command.type === 'request_diagnosis') return {answer: true};
  const target = resolve(page, command.target);
  await target.waitFor({state: 'visible'});
  if (command.type === 'set_time_range') {
    await target.click();
    const number = resolve(page, 'kibana.time_value');
    if (await number.count()) {
      await number.fill('10');
      await resolve(page, 'kibana.time_unit').selectOption('m');
      await resolve(page, 'kibana.time_apply').click();
    } else {
      throw new Error('Kibana relative time controls were not found');
    }
    return {type: 'time_range_changed', details: command.value, state_after: {time_from: command.value.from}};
  }
  if (command.type === 'enter_query' || command.type === 'add_filter') {
    const query = resolve(page, 'kibana.query_bar');
    let value = command.value;
    let actionType = 'query_submitted';
    let details = {query: value};
    if (command.type === 'add_filter') {
      value = `scenario.id: "${command.run_id}" and event.duration >= 2000000000 and ${command.value.field}: "${command.value.value}"`;
      actionType = 'filter_added';
      details = command.value;
    }
    await setInput(query, value);
    await resolve(page, 'kibana.query_submit').click();
    await page.waitForLoadState('networkidle').catch(() => {});
    return {type: actionType, details, state_after: {query: value}};
  }
  if (command.type === 'open_trace') {
    const visibleTrace = resolve(page, 'kibana.first_trace_value');
    await visibleTrace.waitFor({state: 'visible'});
    const traceId = (await visibleTrace.textContent()).trim();
    await target.click();
    return {type: 'trace_opened', details: {trace_id: traceId}, state_after: {trace_id: traceId}};
  }
  throw new Error(`Unsupported command ${command.type}`);
}

async function main() {
  await mkdir(outputDir, {recursive: true});
  const startedAt = new Date().toISOString();
  const created = await jsonRequest(`${learningUrl}/api/runs`, {method: 'POST', body: JSON.stringify({scenario: 'slow-payments', seed, mode: 'demonstration'})});
  await waitReady(created.run.run_id);
  const claim = await jsonRequest(`${learningUrl}/api/sessions/${created.session.session_id}/claim`, {method: 'POST', body: JSON.stringify({code: created.session.pairing_code})});
  const browser = await chromium.launch({headless: true});
  const context = await browser.newContext({viewport, locale: 'en-GB', timezoneId: 'UTC', colorScheme: 'dark', reducedMotion: 'reduce', recordVideo: {dir: outputDir, size: viewport}});
  await context.addInitScript(() => {
    for (const key of [
      'discover:docExplorerCalloutClosed',
      'discover:docExplorerUpdateCalloutClosed',
    ]) {
      localStorage.setItem(key, JSON.stringify(true));
    }
  });
  const page = await context.newPage();
  const snapshots = [];
  let outcome = 'completed';
  let actionSequence = 0;
  let traceId = '';
  let score = null;
  const pending = [];
  let wake;
  const wsUrl = learningUrl.replace(/^http/, 'ws') + claim.websocket_path + `?token=${encodeURIComponent(claim.token)}`;
  const socket = new WebSocket(wsUrl);
  socket.onmessage = event => { pending.push(JSON.parse(event.data)); wake?.(); };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const nextMessage = async () => {
    while (!pending.length) await new Promise(resolve => { wake = resolve; });
    wake = null;
    return pending.shift();
  };
  await page.goto(kibanaUrl, {waitUntil: 'domcontentloaded'});
  try {
    while (true) {
      const message = await nextMessage();
      if (message.message_type !== 'command') continue;
      if (message.type === 'request_diagnosis') {
        const answer = {service: 'payments', fault_type: 'latency', affected_route: '/checkout', trace_id: traceId, evidence: 'The payment transaction dominates the correlated checkout trace.'};
        const feedback = await jsonRequest(`${learningUrl}/api/sessions/${created.session.session_id}/answer`, {method: 'POST', headers: {Authorization: `Bearer ${claim.token}`}, body: JSON.stringify(answer)});
        if (!feedback.diagnosis_correct) throw new Error(`Reference diagnosis was rejected: ${JSON.stringify(feedback.components)}`);
        score = feedback.total;
        break;
      }
      const result = await perform(page, message);
      if (result?.details?.trace_id) traceId = result.details.trace_id;
      actionSequence += 1;
      socket.send(JSON.stringify({message_type: 'action', action: {protocol_version: 1, run_id: created.run.run_id, session_id: created.session.session_id, sequence: actionSequence, type: result.type, actor: 'tutorial', observed_at: new Date().toISOString(), details: result.details || {}, state_before: {}, state_after: result.state_after || {}}}));
    }
  } catch (error) {
    outcome = 'failed';
    const screenshot = path.join(outputDir, `${created.run.run_id}-failure.png`);
    await page.screenshot({path: screenshot, fullPage: true});
    const dom = path.join(outputDir, `${created.run.run_id}-failure.html`);
    await writeFile(dom, await page.content());
    snapshots.push(screenshot, dom);
    throw error;
  } finally {
    socket.close();
    const video = page.video();
    await context.close();
    const videoPath = path.join(outputDir, `${created.run.run_id}.webm`);
    if (video) {
      await video.saveAs(videoPath);
      await video.delete();
    }
    await browser.close();
    const metadata = {schema_version: 1, run_id: created.run.run_id, scenario: 'slow-payments', seed, playbook: 'slow-service-investigation@1', kibana_version: '8.15.3', playwright_version: '1.62.1', viewport, locale: 'en-GB', timezone: 'UTC', reduced_motion: true, started_at: startedAt, completed_at: new Date().toISOString(), outcome, score, artifacts: snapshots};
    await writeFile(path.join(outputDir, `${created.run.run_id}.json`), JSON.stringify(metadata, null, 2));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
