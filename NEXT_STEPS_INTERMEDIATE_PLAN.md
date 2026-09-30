# NEXT STEPS — Intermediate Plan

Bridges the shipped MVP work and the retained long-term lab. Narrower than
[`FULL_SCENARIO_PLAN.md`](FULL_SCENARIO_PLAN.md) (deferred, whole multi-surface
catalog), broader than "two hard-coded scenarios." Assumes the reduced MVP scope
in [`PLAN.md`](PLAN.md): **one pattern — a randomized Discover application-error
log-hunt (`scope → isolate → inspect → submit`), in Demonstration / Guided / Solo
modes.**

Two workstreams:

1. Make the interactive **"second bucket"** methods (pill-based filter-out,
   remove/add column, auto-refresh) real in **Guided and Solo** modes.
2. Give Guided/Solo **≥5 randomized scenario variants** that all flex the one MVP
   pattern (today only 2 are randomized), and prune the MVP listing to the
   scenarios that actually belong to it.

---

## Part 1 — Make the "second bucket" real in Guided/Solo

### Why it isn't real yet

The scoring **contract already has the whole vocabulary** — no schema work is
needed. `learning/schemas/command.schema.json` and `action.schema.json` already
define `set_auto_refresh`/`auto_refresh_changed`, `remove_column`/`column_removed`,
`edit_filter`/`filter_changed`, `remove_filter`/`filter_removed`,
`disable_filter`/`filter_disabled`; `learning-service/engine/evaluator.py` already
implements `filter_contains` (with a `negate` flag), `filter_excludes`, and matches
`column_removed`. KQL-based flows (including filter-out via `not`) work end-to-end
today.

What's missing is the **browser layer** that connects a real Kibana UI action to
that vocabulary. Guided/Solo = *the learner performs the action and the coach
observes it*, so the critical path is the **observer**; the demonstrate-one-step
("Show me") affordance inside Guided additionally needs the **adapter + selectors**.

Three concrete gaps, all in `kibana-coach/`:

- **Selector registry** — `kibana-coach/selectors/kibana-9.5.json` (loaded at
  runtime via `fetch` in `kibana-coach/src/kibana-adapter.js`; mirror
  `learning/selectors/kibana-9.5.json`) defines targets for only the query bar,
  time picker, and first-result expand. There are **no targets** for filter pills,
  the field list / column toggles, or the auto-refresh control. (The deferred
  `deployment-version-regression` demo even points at a nonexistent
  `kibana.field_list`.)
- **Observer** — `kibana-coach/src/action-observer.js` handles filters with a
  **legacy branch that hard-codes `field: 'service.name'`** and drops the `negate`
  state (`onClick`, the `saveFilter` case), and has **no handler at all** for
  column toggles or auto-refresh.
- **Adapter perform** — `kibana-coach/src/kibana-adapter.js::addFilter` fakes a
  filter by typing a `field: "value"` KQL clause and **ignores `operator`/`negate`**;
  `adapters/discover.js` lists `edit_filter`/`remove_column`/… in its command set but
  only `pointAt(command.target)`, so it can't act without the missing selectors.

### Amendments, by method

Each method needs the same three touch-points. Confirm the exact `data-test-subj`
strings against a **running Kibana 9.5.2** (DevTools / the test-subj registry) —
they are version-specific, so do not guess them into the selector file.

#### A. Filter-out (pill "is not" / negate) — highest value

| Layer | File | Change |
|---|---|---|
| Selectors | `kibana-coach/selectors/kibana-9.5.json` | Add `kibana.filter_pill`, the pill context-menu items (`Exclude results`, `Edit`, `Delete`, `Disable`), and the Add-filter popover fields (field / operator / value / save). |
| Observer | `action-observer.js` | Replace the hard-coded `saveFilter` branch with generic capture: read the applied pill's **field, value, and negate** state and emit `filter_added` / `filter_changed` with `{field, value, negate}`. This also repairs the **pre-existing** filter-*for* route, which is equally broken today. |
| Adapter | `kibana-adapter.js` | Give `addFilter` (and `edit_filter`) an operator/negate-aware path that drives the real Add-filter popover; keep the KQL-clause fallback. So "Show me" performs a genuine negated pill. |

Engine side already done: isolate accepts route 3 (`filter_excludes` on
`event.outcome`) lights up automatically once the observer emits `negate: true`.

#### B. Add / remove column

| Layer | File | Change |
|---|---|---|
| Selectors | `kibana-9.5.json` | Add `kibana.field_list`, per-field add-column and the grid header remove-column targets. |
| Observer | `action-observer.js` | New handler for column toggles → emit `column_added` / `column_removed` with `{field}`. (No column handling exists today, so `column_added` is also currently demo-only.) |
| Adapter | `adapters/discover.js` | Implement real add/remove-column interaction against those selectors (perform already routes the command; it just needs a resolvable target). |

Engine side already done: `inspect` accepts `column_added` **and** `column_removed`.

#### C. Auto-refresh interval

| Layer | File | Change |
|---|---|---|
| Selectors | `kibana-9.5.json` | Add the super-date-picker refresh controls (toggle, interval input, apply). |
| Observer | `action-observer.js` | Detect refresh-control interaction → emit `auto_refresh_changed` with `{interval, paused}`. |
| Adapter | `adapters/common.js` | `set_auto_refresh` already emits the observation; extend it to actually set the interval value via the new selectors. |

Engine side already done: `scope` accepts `auto_refresh_changed`. **Lowest priority**
— auto-refresh is live-tailing and adds little to a post-hoc log hunt; wire the
plumbing, but don't gate MVP acceptance on it.

### Cross-cutting

- **Optional engine nicety:** add a `query_excludes` validator (or a `not`-aware
  `query_contains`) so a learner who types `not field: value` in the KQL bar is
  recognized as a filter-out even without a pill. Not required — a combined KQL
  query already completes `isolate` via route 0.
- **Keep both selector files in sync** (`kibana-coach/selectors/` is the runtime
  copy; `learning/selectors/` is the reference), or collapse to one source.
- **Verification:** the Python engine is covered (`scripts/validate-scenarios.py`,
  `scripts/test-scenario-matrix.py --all`, `tests/test_randomization.py`,
  `python -m unittest discover -s tests`). The **browser observer/adapter is not
  unit-tested** — add a DOM-fixture test or, at minimum, a manual
  demo→guided→solo pass against live Kibana 9.5.2 for each of A/B/C.
- **Risk:** selector fragility across Kibana releases. The file is already
  version-named (`kibana-9.5.json`); on upgrade, re-verify.

### Definition of done (Part 1)

For each of A/B/C: a learner performing the action in real Kibana is observed with
the correct field/value/negate/interval and completes the matching goal in Guided
and Solo, and "Show me" performs it in Guided — verified against live 9.5.2.

---

## Part 2 — ≥5 randomized scenarios flexing the one MVP pattern

**Goal:** keep the MVP to the single Discover log-hunt *pattern*, but stop it being
solvable from muscle memory of just two scenarios. Guided/Solo should draw from
**at least 5** scenario variants, each randomized per run, all reusing the shared
`learning/templates/playbooks/discover.json` graph and the enriched
accepts/hints already in place.

### Current state

Seven **core** scenarios already extend `discover.json` and flex the pattern, but
only two carry the §14 `parameters` randomization block:

| Scenario | Type | Randomized? |
|---|---|---|
| `http-error-regression` | investigation | ✅ yes |
| `rare-error-signature` | investigation | ✅ yes |
| `auth-rejection-surge` | investigation | ❌ static |
| `deployment-version-regression` | investigation | ❌ static |
| `log-pattern-noise-reduction` | investigation | ❌ static |
| `discover-time-window` | analysis | ❌ static |
| `schema-drift-data-quality` | analysis | ❌ static |

### Plan

Promote static Discover scenarios to MVP standard by adding a top-level
`parameters` block (§14 contract) and wiring `${param.…}` through their `signal`,
`truth`, and playbook `variables` — exactly the pattern already proven in the two
randomized packs. **No engine or template work**: `scenario-controller/controller.py`
(`materialize` / `choose_parameters`) and `learning-service/server.py`
(`load_manifest_definition` / `resolve_parameters`) already resolve parameters, and
the enriched `discover.json` accepts/hints apply automatically.

Recommended order to reach ≥5 (target 5, stretch 7):

1. `auth-rejection-surge` — boolean-KQL + include/exclude; showcases the new
   filter-out / `not` hinting directly.
2. `deployment-version-regression` — multi-value filtering + field-comparison;
   already demos `add_column`, a natural column-flow variant.
3. `log-pattern-noise-reduction` — message filtering + include/exclude; another
   strong filter-out fit.
4. *(stretch)* `discover-time-window` — analysis framing, exercises the `scope`
   goal harder.
5. *(stretch)* `schema-drift-data-quality` — analysis framing, exercises
   field-statistics / missing-field inspection.

Per promoted scenario, verify with the existing gates:
`validate-scenarios.py`, `test-scenario-matrix.py --all`, and add the pack to
`LOG_HUNT_PACKS` in `tests/test_randomization.py` so reproducibility, cross-seed
variety, and end-to-end score-100 are asserted. **Watch the test coupling:** keep
each isolate goal's `accepts[0]` as the `query_contains fields:[signal_field]` route
and keep any `add_filter` demo's `reference_action.arguments` carrying the run's
signal field + finding (see `test_seeded_signal_truth_and_query_agree`).

---

## Part 3 — Are all 23 listed scenarios still relevant to the MVP?

**No.** The launcher lists every catalog entry
(`scenario-controller/controller.py::catalog_public()` returns all of
`learning/catalog.json`), so all 23 show locally. Only the Discover log-hunt set
belongs to the scaled-down MVP; the rest are the **retained long-term lab** (kept
in-tree per the MVP-scope-reset decision, not deleted) or legacy.

| Bucket | Count | Scenarios | MVP status |
|---|---|---|---|
| **Discover log-hunt (the MVP pattern)** | 7 | `http-error-regression`, `rare-error-signature`, `auth-rejection-surge`, `deployment-version-regression`, `log-pattern-noise-reduction`, `discover-time-window`, `schema-drift-data-quality` | **In MVP.** 2 randomized; 5 to promote (Part 2). |
| ES\|QL | 3 | `esql-top-failing-routes`, `esql-before-after-deploy`, `esql-cross-service-summary` | Deferred — different surface (ES\|QL editor, `esql.json` playbook). Retained. |
| Dashboard | 4 | `dashboard-incident-triage`, `dashboard-drilldown-to-evidence`, `dashboard-panel-inspection`, `capacity-throughput-saturation` | Deferred. Retained. |
| APM / traces | 4 | `slow-dependency-trace`, `trace-error-propagation`, `retry-amplification`, `trace-log-correlation` | Deferred. Retained. |
| Infrastructure | 3 | `cpu-saturation`, `memory-leak-and-restarts`, `hot-instance-imbalance` | Deferred. Retained. |
| Alerts | 1 | `active-alert-triage` | Deferred. Retained. |
| Legacy | 1 | `slow-payments` (`classification: "legacy"`) | Superseded by the generic engine + Discover packs. Exclude from MVP; candidate for removal. |

Totals: **7 in-MVP + 15 retained-deferred + 1 legacy = 23.**

### Recommendation

Keep all non-MVP packs in the tree (the retained goal), but **stop showing them in
the MVP launcher**. Cleanest approach: add an explicit `track: "mvp"` tag to the 7
Discover entries in `learning/catalog.json` and filter `catalog_public()` (and the
core-random selection at `controller.py:112`) by it, rather than by
surface/classification heuristics. This scopes the visible list to the MVP without
touching the deferred packs, and the tag is trivially removed when the full lab is
rebuilt.

---

## Suggested sequencing

1. **Part 3 tag/filter** — smallest change; immediately makes the local list reflect
   the MVP (fast win, de-clutters testing).
2. **Part 2 promotions** — pure scenario-data work on the proven randomization
   contract; gets Guided/Solo to ≥5 variants. No browser dependency.
3. **Part 1 A (filter-out) → B (columns) → C (auto-refresh)** — the browser-layer
   work; sequence by value. Each needs live-Kibana selector verification, so it's
   the slowest and best done last.
