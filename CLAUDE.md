# CLAUDE.md

Guidance for Claude Code working in this repo (cc-orchestrator).

cc-orchestrator is a zero-dependency local control plane over Claude Code sessions
(dashboard, remote control, rolling per-session `context.md`, BM25 session index,
launcher, cost calc, always-on LaunchAgent, Tailscale phone access). Full design and
audit live in `REPORT.md`; usage in `README.md`. Read those before re-deriving anything.

## Handoff Log

Every time you finish a working session on cc-orchestrator and hand off to the next
agent, **append one row** to the table below and title the handoff doc with the
**Name** from that row.

- **Numbering — monotonic.** Take the highest session number in the table and add 1.
  Handing off from session 3 → the next is session 4. Never reuse a number.
- **Name format —** `cc-orchestrator — <YYYY-MM-DD> — session <N>`
  (e.g. `cc-orchestrator — 2026-06-17 — session 4`). Use this as the handoff doc's H1
  title, and save the file as `handoffs/session-<N>-<YYYY-MM-DD>.md` (link it in the
  **Doc** column below so the log stays a navigable index).
- **Date —** the calendar date (today) on which you write the handoff.

| Session | Date | Doc | Summary |
|---|---|---|---|
| 1 | 2026-06-12 | _(pre-convention)_ | Initial build: dashboard (visibility), remote control, evolving per-session context files, session indexing. |
| 2 | 2026-06-12 | _(pre-convention)_ | macOS always-on LaunchAgent, cost calculator, launcher/UI, Tailscale phone access (blocked on one Tailscale toggle). |
| 3 | 2026-06-16 | [session-3-2026-06-16.md](handoffs/session-3-2026-06-16.md) | Two-tier indexing rework — Tier-1 free BM25F index over all sessions (`lib/sessionIndex.mjs`, `lib/rank.mjs`) + Tier-2 `context.md` backfill; fixed context-gen outage (Fable-5 gated → default `claude-haiku-4-5` with default-model fallback). |
| 4 | 2026-06-17 | [session-4-2026-06-17.md](handoffs/session-4-2026-06-17.md) | Verified + landed the session-3 indexing rework: `node --check` all 17 `.mjs`, reindex=72 sessions, hasContext 36/72, BM25 `signoz` query precise; gitignored `.serena/`; added this Handoff Log convention. |
| 5 | 2026-06-22 | [session-5-2026-06-22.md](handoffs/session-5-2026-06-22.md) | v1 slice (parallel agents, per-step exit tests) on branch `v1-build`, uncommitted: status-bucketed board + TodoWrite progress + tool-mix/error-rate health + cost rollups/CSV export + A7 dropped fields; LICENSE/package.json+Node≥20 gate, SECURITY.md+token rotation+`CC_REQUIRE_TOKEN_LOCAL`. New `lib/{tasks,health}.mjs`, `cost.mjs` rollup, `/api/cost/rollup`; 12/12 tests green; UI verified via Claude Preview MCP. Plan + results in `docs/V1_BUILD_PLAN.md`. |
| 6 | 2026-06-23 | [session-6-2026-06-23.md](handoffs/session-6-2026-06-23.md) | Independent end-to-end re-verification of the session-5 v1 slice (no new feature code). Re-ran every `docs/V1_BUILD_PLAN.md §4` exit criterion from scratch: 12/12 tests + 19/19 `node --check`; `/api/sessions` tasks/health/A7 fields; cost rollup JSON+CSV; Node<20 gate; token-rotation e2e (old→401, new→302); board + progress + health + cost-modal UI via Claude Preview MCP, no console errors. All green; slice still uncommitted on `v1-build`. |

_Sessions 1–2 dates are approximate (reconstructed from session context files); 3–6 are exact._
