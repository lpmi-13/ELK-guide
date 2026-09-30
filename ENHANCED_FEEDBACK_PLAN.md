# Enhanced Feedback Plan — Guided Mode

Teaches from mistakes in **Guided** mode without hovering over the learner. The coach should:

1. **React immediately** when an action leaves the investigation unable to answer the current step.
   Example: a query that returns nothing.
2. **Stay quiet** while the learner explores, even when they wander away from the expected path.
3. **Check in gently** when a step is taking a long time. At that point it can mention any wandering
   it noticed.

Builds on the dead-end recovery shipped on 2026-09-29, where `result_count` gates step acceptance,
`restore_state` rebuilds the search, and the orange recovery card undoes the bad input. This plan
replaces that card's generic wording with a specific diagnosis, and adds the drift log and a
per-step clock.

## Decisions

| Question | Decision |
|---|---|
| Should drift ever interrupt? | **No.** Drift is recorded silently and **only mentioned at a check-in**, never immediately. That includes several drift actions in a row. |
| Do check-ins cost points? | **No, never.** Answering a check-in has no effect on the score. **Hint** and **Show me** keep their existing costs when chosen from the check-in card, exactly as from the panel. |
| How are time budgets set? | **Flat defaults per action type**, which a playbook can override. Budgets do not scale with scenario difficulty. **No step's budget is ever below 45s**, including overrides and later updates from recorded data. |
| Which modes are covered? | **Guided only.** Challenge mode gets no clock and no live feedback. Its dead ends and drift appear in the debrief. Demonstrations are coach-driven and need none of this. |
| Is there a visible countdown? | **No.** The clock is never shown to the learner. |

---

## 1. Classify actions by their effect, not by what was clicked

Clicks are ambiguous: a learner opening an unrelated field may just be orienting. Only changes to the
**query, filter pills or time window** can take the investigation off course. Every other interaction
counts as exploration.

| Bucket | Meaning | Examples | Coach response |
|---|---|---|---|
| **Progress** | The step's accepts matched | The step is accepted (today's `accepted` outcome) | Celebrate, as today |
| **Dead end** | The view can no longer answer the step | Zero results. An earned filter or time window was removed. The window no longer includes when the incident was noticed. | **Immediate** diagnosis, then **Fix my query** or restore |
| **Drift** | A plausible move away from what the step needs | Filtering on `500` when `503` spiked. Opening `service.name` during the status-code step. A filter on a different service. | **Recorded silently**, surfaced only at a check-in |
| **Neutral** | Exploration | Popovers, scrolling, sorting, expanding rows, reading other fields | Ignored |

### Evaluator outcomes

`evaluate_action` (`learning-service/engine/evaluator.py`) gains two outcomes alongside `accepted`,
`observed` and `empty_result`:

- **`dead_end`** with a `reason_code`. It replaces `empty_result`; existing listeners are updated to
  handle both during the transition.
- **`drift`** with a `note`.

Neither outcome can progress a goal.

### Dead-end detection (engine-wide, no per-scenario work)

| `reason_code` | Rule |
|---|---|
| `empty_result` | Exists today (`state_after.result_count == 0`) |
| `lost_earned_state` | The search no longer contains a filter or time window that `restore_state` says a completed step earned. Compare the action's `state_after.filters` and time window against `restore_state`. |
| `window_excludes_incident` | A time change whose look-back ends before `incident_offset_minutes`. This reuses the tolerance logic in `validate_time_range`. It is only checked after `scope` is complete; before that, the scope step itself handles it. |

### Diagnosing queries (browser side; first slice covers the top three)

Verified 2026-09-30 against Kibana 9.5.2 by capturing the Elasticsearch request:

- `http.response.status_code is 503` and `… = 503` are sent as one free-text `multi_match` across
  all fields, and return 0 hits.
- A bare `503` is also free text, but returns the right documents **by luck**.

| Kind | Detection | Message | Action |
|---|---|---|---|
| `missing_colon` | A known field name followed by `is` / `=` / `==` / `equals` and a value, with no `:` | "Kibana searched every field for the text ‘…’. KQL links a field to a value with a colon." | **Fix my query** fills in `field: value` *without running it*; the learner presses Enter |
| `unknown_field` | The token before `:` is not a field in the sidebar's field list | "No field named `x` in this data view. Did you mean `y`?" (closest field by edit distance) | **Fix my query** |
| `value_absent` | The field is valid, but there are 0 hits for that value | "No `field` values of ‘v’ in this window. Check the field's Top values." | Opens the field popover |
| `free_text_luck` | A bare value, results > 0 | Shown as a **note on the success card**, not as a dead end: "This worked, but it searches every field for 503. Naming the field says what you mean." | — |

This lives in a `QueryExplainer` helper in `kibana-coach/src/kibana-adapter.js`, a pure function over
the query text and the field list, so it is unit-testable. When the coach can diagnose the mistake,
the recovery card shows the diagnosis and **Fix my query** alongside **Reset search**. When it
can't, the card keeps today's generic wording and restore.

### Drift rules (per step, in the playbook)

Declared next to `accepts`, with the same action/validator shape:

```json
"drifts": [
  {"action": ["filter_added"],
   "validators": [{"kind": "filter_field", "field": "${var.status_field}"},
                  {"kind": "value_not", "value": "${param.incident.status}"}],
   "note": "You filtered on a status code, but not the one that stood out in the top values."},
  {"action": ["field_statistics_opened"],
   "validators": [{"kind": "detail_not", "field": "field", "value": "${var.status_field}"}],
   "note": "You opened ${action.field}; this step is about the status codes."}
]
```

- Two new validators: `value_not` and `detail_not`. `filter_field` matches on the field regardless of
  value.
- `note` is substituted using the action's details, so `${action.field}` becomes the field the
  learner opened.
- The server keeps a per-step **drift log** (`session["drift"][step_id]`: an ordered list of notes,
  de-duplicated). It is cleared when the step completes.
- The schema (`learning/schemas/playbook.schema.json`) gains an optional `drifts` array.
- Contract tests check that each drift's validators exist.
- A step with no `drifts` still gets the check-in; the card just omits the drift line.

---

## 2. The step clock

It runs in the browser (`content-script.js`), because only the page knows whether the learner is
actually active.

- **Budget (flat defaults by reference command):**

  | Command | Budget |
  |---|---|
  | `set_time_range` | 45s |
  | `open_field_statistics` / `inspect_field` | 45s |
  | `add_filter` / `enter_kql` | 60s |
  | `expand_document` | 45s |
  | anything else | 45s |

  **45s is the minimum budget for every step.** A playbook may override a step with
  `"pace": {"expected_seconds": N}`, but the server raises any value below 45 to 45
  (`max(45, N)`), and contract tests reject an override under 45. The server sends the resolved
  budget on each guided command as `command.pace_seconds`.
- **Counts active time only.** The clock pauses while:
  - the tab is hidden (`visibilitychange`)
  - the briefing or Incident info is open
  - a Show me walkthrough is playing
  - the recovery card is up
  - a success celebration is showing
- **Resets only when the step changes.** Exploration doesn't reset it; otherwise a learner clicking
  around would never reach a check-in.
- **Waits for a quiet moment before interrupting.** When the budget runs out, the check-in waits
  until the learner has been idle for 5s (no pointer or key input), no Kibana popover is open, and
  the query bar isn't focused.
- **Backs off.** After **Keep going**, the next check-in comes after 1.5× the budget. After two
  **Keep going** answers on a step, there are no more check-ins for that step.

## 3. The check-in

The browser sends `{message_type: "check_in", step_id}`. The server replies with:

```json
{"message_type": "check_in", "step_id": "isolate", "step_title": "Filter to the failing status code",
 "drift": ["You filtered on a status code, but not the one that stood out in the top values."]}
```

The coach panel shows a soft card. It is not a modal and does not dim the page. It reuses the stage
card with a new neutral-teal `checkin` accent.

> **Still working on “Filter to the failing status code”?**
> So far you've filtered on 500. The top values showed a different code standing out.
> **[Keep going]** **[Give me a hint]** **[Show me]**

- The drift line shows the **most recent** note only. If there is no drift, the line is omitted.
- **Keep going** closes the card and applies the back-off.
- **Give me a hint** and **Show me** call the existing `revealHint` / `onDemonstrate`, with their
  existing assistance accounting.
- **No score effect.** The browser sends `{type: "check_in_answered", details: {step_id, choice}}`.
  `check_in_answered` is added to `IGNORED_ACTIONS`, so it never counts toward relevance, efficiency
  or help counts.

## 4. Recording and debrief

- Per step, the server records `seconds_active` (sent by the browser at step completion), the
  check-ins shown and their answers, the dead ends by `reason_code`, and the drift notes.
- The guided debrief's step-by-step rows gain a small, unscored detail line, such as "needed a
  check-in" or "recovered from a dead end: missing colon". The score is unchanged.
- In challenge mode, the same dead-end and drift data is collected silently and shown in its debrief
  as "detours". There is no clock.
- The recorded `seconds_active` per step is what later moves the flat defaults, set from roughly the
  75th percentile. Budgets remain flat defaults, never below 45s; this only updates the numbers.

---

## Implementation order

1. **Query diagnosis.** Add `QueryExplainer` and its unit tests. Wire the diagnosis into the recovery
   card, add **Fix my query**, and add the `free_text_luck` note on the success card.
2. **Step clock and check-in (no drift yet).** Send `pace_seconds` on commands. Add the clock with
   its pause, idle and back-off rules; the check-in message and card; and `check_in_answered` in
   `IGNORED_ACTIONS`.
3. **Engine-wide dead ends.** Add the `dead_end` outcome with `lost_earned_state` and
   `window_excludes_incident`, and move `empty_result` under it.
4. **Drift.** Add the schema field, the new validators, the drift log and the check-in drift line.
   Author `drifts` for `discover-time-window` first, then the other MVP Discover packs.
5. **Debrief and recording.** Add per-step timing, check-in and detour lines, plus the challenge-mode
   detours.

Each phase is deployable on its own (see the coach UI live-edit and learning-service rebuild notes).

## Testing

- **Unit (node).**
  - `QueryExplainer` cases: every row of the table, plus inputs that must stay silent (`field: value`,
    `field >= 500`, `not field: v`).
  - Clock state machine on the injectable fake clock used by `demo-pause.test.mjs`: pause/resume,
    idle deferral, and the 1.5× back-off with the two-decline cap.
- **Unit (Python).**
  - Each dead-end `reason_code`.
  - Drift validators and log de-duplication.
  - The check-in reply shape.
  - `check_in_answered` leaves the guided score unchanged.
- **End to end** (the Playwright harness from 2026-09-29): drive `discover-time-window` in guided
  mode.
  - Idle past the budget → check-in appears; **Keep going** → no second card before 1.5×.
  - Add a `500` filter, then idle → the check-in names it.
  - Type `status_code is 503` → immediate `missing_colon` card; **Fix my query** fills the bar
    without running it.
  - Remove the earned `503` pill mid-step 4 → `lost_earned_state` restore.

## Out of scope (for now)

- Linting the query while it's being typed. Kibana's autocomplete already occupies that space.
- Showing learners the raw Elasticsearch request ("How Kibana read this"). It needs the coach to
  intercept Kibana's network requests; revisit once the explainer has been tried out.
- Comparing result counts with the expected counts, e.g. "you got 110, the failing set is ~30". This
  needs a server-side count per step for the reference state and is a natural follow-on to drift.
- Budgets that scale with difficulty. The decision is flat defaults.
