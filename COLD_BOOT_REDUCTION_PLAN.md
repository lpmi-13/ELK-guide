# Kibana cold-boot reduction plan

Goal: minimise the time a learner spends **watching Kibana load** between clicking
"Start selected scenario" and reaching a usable, populated investigation screen.

This plan covers the residual cold-boot cost that pre-warming alone cannot remove,
plus a full range of options with trade-offs and a recommended sequence.

---

## Status — measured 2026-09-20; further work deferred

Tier 0 is shipped and, on measurement, sits at the practical ceiling of what
warming/caching can achieve here. Tier 1 (warm the *specific* space) was measured and
**refuted** — it buys ~0ms. Server-side rendering to static HTML was considered and
rejected. Tier 3b (embed + adopt the warmed instance) was scoped and is feasible but
deferred. Net: the shipped work already improved the experience materially; the
remaining options are either perceived-time cosmetics (**2a**) or a structural project
(**3b + 3c**), and are **deferred in favour of more product-centric priorities.** See
§4 for the data and §5 for the standing decision.

---

## 1. Anatomy of the current cold boot

From the 20-09-26 screencast (1 fps frames), the wall-clock after the prep tab
navigates into the per-run space (`localhost:5601/s/lab-…/app/discover`):

| Stage | Approx | What is happening |
|-------|--------|-------------------|
| "Loading Elastic" splash | ~0–3s | Kibana core + plugin JS bundles download, parse, init |
| Chrome mounts | ~3–6s | Top nav + Discover route chunk load |
| Discover app spinner | ~6–9s | Data view resolve, layout, `_field_caps` |
| "Searching" → documents | ~9–13s | First ES search for the space's data view returns |

Roughly **~10s of watched loading**, entirely *after* the "Preparing your
investigation" bar reports 100%. The bar completes on backend readiness only
(`telemetry/index.html` `launchWhenReady`), not on Kibana being interactive.

### Cost breakdown by shareability

- **Core + Discover bundles / server plugin init** — *identical across spaces*.
  This is the biggest slice (the splash + chrome mount) and is data-independent.
- **Per-space bootstrap** — space saved objects, the `microservices-*` data view,
  `_field_caps`, first search. *Specific to the run's space*, so a generic warm
  cannot cover it.

### Provisioning timeline (where the space already exists)

`scenario-controller/controller.py` `lifecycle()`:

1. `CREATED` → `ACTIVATING`: `create_space` (`:889`), data-view import (`:471`,`:500`),
   seed events, activate fault. **Space + data view exist at the end of this phase.**
2. `WARMING`: `readiness()` (`:785`) polls ES until live traffic has produced enough
   affected traces. **This is the longest phase** and the space is already queryable
   throughout it.
3. `READY`: learner is sent in.

Key insight: there is a large window (the whole `WARMING` phase) during which the
**specific** space is fully usable but nothing warms it in the browser.

---

## 2. Already shipped (Tier 0): generic bundle/core warm-up

`telemetry/index.html`: on Start, an off-screen `<iframe>` loads
`http://localhost:5601/app/discover` (default space, no coach handoff params, so no
learning session). It cold-boots Kibana's core + Discover bundles in parallel with
provisioning, warming the browser HTTP cache and Kibana's server-side plugin init.
It is torn down at `launchWhenReady` so the live tab gets full CPU on a warm cache.

- **Expected gain:** removes most of the splash + chrome-mount slice (the largest,
  data-independent part).
- **Limits:** does *not* warm the per-run space (different space), so the Discover
  spinner + first "Searching" tail can remain. Two Kibana frontends run briefly;
  mitigated by teardown at navigation.
- **Cost:** frontend-only, no backend change, already live via `docker compose cp`
  (rebuild `browser-telemetry` to bake it in permanently).

**Measured 2026-09-20 (§4): Tier 0 is at/near the warming ceiling and is already
permanent** (committed `c134126`, baked into the `browser-telemetry` image, served by
the running container). Its localhost-measured steady-state gain is modest (~430ms)
but understates the real-network bundle-download benefit it exists to capture.

---

## 3. Options to reduce the residual cold boot

Grouped by effort. Each entry: mechanism · expected gain · effort · risk/trade-offs.

### Tier 1 — incremental, build directly on Tier 0 (low risk) — **REFUTED by measurement**

> **2026-09-20:** measured directly (the `WARM_SPACE` condition, §4). Warming the exact
> per-run space before the learner arrives produced **no benefit** (−128ms, within
> noise), because a fresh navigation to a space always re-mounts the Discover SPA — the
> residual cost is client-side bundle execution + mount, not per-space bootstrap or
> first search. **Do not build 1a/1b.** (Warming the space only helps if the warmed
> frame *is* the one the learner keeps — that is Tier 3b, not 1a.)

**1a. Warm the *specific* space during `WARMING` (originally proposed as the highest-ROI next step).**
- *Mechanism:* expose that the space exists (e.g. surface run `state` incl.
  `WARMING`, or a `space_ready_at`, plus the handoff-free base URL) through
  learning-service `/api/runs/{id}`. When the launcher sees the space exists, repoint
  the warm iframe from the generic URL to `/s/{space}/app/discover` **with coach
  params stripped**. Warms the per-run space bootstrap, `_field_caps`, and first
  search across the whole `WARMING` window.
- *Gain:* targets the Discover-spinner + "Searching" tail that Tier 0 misses.
- *Effort:* small backend (expose signal) + small frontend (repoint).
- *Risk:* must strip `incident_coach_*` params so the warm frame never consumes the
  one-use session token (`addSessionHandoff` in `index.html`); otherwise a rogue
  duplicate coach session. Keep the CPU-teardown-at-navigation rule.

**1b. Server-side field-caps / search priming.**
- *Mechanism:* after data-view creation in `lifecycle` (`controller.py:500`), have the
  controller hit Kibana `_field_caps` and a representative Discover search for that
  data view, so ES + Kibana field caches are warm before the learner arrives.
- *Gain:* shortens the first-search tail even without browser warming; complements 1a.
- *Effort:* small, server-only.
- *Risk:* minimal; a few extra internal requests during provisioning.

**1c. Start warming earlier / keep it warm longer.**
- *Mechanism:* kick the warm iframe the instant Start is clicked (already the case);
  optionally keep a second hidden warm frame alive until the live tab has actually
  navigated, trading CPU for cache completeness on very fast provisioning.
- *Gain:* marginal; only helps when prep is shorter than bundle fetch.
- *Effort:* trivial. *Risk:* CPU contention if kept past navigation.

### Tier 2 — moderate

**2a. Gate the reveal on readiness + overlap first search behind the briefing.**
- *Mechanism:* the incident briefing modal already covers the boot. Keep it up (or an
  opaque cover) until Discover has actually painted and the first search settled
  (detect via `adapter.waitFor` on a Discover `data-test-subj`), and let that first
  search run behind it. The reveal then shows populated data instead of a spinner.
- *Gain:* hides *whatever* residual boot remains after Tier 1 — perceived time drops
  to zero even if wall-clock isn't.
- *Effort:* moderate (`incident-briefing.js`, `content-script.js`).
- *Trade-offs:* changes briefing timing; the fixed 30s countdown (`server.py:314`)
  should become readiness-driven. (Note: user is fine with the blur itself.)

**2b. Lighter starting view.**
- *Mechanism:* reduce first-search cost — fewer default columns/fields, a tighter
  default time range or row count in the starting view (`starting_view` /
  saved objects). Smaller first payload = faster "Searching".
- *Gain:* shaves the tail. *Effort:* moderate (saved-object/data tuning per scenario).
- *Risk:* must not change the pedagogical starting state the scenarios expect.

### Tier 3 — structural (biggest wins, biggest cost)

**3a. Warm-space pool.**
- *Mechanism:* keep N pre-created, pre-warmed spaces (space + data view + a browser
  context that already booted Discover) ready to assign. Provisioning seeds data into
  an already-warm space instead of creating one cold.
- *Gain:* removes space-creation + first-space-load from the critical path entirely.
- *Effort:* high — pool lifecycle, assignment, cleanup.
- *Risk:* interacts with disk/ILM cleanup and space deletion on the 8h ephemeral VM
  (see `disk-management-system` memory); pool size vs. memory budget.

**3b. Embed Kibana in the lab shell and adopt the warmed instance.**
- *Mechanism:* host Kibana in an iframe inside the lab shell permanently. The instance
  that was warmed *is* the one the learner uses — swap its context / feed the handoff
  in place rather than navigating a fresh tab. Zero re-load handoff.
- *Gain:* potentially eliminates the entire post-navigation reload.
- *Effort:* high — iframe hosting, coach injection within the frame, handoff into the
  frame, CSP/embedding review (current headers allow framing: no `X-Frame-Options`,
  no enforced `frame-ancestors`), telemetry path changes.
- *Risk:* largest architectural change; the coach content-script and session handoff
  assume a top-level Kibana tab today.
- *Feasibility (scoped 2026-09-20):* the codebase is friendly to it. Kibana is framable
  today (no `X-Frame-Options`; CSP has no `frame-ancestors`); security is off, so there
  is no auth cookie to trip SameSite in a frame (only `KBN_LOCALE`); the coach scripts
  use no `window.top/parent/open` and operate on their own `document`/`location`, so
  they work framed; the nginx gateway already serves Kibana + coach assets + the
  learning WS on one origin (`:5601`), so serving the shell there too makes parent↔frame
  same-origin (direct `sessionStorage`/DOM control, no postMessage); and
  `startSession(config)` (`content-script.js:93`) is already re-entrant, so re-hooking a
  run needs only a small exposed `adopt()` hook.
- *The mechanism that actually saves the mount:* adopt only wins if the frame that boots
  the per-run space **is the one the learner keeps** (no second navigation). So: during
  the `WARMING` window (space already exists; create→READY ≈ 6s) point a persistent frame
  at the per-run URL, let it boot behind a cover, then **reveal that same frame.** This
  overlaps the ~5.8s mount with provisioning/briefing — perceived boot ≈ 0, structurally
  (there is no second mount to hide). This is why 3b works where measured Tier 1a did not.
- *Payoff cap:* with per-run spaces, each **new** run is a new space = a fresh navigation
  = a re-mount. 3b hides the *first* run's mount; "mount once per session" needs 3b **+
  3c** (shared space). Much of the single-run win is also available from the far cheaper
  **2a** (an opaque cover injected by `kibana-bootstrap.js` from the first byte, lifted
  when first-docs paint — no framing, no topology change), so validate 2a before investing
  in framing.

**3c. Single shared space with per-run scoping.**
- *Mechanism:* drop per-run spaces; use one long-lived space with a per-run data view
  or query/filter scoping. Eliminates per-run space creation and first-space load.
- *Gain:* large, structural. *Effort:* high.
- *Trade-offs:* loses the clean per-run saved-object isolation that per-run spaces
  give today; needs per-run data views or strict query scoping; cleanup model changes.

### Considered and rejected

**Server-side render Discover into static HTML.** Confirmed live: Kibana's server
response for `/app/discover` is a ~275KB **bootstrap shell** (`kbn-injected-metadata` +
`bootstrap.js`) with **zero** rendered app — Discover is a client SPA by design.
"Switch to SSR" would mean forking Kibana's rendering per-app (and redoing it on every
upgrade; pinned 9.5.2). Even if done, hydration re-downloads and re-executes the same
bundles, so the ~3.4s navStart→chrome slice is unchanged and time-to-interactive does
not improve; a truly static page is a dead screenshot (no query/time/sort/ES|QL until
JS boots anyway) and abandons the "drive real Kibana" premise. **Rejected.**

---

## 4. Measurement (done 2026-09-20)

Driven with Playwright against live Kibana 9.5.2 (scenario `discover-time-window`, 3
reps/condition). Milestones are ms from navigation start: `kibanaChrome` →
`unifiedQueryInput` (Discover shell) →
`[data-test-subj=discoverDocTable] [data-gridcell-row-index=0]` (first docs).

Three conditions isolate *what* is warm:
- **COLD** — nothing warmed.
- **WARM_GENERIC** — Tier 0 as shipped: default-space `/app/discover` warmed first,
  per-run space cold.
- **WARM_SPACE** — the Tier 1a/1b ceiling: the exact per-run space warmed first.

| Milestone | COLD | WARM_GENERIC | WARM_SPACE | Tier 0 gain | Tier 1 *extra* |
|-----------|------|--------------|------------|-------------|----------------|
| chrome    | 3869 | 3385 | 3536 | −484 | −151 (noise) |
| discover  | 5884 | 5407 | 5600 | −477 | −193 (noise) |
| firstDocs | 6074 | 5645 | 5773 | **−429 (7.1%)** | **+128 (none)** |

Reading:
- **Total warmable ceiling** (COLD − everything-warm) ≈ 300ms (5%). Tier 0 alone already
  captures ~430ms of it — i.e. Tier 0 is at the ceiling within noise.
- **Tier 1 adds nothing.** Warming the specific space did not help, because a fresh
  navigation always re-mounts the Discover SPA. There is no per-space bootstrap /
  first-search tail to reclaim on this product's small seeded datasets.
- **Residual ~5.8s is CPU-bound** client-side bundle execution + Discover mount — not
  addressable by any cache/warm strategy.
- create→READY was 6.1s (the window Tier 1a would have used, and the window Tier 3b
  *could* overlap a mount into — see §3, Tier 3b).

Caveats: measured on localhost (bundle "download" is near-free, so Tier 0's real-network
benefit is understated) and against an already-running Kibana (server plugin-init already
warm, so Tier 0's cold-VM overlap benefit isn't visible). Neither revives Tier 1, whose
only extra target is server/ES per-space state — network-independent, measured at ~0.

Harness: a Playwright script (`measure-cold-boot.cjs`) that creates a run, measures the
three conditions × N reps against the resolved per-run investigation URL, then deletes
the run; run with the global Playwright (`NODE_PATH=$(npm root -g) node …`). Kept in the
session scratchpad; promote to `scripts/` if we want it as a regression check.

---

## 5. Standing decision (2026-09-20)

Measurement (§4) changed the plan. Current position:

1. **Tier 0 — done and permanent.** Shipped, committed (`c134126`), baked into the
   `browser-telemetry` image. At/near the warming ceiling. No further action.
2. **Tier 1 (1a/1b) — do not build.** Measured at ~0ms; the per-space tail it targets
   does not exist here (§3 Tier 1, §4).
3. **Everything else — deferred.** The residual ~5.8s is CPU-bound mount, movable only by
   perceived-time cosmetics (**2a** — the cheap 80/20: a self-injected cover in
   `kibana-bootstrap.js`) or a structural project (**3b + 3c**). The shipped work already
   improved the experience materially, so these are **deferred in favour of more
   product-centric priorities.** When revisited, start with **2a** to confirm the
   provisioning/briefing overlap is enough before investing in framing.

---

## 6. Cross-cutting risks

- **CPU contention:** never run the warm instance and the live load simultaneously;
  keep the teardown-at-navigation rule (Tier 0 already does).
- **Memory / disk on the 8h ephemeral VM:** warm frames and any pool add footprint;
  respect the existing disk-management bounds (`disk-management-system` memory).
- **Session-token safety:** any specific-space warm must strip `incident_coach_*`
  params so it never opens a duplicate learning session.
- **ES flood-stage:** new runs can be blocked when ES disk hits the flood watermark
  (`intermediate-plan-progress` memory) — unrelated to boot time but blocks testing.
