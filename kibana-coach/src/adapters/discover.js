globalThis.KibanaApplicationAdapters ||= [];

// Escape a field name for use inside a [data-test-subj='...'] selector.
function cssEscape(value) {
  return String(value).replace(/['\\]/g, '\\$&');
}

// Poll for a field-scoped selector the registry does not hold. Accepts one selector or an ordered
// list, and returns the first that resolves, trying them in PRIORITY order every poll — unlike a
// comma-joined querySelector, which returns whichever match comes first in DOCUMENT order. That
// distinction is decisive for the field list: the `field-<field>-showDetails` "Preview" button that
// opens the Top values popover is nested inside `dscFieldListPanelField-<field>`, a plain draggable
// wrapper whose own click opens nothing. A single combined selector would match the wrapper first
// (it is the ancestor), so the demonstration would click dead space; listing the button first fixes it.
async function waitForSelector(selectors, timeout, signal) {
  const list = Array.isArray(selectors) ? selectors : [selectors];
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException('Demonstration stopped', 'AbortError');
    for (const selector of list) {
      const element = document.querySelector(selector);
      if (element && element.getClientRects().length) return element;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Kibana target not found: ${list.join(', ')}`);
}

globalThis.KibanaApplicationAdapters.push({
  name: 'discover',
  commands: new Set(['select_data_view', 'enter_kql', 'switch_query_language', 'enter_esql', 'edit_filter', 'remove_filter', 'disable_filter', 'add_column', 'remove_column', 'sort_column', 'expand_document', 'inspect_field', 'open_field_statistics', 'open_surrounding_documents',
    'filter_top_value', 'set_filter_inclusion', 'filter_field_present', 'show_field_statistics']),

  // Discover's Field statistics view is showing instead of the documents (verified 9.5.2: the
  // `dscViewModeFieldStatsButton` / `dscViewModeDocumentButton` toggle; the view draws a
  // `dataVisualizerTableContainer`).
  fieldStatisticsShown() {
    const table = document.querySelector("[data-test-subj='dataVisualizerTableContainer']");
    return Boolean(table && table.getClientRects().length);
  },

  // Field statistics: one row per field with its documents and its count of distinct values (its
  // cardinality), for the records the search keeps.
  async showFieldStatistics(command, host, coach, timingScale, signal) {
    const result = {type: 'field_statistics_opened', details: {view: 'field_statistics'}, state_after: {}};
    if (!this.fieldStatisticsShown()) {
      const tab = await waitForSelector("[data-test-subj='dscViewModeFieldStatsButton']", 20000, signal);
      await host.pointAt(tab, coach, timingScale, signal, 'Switch from Documents to Field statistics, above the results.', {activate: true});
    }
    await waitForSelector("[data-test-subj='dataVisualizerTable-loaded']", 15000, signal);
    return result;
  },

  // Back to the documents from Field statistics, so a result row can be opened.
  async showDocuments(host, coach, timingScale, signal) {
    if (!this.fieldStatisticsShown()) return;
    const tab = await waitForSelector("[data-test-subj='dscViewModeDocumentButton']", 8000, signal);
    await host.pointAt(tab, coach, timingScale, signal, 'Switch back to Documents.', {activate: true, hold: false});
    await host.waitFor('kibana.first_result', 15000, signal);
  },

  // Open the documents just before and after the open event (verified 9.5.2: the document's
  // `docTableRowAction` "View surrounding documents" leads to Discover's context view, which lists the
  // events around it in time with the anchor marked by `docTableExpandToggleColumnAnchor`; the
  // search's filters come along disabled, so every neighbouring event shows). Then open the event
  // logged just before it.
  async openSurroundingDocuments(command, host, coach, timingScale, signal) {
    if (!host.resolve('kibana.doc_viewer')) {
      await this.showDocuments(host, coach, timingScale, signal);
      const first = await host.waitFor('kibana.first_result', 20000, signal);
      await host.pointAt(first, coach, timingScale, signal, 'Expand the first result.', {activate: true, hold: false});
      await host.waitFor('kibana.doc_viewer', 10000, signal);
    }
    const action = () => [...document.querySelectorAll("[data-test-subj='docViewerFlyout'] [data-test-subj='docTableRowAction']")]
      .find(node => /surrounding/i.test(node.getAttribute('aria-label') || node.textContent || ''));
    const deadline = Date.now() + 8000;
    while (!action() && Date.now() < deadline) await host.wait(100, signal);
    if (!action()) throw new Error('This document has no “View surrounding documents” action. Try this step again.');
    await host.pointAt(action(), coach, timingScale, signal, 'Click “View surrounding documents”, among the Actions at the top of the document.', {activate: true, hold: false});
    await waitForSelector("[data-test-subj='docTableExpandToggleColumnAnchor']", 20000, signal);
    await host.resultsSettled(signal);
    // The grid can draw the anchor before its cells are placed and then redraw it, so read the anchor's
    // row afresh until it has one.
    const anchorAt = () => {
      const cell = document.querySelector("[data-test-subj='docTableExpandToggleColumnAnchor']")?.closest('[data-gridcell-row-index]');
      return cell ? Number(cell.getAttribute('data-gridcell-row-index')) : NaN;
    };
    const placed = Date.now() + 8000;
    while (Number.isNaN(anchorAt()) && Date.now() < placed) await host.wait(100, signal);
    const anchorRow = anchorAt();
    if (Number.isNaN(anchorRow)) throw new Error('The surrounding documents did not load. Try this step again.');
    const anchor = document.querySelector("[data-test-subj='docTableExpandToggleColumnAnchor']");
    // A grid row has no box of its own (verified 9.5.2: its cells are placed one by one), so point at the
    // anchor's time cell.
    const anchorTime = document.querySelector(`[data-gridcell-row-index='${anchorRow}'][data-gridcell-column-id='@timestamp']`);
    await host.pointAt(anchorTime || anchor, coach, timingScale, signal,
      'The highlighted row is the error we opened. Newer events are above it and older ones below. The error.type filter came along switched off, so every event shows, not just errors.', {showClick: false});
    const before = await waitForSelector(`[data-gridcell-row-index='${anchorRow + 1}'] [data-test-subj='docTableExpandToggleColumn']`, 8000, signal);
    await host.pointAt(before, coach, timingScale, signal, 'Open the event logged just before it.', {activate: true});
    await host.waitFor('kibana.doc_viewer', 10000, signal);
    const focus = command.evidence_focus || command.walkthrough?.evidence_focus;
    if (focus?.kind === 'document' && focus.fields?.length) await host.pinFieldsVisibly(focus.fields, coach, timingScale, signal);
    return {type: 'surrounding_documents_opened', details: {anchor_row: anchorRow}, state_after: {}};
  },

  // A field's popover from the sidebar, opened unless it already is (verified 9.5.2: the field row's
  // `field-<field>-showDetails` button; the open popover names the field in
  // `fieldPopoverHeader_fieldDisplayName`, and closes once one of its filters is applied).
  async openFieldPopover(field, host, coach, timingScale, signal, activity) {
    const open = () => [...document.querySelectorAll('[data-popover-panel]')].find(panel => panel.getClientRects().length
      && panel.querySelector("[data-test-subj='fieldPopoverHeader_fieldDisplayName']")?.textContent?.trim() === field);
    if (open()) return open();
    const escaped = cssEscape(field);
    const button = await waitForSelector([`[data-test-subj='field-${escaped}-showDetails']`, `[data-test-subj='dscFieldListPanelField-${escaped}'] button`], 20000, signal);
    await host.pointAt(button, coach, timingScale, signal, activity, {activate: true, hold: false, targetName: null});
    const deadline = Date.now() + 5000;
    while (!open() && Date.now() < deadline) await host.wait(100, signal);
    if (!open()) throw new Error(`The ${field} field did not open. Try this step again.`);
    return open();
  },

  // Filter for (+) or out (−) one of a field's Top values (verified 9.5.2: each bucket's
  // `plus-<field>-<value>` / `minus-<field>-<value>` button, "Filter for" / "Filter out").
  async filterTopValue(command, host, coach, timingScale, signal) {
    const {field, value} = command.value || {};
    const negate = command.value?.negate === true;
    const popover = await this.openFieldPopover(field, host, coach, timingScale, signal, `Open ${field} in the field list to see its Top values.`);
    const bucket = () => [...popover.querySelectorAll("[data-test-subj='dscFieldStats-topValues-bucket']")]
      .find(node => node.querySelector("[data-test-subj='dscFieldStats-topValues-formattedFieldValue']")?.textContent?.trim() === String(value));
    const deadline = Date.now() + 8000;
    while (!bucket() && Date.now() < deadline) await host.wait(100, signal);
    const button = bucket()?.querySelector(`[data-test-subj^='${negate ? 'minus' : 'plus'}-']`);
    if (!button) throw new Error(`${value} is not among ${field}'s Top values. Try this step again.`);
    await host.pointAt(button, coach, timingScale, signal, negate
      ? `Click the − beside ${value} to filter it out.`
      : `Click the + beside ${value} to filter for it.`, {activate: true});
    await host.settle(400, timingScale, signal);
    return {type: 'filter_added', details: {field, value, negate}, state_after: {}};
  },

  // Turn a filter pill between keeping and leaving out its value (verified 9.5.2: a click on the pill
  // opens its menu, where `negateFilter` reads "Exclude results" on an including pill and "Include
  // results" on an excluding one; the pill keeps its place and reads "NOT …" while it excludes).
  async setFilterInclusion(command, host, coach, timingScale, signal) {
    const {field, value} = command.value || {};
    const include = command.value?.include !== false;
    const result = {type: 'filter_changed', details: {field, value, negate: !include}, state_after: {}};
    let pill = null;
    const deadline = Date.now() + 8000;
    while (!(pill = host.findFilterPill(field, value)) && Date.now() < deadline) await host.wait(100, signal);
    if (!pill) throw new Error(`There is no ${field} filter to change. Try this step again.`);
    const excluding = /(^|\s)filter-negated(\s|$)/.test(pill.getAttribute('data-test-subj') || '');
    if (excluding !== include) {
      await host.pointAt(pill, coach, timingScale, signal, `The filter already ${include ? 'keeps' : 'leaves out'} ${value}, so there's nothing to change here.`, {showClick: false});
      return result;
    }
    await host.pointAt(pill, coach, timingScale, signal, `Click the ${field} pill to open its menu.`, {activate: true, hold: false});
    const option = await waitForSelector("[data-popover-panel] [data-test-subj='negateFilter']", 5000, signal);
    await host.pointAt(option, coach, timingScale, signal, `Choose “${option.textContent.trim() || (include ? 'Include results' : 'Exclude results')}”.`, {activate: true});
    await host.settle(400, timingScale, signal);
    return result;
  },

  // Keep only the records that carry a field (verified 9.5.2: the field popover's header button
  // `discoverFieldListPanelAddExistFilter-<field>`, "Filter for field present", adds "<field>: exists").
  async filterFieldPresent(command, host, coach, timingScale, signal) {
    const field = command.value?.field;
    await this.openFieldPopover(field, host, coach, timingScale, signal, `Open ${field} in the field list.`);
    const button = await waitForSelector(`[data-popover-panel] [data-test-subj='discoverFieldListPanelAddExistFilter-${cssEscape(field)}']`, 8000, signal);
    await host.pointAt(button, coach, timingScale, signal, `Click “Filter for field present”, the filter icon at the top of the ${field} popover.`, {activate: true});
    await host.settle(400, timingScale, signal);
    return {type: 'filter_added', details: {field, value: 'exists', type: 'exists', negate: false}, state_after: {}};
  },

  // Sort the table by one column from its header's menu (verified 9.5.2: the menu button
  // `dataGridHeaderCellActionButton-<field>` shows on hover, and a date column offers "Sort Old-New"
  // and "Sort New-Old"; numbers read Low-High, text A-Z). The URL's `_a` state then holds the sort.
  async sortColumn(command, host, coach, timingScale, signal) {
    const field = command.value?.field || '@timestamp';
    const direction = command.value?.direction === 'desc' ? 'desc' : 'asc';
    const result = {type: 'sort_changed', details: {field, direction}, state_after: {sort: [[field, direction]]}};
    const escaped = cssEscape(field);
    const header = await waitForSelector(`[data-test-subj='dataGridHeaderCell-${escaped}']`, 20000, signal);
    const current = decodeURIComponent(location.href).match(/sort:!\(!\(([^,]+),(asc|desc)\)/);
    if (current && current[1].replace(/^['"]|['"]$/g, '') === field && current[2] === direction) {
      await host.pointAt(header, coach, timingScale, signal, `The table is already sorted by ${field}, so there's nothing to change here.`, {showClick: false});
      return result;
    }
    const order = direction === 'asc' ? /^Sort (Old-New|Low-High|A-Z)$/i : /^Sort (New-Old|High-Low|Z-A)$/i;
    const option = () => [...document.querySelectorAll('button')].find(node => order.test(node.textContent.trim()) && node.getClientRects().length);
    await host.pointAt(header, coach, timingScale, signal, `Open the ${field} column's menu.`, {hold: false});
    header.querySelector(`[data-test-subj='dataGridHeaderCellActionButton-${escaped}']`)?.click();
    const deadline = Date.now() + 3000;
    while (!option() && Date.now() < deadline) await host.wait(100, signal);
    if (!option()) throw new Error(`The ${field} column menu did not open. Try this step again.`);
    await host.pointAt(option(), coach, timingScale, signal, `Choose “${option().textContent.trim()}”.`, {activate: true});
    return result;
  },

  // The expand toggle on the first result from `service` (verified 9.5.2: grid cells carry their column
  // and row index, and the row's toggle sits beside them). Null when no such row is on the page.
  expandToggleFor(service) {
    const cell = [...document.querySelectorAll("[data-gridcell-column-id='service.name']")].find(node => node.textContent.includes(service));
    const row = cell?.getAttribute('data-gridcell-row-index');
    return row == null ? null : document.querySelector(`[data-gridcell-row-index='${row}'] [data-test-subj='docTableExpandToggleColumn']`);
  },

  // What a step's opening card points at: the field or result row it is about, not the whole field list.
  async anchor(command, host, signal) {
    if (command.type === 'expand_document' && command.value?.service) return this.expandToggleFor(command.value.service);
    if (command.type === 'inspect_field' && command.target === 'kibana.esql_first_result') {
      return host.waitForNaming('kibana.esql_first_result', command.value?.value, signal);
    }
    if (command.type === 'set_filter_inclusion') return host.findFilterPill(command.value?.field, command.value?.value);
    if (command.type === 'show_field_statistics') return waitForSelector("[data-test-subj='dscViewModeFieldStatsButton']", 8000, signal);
    if (command.type === 'expand_document' && this.fieldStatisticsShown()) return waitForSelector("[data-test-subj='dscViewModeDocumentButton']", 8000, signal);
    if (command.type === 'open_surrounding_documents' && host.resolve('kibana.doc_viewer')) {
      return [...document.querySelectorAll("[data-test-subj='docViewerFlyout'] [data-test-subj='docTableRowAction']")]
        .find(node => /surrounding/i.test(node.getAttribute('aria-label') || node.textContent || '')) || null;
    }
    if (['filter_top_value', 'filter_field_present'].includes(command.type) && command.value?.field) {
      const escaped = cssEscape(command.value.field);
      return waitForSelector([`[data-test-subj='field-${escaped}-showDetails']`, `[data-test-subj='dscFieldListPanelField-${escaped}']`], 8000, signal);
    }
    if (command.type === 'sort_column') return waitForSelector(`[data-test-subj='dataGridHeaderCell-${cssEscape(command.value?.field || '@timestamp')}']`, 8000, signal);
    if (['open_field_statistics', 'inspect_field', 'add_column', 'remove_column'].includes(command.type) && command.value?.field) {
      const escaped = cssEscape(command.value.field);
      return waitForSelector([`[data-test-subj='field-${escaped}-showDetails']`, `[data-test-subj='dscFieldListPanelField-${escaped}']`], 8000, signal);
    }
    return null;
  },

  async perform(command, host, coach, {timingScale = 1, signal} = {}) {
    if (command.type === 'enter_esql' && document.querySelector("[data-test-subj='ESQLEditor'] .monaco-editor")) {
      const value = typeof command.value === 'string' ? command.value : command.value?.query || '';
      const editor = await waitForSelector("[data-test-subj='ESQLEditor']", 20000, signal);
      // Write the pipeline in the editor and run it, as a learner does. Only if the editor won't take the
      // text is the query applied through Discover's URL state instead.
      await host.pointAt(editor, coach, timingScale, signal, 'Write the ES|QL pipeline here.', {activate: true, hold: false});
      const written = await host.typeIntoMonaco(editor, value, signal);
      const run = written && host.resolve('kibana.query_submit');
      if (run) {
        coach?.clearActionTarget?.();
        await host.pointAt(run, coach, timingScale, signal, 'Run the query.', {activate: true, targetName: 'kibana.query_submit'});
      } else if (!host.runEsql(value)) {
        throw new Error('Discover could not take the ES|QL query. Try this step again.');
      }
      await host.wait(2500, signal);
      // The editor keeps its focus through the URL change, and with it an autocomplete list over the page.
      const typed = document.activeElement;
      if (editor.contains(typed)) typed.blur();
      return {type: 'esql_submitted', details: {query: value, language: 'esql'}, state_after: {query: value, query_language: 'esql'}};
    }
    if (command.type === 'enter_kql' || command.type === 'enter_esql') {
      const value = typeof command.value === 'string' ? command.value : command.value?.query || '';
      const input = await host.waitFor(command.type === 'enter_esql' ? 'kibana.esql_editor' : 'kibana.query_bar', 20000, signal);
      await host.enterQuery(value, coach, timingScale, signal, input);
      return {type: command.type === 'enter_esql' ? 'esql_submitted' : 'query_submitted', details: {query: value, language: command.type === 'enter_esql' ? 'esql' : 'kql'}, state_after: {query: value, query_language: command.type === 'enter_esql' ? 'esql' : 'kql'}};
    }
    // A grouped ES|QL result is read, not opened: each row states its group and its calculated values
    // (verified 9.5.2: a `<id>-row-header` reading "/api/orders/confirm total: 45 failures: 42"), while a
    // field's Top values would only repeat the group names.
    if (command.type === 'inspect_field' && command.target === 'kibana.esql_first_result') {
      const row = await host.waitForNaming('kibana.esql_first_result', command.value?.value, signal, 8000)
        || await host.waitFor('kibana.esql_first_result', 8000, signal);
      await host.pointAt(row, coach, timingScale, signal, 'Read this row’s values together.', {showClick: false});
      return {type: 'field_inspected', details: {...command.value}, state_after: {...command.value}};
    }
    if (command.type === 'sort_column') return this.sortColumn(command, host, coach, timingScale, signal);
    if (command.type === 'filter_top_value') return this.filterTopValue(command, host, coach, timingScale, signal);
    if (command.type === 'set_filter_inclusion') return this.setFilterInclusion(command, host, coach, timingScale, signal);
    if (command.type === 'filter_field_present') return this.filterFieldPresent(command, host, coach, timingScale, signal);
    if (command.type === 'show_field_statistics') return this.showFieldStatistics(command, host, coach, timingScale, signal);
    if (command.type === 'open_surrounding_documents') return this.openSurroundingDocuments(command, host, coach, timingScale, signal);
    if (command.type === 'expand_document') await this.showDocuments(host, coach, timingScale, signal);
    // Column add/remove drives the verified 9.5.2 field-list toggle `fieldToggle-<field>`
    // (its aria-label flips between "Add field as column" and "Remove field from table").
    // The field name comes from the command; fall back to the registry target otherwise.
    if (command.type === 'add_column' || command.type === 'remove_column') {
      const field = command.value?.field;
      const toggle = field ? await waitForSelector(`[data-test-subj='fieldToggle-${cssEscape(field)}']`, 20000, signal) : null;
      const target = toggle || await host.waitFor(command.target, 20000, signal);
      const verb = command.type === 'add_column' ? 'Add' : 'Remove';
      // The caption names the move itself; the goal card already gave the reason for it.
      await host.pointAt(target, coach, timingScale, signal, `${verb} the ${field || 'selected'} column from the field list.`, {activate: true});
      const type = command.type === 'add_column' ? 'column_added' : 'column_removed';
      return {type, details: {...(command.value || {})}, state_after: command.value || {}};
    }
    // Opening a specific field's preview popover (its Top values / distribution). The field name
    // comes from the command so the coach can survey http.response.status_code or url.path directly.
    // The verified 9.5.2 trigger is the field row's "Preview" button `field-<field>-showDetails`; its
    // wrapper `dscFieldListPanelField-<field>` is a draggable DIV whose click opens nothing, so we
    // resolve the button first and only fall back to the wrapper's button, then the wrapper itself.
    if ((command.type === 'open_field_statistics' || command.type === 'inspect_field') && command.value?.field) {
      const field = command.value.field;
      const escaped = cssEscape(field);
      const target = await waitForSelector([
        `[data-test-subj='field-${escaped}-showDetails']`,
        `[data-test-subj='dscFieldListPanelField-${escaped}'] button`,
        `[data-test-subj='dscFieldListPanelField-${escaped}']`,
      ], 20000, signal);
      await host.pointAt(target, coach, timingScale, signal, `Open the ${field} field to read its Top values.`, {activate: true});
      const type = command.type === 'open_field_statistics' ? 'field_statistics_opened' : 'field_inspected';
      return {type, details: {...command.value}, state_after: {...command.value}};
    }
    const fallback = await host.waitFor(command.target, 20000, signal);
    const target = (command.type === 'expand_document' && command.value?.service && this.expandToggleFor(command.value.service)) || fallback;
    const focus = command.evidence_focus || command.walkthrough?.evidence_focus;
    const compared = command.type === 'expand_document' && focus?.kind === 'document' ? focus.fields || [] : [];
    const activity = command.type !== 'expand_document' ? command.narration || 'Use the highlighted Discover control.'
      : `Expand ${command.value?.service ? `this ${command.value.service} result` : 'the first result'} to read all of its fields${compared.length ? ' in the document panel on the right' : ''}.`;
    await host.pointAt(target, coach, timingScale, signal, activity, {activate: true});
    // Report the step only once the document is actually open, so a click that opened nothing is
    // never recorded (and debriefed) as a checked event.
    if (command.type === 'expand_document') {
      await host.waitFor('kibana.doc_viewer', 8000, signal).catch(error => {
        if (error.name === 'AbortError') throw error;
        throw new Error('The document did not open. Try expanding the first result again.');
      });
      // Pin the fields to compare, as a learner would, so they sit side by side at the top.
      if (compared.length) await host.pinFieldsVisibly(compared, coach, timingScale, signal);
    }
    const observations = {
      select_data_view: 'data_view_selected', switch_query_language: 'query_language_changed', edit_filter: 'filter_changed', remove_filter: 'filter_removed', disable_filter: 'filter_disabled',
      add_column: 'column_added', remove_column: 'column_removed', sort_column: 'sort_changed', expand_document: 'document_expanded', inspect_field: 'field_inspected',
      open_field_statistics: 'field_statistics_opened', open_surrounding_documents: 'surrounding_documents_opened'
    };
    const details = {...(command.value || {})};
    if (command.type === 'switch_query_language') details.language ||= 'esql';
    return {type: observations[command.type], details, state_after: command.value || {}};
  }
});
