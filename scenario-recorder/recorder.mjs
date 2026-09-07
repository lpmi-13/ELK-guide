import {chromium} from 'playwright';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import selectors from './selectors.json' with {type: 'json'};

const learningUrl = (process.env.LEARNING_URL || 'http://learning-service:8091').replace(/\/$/, '');
const kibanaUrl = process.env.KIBANA_URL || 'http://kibana:5601';
const seed = Number(process.env.SCENARIO_SEED || 20260822);
const scenario = process.env.SCENARIO || 'slow-payments';
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
  if (command.type === 'request_diagnosis' || command.type === 'request_answer') return {answer: true};
  let target = resolve(page, command.target);
  if (command.type === 'select_apm_service' && command.value?.service) {
    const candidates = page.locator((selectors.targets[command.target] || []).join(','));
    const matching = candidates.filter({hasText: command.value.service}).first();
    if (await matching.count()) target = matching;
  }
  await target.waitFor({state: 'visible'});
  if (command.type === 'set_time_range') {
    await target.click();
    const number = resolve(page, 'kibana.time_value');
    try {
      if (!(await number.isVisible())) {
        await resolve(page, 'kibana.time_custom_range').click();
      }
      await number.waitFor({state: 'visible', timeout: 10_000});
      await number.fill('10');
      const unit = resolve(page, 'kibana.time_unit');
      const minuteValue = await unit.locator('option').evaluateAll(options => {
        const minute = options.find(option => /^minutes? ago$/i.test(option.textContent.trim()))
          || options.find(option => /^minutes?$/i.test(option.textContent.trim()));
        return minute?.value;
      });
      await unit.selectOption(minuteValue);
      await resolve(page, 'kibana.time_apply').click();
    } catch (error) {
      throw new Error('Kibana relative time controls were not found');
    }
    return {type: 'time_range_changed', details: command.value, state_after: {time_from: command.value.from}};
  }
  if (['enter_query', 'enter_kql', 'enter_esql', 'add_filter'].includes(command.type)) {
    const query = resolve(page, command.type === 'enter_esql' ? 'kibana.esql_editor' : 'kibana.query_bar');
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
    if (command.type === 'enter_esql') actionType = 'esql_submitted';
    return {type: actionType, details: {...details, language: command.type === 'enter_esql' ? 'esql' : 'kql'}, state_after: {query: value, query_language: command.type === 'enter_esql' ? 'esql' : 'kql'}};
  }
  if (command.type === 'open_trace') {
    const visibleTrace = resolve(page, 'kibana.first_trace_value');
    await visibleTrace.waitFor({state: 'visible'});
    const traceId = (await visibleTrace.textContent()).trim();
    await target.click();
    return {type: 'trace_opened', details: {trace_id: traceId}, state_after: {trace_id: traceId}};
  }
  const observations = {
    switch_query_language:'query_language_changed', select_data_view:'data_view_selected', edit_filter:'filter_changed', remove_filter:'filter_removed', disable_filter:'filter_disabled',
    add_column:'column_added', remove_column:'column_removed', sort_column:'sort_changed', expand_document:'document_expanded', inspect_field:'field_inspected', open_field_statistics:'field_statistics_opened', open_surrounding_documents:'surrounding_documents_opened',
    set_dashboard_control:'dashboard_control_changed', interact_with_panel_value:'panel_value_selected', open_panel_drilldown:'panel_drilldown_opened', inspect_panel:'panel_inspected', view_panel_underlying_data:'panel_underlying_data_opened',
    select_apm_service:'apm_service_selected', select_apm_environment:'apm_environment_selected', open_transaction_group:'transaction_group_opened', select_trace_sample:'trace_sample_selected', select_span:'span_selected', open_error_details:'error_details_opened', navigate_to_correlated_logs:'correlated_logs_opened',
    select_inventory_type:'inventory_type_selected', select_infrastructure_entity:'infrastructure_entity_selected', filter_infrastructure_entities:'infrastructure_entities_filtered', group_infrastructure_entities:'infrastructure_entities_grouped', select_metric:'metric_selected', compare_metric_period:'metric_period_compared', navigate_from_metrics_to_logs:'metrics_logs_opened',
    open_alert:'alert_opened', filter_alerts:'alerts_filtered', inspect_alert_reason:'alert_reason_inspected', inspect_alert_history:'alert_history_inspected', navigate_from_alert_to_source:'alert_source_opened'
  };
  if (observations[command.type]) {
    await target.click();
    return {type: observations[command.type], details: command.value || {}, state_after: {app: command.expected_page}};
  }
  throw new Error(`Unsupported command ${command.type}`);
}

async function main() {
  await mkdir(outputDir, {recursive: true});
  const startedAt = new Date().toISOString();
  const created = await jsonRequest(`${learningUrl}/api/runs`, {method: 'POST', body: JSON.stringify({scenario, seed, mode: 'demonstration'})});
  await waitReady(created.run.run_id);
  const publicInvestigation = new URL(created.session.investigation_url);
  const internalKibana = new URL(kibanaUrl);
  internalKibana.pathname = publicInvestigation.pathname;
  internalKibana.search = publicInvestigation.search;
  internalKibana.hash = publicInvestigation.hash;
  const connectionToken = created.session.connection_token;
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
  let cleanupError = null;
  const pending = [];
  let wake;
  const wsUrl = learningUrl.replace(/^http/, 'ws') + created.session.websocket_path + `?token=${encodeURIComponent(connectionToken)}`;
  const socket = new WebSocket(wsUrl);
  socket.onmessage = event => { pending.push(JSON.parse(event.data)); wake?.(); };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const nextMessage = async () => {
    while (!pending.length) await new Promise(resolve => { wake = resolve; });
    wake = null;
    return pending.shift();
  };
  await page.goto(internalKibana.toString(), {waitUntil: 'domcontentloaded'});
  try {
    while (true) {
      const message = await nextMessage();
      if (message.message_type !== 'command') continue;
      if (message.type === 'request_diagnosis' || message.type === 'request_answer' || message.type === 'show_debrief') {
        const answer = message.type === 'show_debrief'
          ? {
              ...(message.value.answer || message.value.diagnosis),
              evidence: message.value.evidence,
            }
          : {service: 'payments', fault_type: 'latency', affected_route: '/checkout', trace_id: traceId, evidence: 'The payment transaction dominates the correlated checkout trace.'};
        const feedback = await jsonRequest(`${learningUrl}/api/sessions/${created.session.session_id}/answer`, {method: 'POST', headers: {Authorization: `Bearer ${connectionToken}`}, body: JSON.stringify(answer)});
        if (!feedback.diagnosis_correct) throw new Error(`Reference diagnosis was rejected: ${JSON.stringify(feedback.components)}`);
        score = feedback.total;
        break;
      }
      const result = await perform(page, message);
      if (result?.details?.trace_id) traceId = result.details.trace_id;
      actionSequence += 1;
      socket.send(JSON.stringify({message_type: 'action', action: {protocol_version: 2, run_id: created.run.run_id, session_id: created.session.session_id, sequence: actionSequence, type: result.type, actor: 'tutorial', observed_at: new Date().toISOString(), details: result.details || {}, state_before: {}, state_after: result.state_after || {}}}));
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
    let cleanup = {attempted: true, completed: false};
    try {
      const result = await jsonRequest(`${learningUrl}/api/runs/${created.run.run_id}`, {method: 'DELETE'});
      cleanup = {attempted: true, completed: Boolean(result.aborted)};
    } catch (error) {
      cleanupError = error;
      cleanup = {attempted: true, completed: false, error: error.message};
      outcome = 'failed';
    }
    const metadata = {schema_version: 2, run_id: created.run.run_id, scenario, seed, playbook: 'scenario-pack-v2', kibana_version: '9.5.2', playwright_version: '1.62.1', viewport, locale: 'en-GB', timezone: 'UTC', reduced_motion: true, started_at: startedAt, completed_at: new Date().toISOString(), outcome, score, cleanup, artifacts: snapshots};
    await writeFile(path.join(outputDir, `${created.run.run_id}.json`), JSON.stringify(metadata, null, 2));
    if (cleanupError) throw cleanupError;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
