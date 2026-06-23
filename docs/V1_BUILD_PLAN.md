# cc-orchestrator — v1 Build Plan

Implements the best value÷effort slice of [PRODUCT_IDEAS.md](PRODUCT_IDEAS.md). This doc is the
load-bearing contract: parallel agents build disjoint NEW files around the frozen JSON shapes in
§2, and one integration pass wires the chokepoints (`scan.mjs`, `server.mjs`, `public/index.html`).

Hard principles held throughout: zero runtime npm deps · no build step · single vanilla
`public/index.html` · local-first · `~/.claude` + Desktop storage READ-ONLY · token-frugal (no model
calls on hot paths) · build-vs-reuse (don't rebuild native `claude agents` / Remote Control). Tests
use Node stdlib only (`node:test`, `node:assert`).

---

## 1. Validated ranking (value ÷ effort)

Re-ranked the doc's items; the committed slice below matches the requested anchor set — confirmed,
no reordering needed. One-line rationale per item:

| Rank | Item | Value | Effort | Why it's in / its slot |
|---|---|---|---|---|
| 1 | **Status-bucketed board** (B-P1) | H | S | Re-organizes data already computed; "Waiting on you" is the single most convergent UX. Web/phone form native's TUI lacks. |
| 2 | **A1 TodoWrite progress** | H | S | Clean `~/.claude/tasks/<uuid>` mirror already on disk; pure read. |
| 3 | **Cost rollups + export** | H | S | cc-orchestrator's least-absorbable analytic; `/usage` is in-session only. |
| 4 | **A7 dropped fields** | M | S | `effort`/`permissionMode`/`startedAt`/`kind` are already parsed then discarded — nearly free. |
| 5 | **A2 tool-mix + error-rate health** | H | S–M | One more counter pass over the tail the scanner already opens; flags retry-loops. |
| — | **Productization** (LICENSE, package.json+gate, SECURITY+rotate+opt-in, README quickstart) | H | S–M | The gate between "author's tool" and "product"; parallelizes cleanly as new files. |

Stretch (only if all green): A4 compaction markers (already counted by health → cheap badge), A8
status chips, A3 active-time, A6 prompt palette. Out of scope (Section D non-goals): team/multi-
tenant, `.app`/Electron, backend telemetry, live steering.

---

## 2. Frozen data contracts (Step 1 — load-bearing)

All shapes verified against real `~/.claude` data on this machine (2026-06-22).

### 2a. `lib/tasks.mjs` → `sessionTasks(sessionId)`
Reads `~/.claude/tasks/<sessionId>/<N>.json` (numbered files only — skip `.lock`, `.highwatermark`,
any non-numeric name). Each file: `{id, subject, description, activeForm, status, blocks[], blockedBy[]}`.
Observed `status` values: `completed`, `pending` (TodoWrite schema also defines `in_progress`).
**Returns (always an object, zeroed when no tasks — so `/api/sessions` always `has("tasks")`):**
```js
tasks: {
  total,        // # numbered task files
  done,         // status === 'completed'
  inProgress,   // status === 'in_progress'
  pending,      // status === 'pending'
  blocked,      // blockedBy.length > 0 AND status !== 'completed'
  items: [ { subject, status } ]   // in numeric filename order; status one of completed|in_progress|pending
}
```
Fallback when no tasks dir exists: best-effort read the **last `TodoWrite` tool_use** in the
transcript tail (`input.todos[] = {content, status, activeForm}`), mapping `content`→`subject`.
Fallback is optional polish; the primary path is the tasks dir.

### 2b. `lib/health.mjs` → `sessionHealth(path)`
Takes a transcript **path** (like `sessionUsageByModel`). Full-file parse, cached on `(size, mtime)`
with append-offset resume mirroring `cost.mjs` (counts are monotonic, so resume just keeps adding —
no cross-batch join needed). Sources, all verified:
- `tool_use` parts live in `assistant.message.content[]`: `{type:'tool_use', name, id}`.
- `tool_result` parts live in `user.message.content[]`: `{type:'tool_result', tool_use_id, is_error, content}`.
- compaction: `system` record `{subtype:'compact_boundary', compactMetadata:{trigger, preTokens, postTokens, durationMs}}`.
```js
health: {
  totalCalls,   // # tool_use parts
  byTool,       // { [toolName]: count }
  errorCount,   // # tool_result with truthy is_error
  errorRate,    // errorCount/totalCalls*100, 1-decimal percent; 0 when totalCalls===0
  compactions   // # compact_boundary system records
}
```

### 2c. `lib/cost.mjs` (extend) → cost rollup
Add (do not modify existing `sessionUsageByModel`/`pruneUsageCache`):
```js
usageByDateModel(path) -> { [YYYY-MM-DD]:           // UTC day from record timestamp
                             { [model]: {input, output, cacheRead, cacheWrite5m, cacheWrite1h} } }
   // full parse, cached on (size, mtime). Reuses the existing accumulate() tier logic.
rollupFromDaily(dailyMaps, { window, pricing }) -> {
  window,                                            // 'day' | 'week' | 'month'
  buckets: [ { date, usd, byModel: { [model]: usd } } ],  // ascending by date
  totalUsd
}
   // date key: day = 'YYYY-MM-DD'; week = Monday(UTC) of that ISO week as 'YYYY-MM-DD'; month = 'YYYY-MM'.
rollupToCsv(rollup) -> string
   // wide CSV. Header row REQUIRED: `period,total_usd,<model columns, sorted asc>`.
   // one row per bucket; missing model cell = 0; usd rounded to 4 decimals.
```
Assistant records carry ISO `timestamp` (e.g. `2026-06-09T06:53:08.206Z`) + `message.model` +
`message.usage` — verified. Buckets are UTC; documented in the CSV/JSON.

### 2d. New session fields (surfaced in `scan.mjs` during integration — A7)
- `effort` ← `desktop.effort` (Desktop metadata; null for non-Desktop)
- `permissionMode` ← `desktop.permissionMode`
- `startedAt` ← `live.startedAt` (live registry; already returned by `live.mjs`, just dropped)
- `kind` ← `live.kind` (e.g. `interactive`)

### 2e. New routes (server.mjs during integration)
- `GET /api/cost/rollup?window=day|week|month&format=json|csv` → §2c JSON, or CSV with header row.
- `/api/sessions` objects gain `tasks` (§2a) and `health` (§2b) via `attachTasks`/`attachHealth`
  (mirror `attachCost`'s `mapLimit(…, 8, …)` at server.mjs:60), plus the §2d fields.

### 2f. Status → board bucket mapping (UI)
| Bucket | Statuses |
|---|---|
| **Waiting on you** | `waiting-on-input` |
| **Working** | `running` |
| **Idle** | `open-idle`, `idle` |
| **Done** | `archived` |
Every status maps to exactly one bucket. "Waiting on you" is a first-class, filterable column.

---

## 3. Parallel-track assignment (disjoint files — no two agents touch the same file)

| Track | Owns (NEW unless noted) | Touches chokepoint? |
|---|---|---|
| D1 | `lib/tasks.mjs`, `test/tasks.test.mjs` | no |
| D2 | `lib/health.mjs`, `test/health.test.mjs`, `test/fixtures/health-sample.jsonl` | no |
| D3 | `lib/cost.mjs` (EDIT — append only), `test/cost-rollup.test.mjs` | no (sole owner of cost.mjs) |
| P1 | `LICENSE`, `package.json`, `README.md` (EDIT) | no (sole owner of README) |
| P2 | `SECURITY.md`, `bin/cc-rotate-token`, `lib/auth.mjs` (EDIT) | no (sole owner of auth.mjs) |
| **INT** (me, serial, last) | `lib/scan.mjs`, `server.mjs`, `public/index.html` | yes — single owner |

Chokepoints `scan.mjs` / `server.mjs` / `public/index.html` are edited ONLY in the integration pass.

---

## 4. Per-step exit criteria (a step is DONE only when its ONE test passes)

| Step | Exit test | Result |
|---|---|---|
| every `.mjs` | `node --check <file>` passes | ✅ all `.mjs` check OK |
| D1 tasks | `node --test test/tasks.test.mjs` green; asserts session `b7e3a062-…` → total=13, done=8, pending=5, blocked=3 against real tasks data | ✅ 3/3 green; matched real data (also `6ebaa5ce-…` 15/15) |
| D2 health | `node --test test/health.test.mjs` green; on the committed fixture: top `byTool` is `Bash` and `errorRate` ≈ 4.1 (±0.2); compactions counted | ✅ 2/2 green; errorRate=4.1, Bash=28 (strict top), compactions=1 |
| D3 cost rollup | `node --test test/cost-rollup.test.mjs` green (bucketing + CSV header); then `curl …/api/cost/rollup?window=week \| jq '.buckets\|length>0'`→true; `?format=csv` has a header row | ✅ 5/5 green; live week=15 buckets; CSV header `period,total_usd,<models>` |
| P1 license/pkg | `node -e "const p=require('./package.json')"` parses; `engines.node==='>=20'`; `dependencies` is `{}` | ✅ engines `>=20`, deps `{}`, bin→server.mjs; README ≥18→≥20 fixed |
| P2 security | `bin/cc-rotate-token` removes the token file; next remote request demands re-auth; `CC_REQUIRE_TOKEN_LOCAL=1` forces `isLocalRequest`→false (unit) | ✅ 2/2 auth tests green; rotate+restart → new token, old token 401 (e2e on throwaway HOME/port) |
| INT sessions fields | `curl …/api/sessions \| jq '.[0]\|has("tasks") and has("health") and has("effort")'`→true | ✅ true; effort/permissionMode/startedAt/kind populated |
| INT board UI | boot server, load `/`; 4 buckets render; a `waiting-on-input` session lands in "Waiting on you" | ✅ 4 columns (Waiting 1 / Working 1 / Idle 74 / Done 0); waiting session in leftmost column (screenshot) |
| INT progress/health UI | a real session card shows the progress bar + error gauge with live data | ✅ progress `8/13 done · 3 blocked` @62%, `4/4 done` @100%; 25 health gauges live (`0% err · 13 calls · Bash 31%`) |
| INT Node≥20 gate | server under a simulated `<20` runtime exits with a clear message (not silent watch failure) | ✅ overridden `process.versions.node=18.0.0` → exit 1 + "requires Node >= 20" message, no bind |
| INT cost UI | cost modal: day/week/month tabs, per-model table, CSV/JSON export | ✅ Month → 4 buckets, "Total $24,212", 6 model columns, Download CSV/JSON links (screenshot) |

**Verification environment:** Node v20.19.5, macOS; branch `v1-build`; preview server on a throwaway
port 7455 (the user's always-on instance on 7433 was left untouched). Full suite: **12 tests, 12 pass, 0 fail.**
No console errors/warnings on the rendered board.

Reference counts (verified 2026-06-22, historical sessions — stable): task dirs 4 / 38 files;
`b7e3a062-…` total=13 done=8 pending=5 blocked=3; `6ebaa5ce-…` 15/15.

---

## 5. Build log

Parallel fan-out (5 concurrent agents, disjoint files) → serial integration. All exit tests passed
before any step was marked done. Chronological:

1. **Step 1 (contracts)** — froze §2 shapes against real `~/.claude` (task dirs, transcript
   tool_use/tool_result/compact_boundary, assistant timestamps). Branched `v1-build`.
2. **D1/D2/D3 + P1/P2 (parallel)** — each agent created only its owned files, ran its own exit test:
   - D1 `lib/tasks.mjs` + test → 3/3 green; real-data counts matched (no asserts fudged).
   - D2 `lib/health.mjs` + fixture + test → 2/2 green; fixture tuned to errorRate=4.1, Bash strict top.
   - D3 `lib/cost.mjs` (append-only) + test → 5/5 green; existing exports byte-for-byte unchanged.
   - P1 `LICENSE` + `package.json` + README quickstart/version fix → gate passes.
   - P2 `SECURITY.md` + `bin/cc-rotate-token` + auth opt-in + test → 2/2 green; ROTATE_OK.
3. **Integration (serial, single owner of chokepoints)** —
   - `lib/scan.mjs`: surfaced `effort`/`permissionMode`/`startedAt`/`kind` (A7).
   - `server.mjs`: `#!/usr/bin/env node` shebang, Node≥20 startup gate, `attachTasks`/`attachHealth`
     (mirroring `attachCost`'s bounded `mapLimit`), and `GET /api/cost/rollup?window=&format=`.
   - `public/index.html`: status-bucketed 4-column board (`render()` rewrite), task progress bar,
     tool-mix/error-rate health gauge + retry-loop flag, compaction badge, A7 meta badges, and the
     cost-over-time modal (day/week/month + CSV/JSON export). New icons `ic-chart`/`ic-activity`.
4. **Verification** — booted the real server on a throwaway port; curl'd every new endpoint; drove
   the UI via the Claude Preview MCP (board screenshot, cost-modal screenshot, progress/health/blocked
   asserts via `preview_eval`); simulated Node<20; ran token rotation end-to-end. See §4 results.

**Not committed** (per instructions: stop after local verification). `bin/crc` shows as modified in
`git status` but that predates this session — not part of this slice.
