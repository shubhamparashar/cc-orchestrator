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
| 7 | 2026-06-23 | [session-7-2026-06-23.md](handoffs/session-7-2026-06-23.md) | Re-verified the v1 slice once more, then **committed** it (`a9f29c5`) and **pushed** `v1-build` to origin. Built + committed the best value÷effort stretch item **A6 — cross-session prompt palette** (`c60253d`): new `lib/history.mjs` + `/api/history` + palette modal, with secret redaction (login token, API keys, JWT/bearer, DB-URL passwords, underscore env vars) hardened after a 2-agent adversarial review. A3 dropped (sparse `turn_duration`). 19/19 tests; verified via Claude Preview MCP (0 token leaks). `bin/crc` still an unrelated uncommitted change. |
| 8 | 2026-06-23 | [session-8-2026-06-23.md](handoffs/session-8-2026-06-23.md) | Committed `bin/crc` (`3566779`) + opened **PR #1** (`v1-build→master`). Built **C3 — onboarding** (`4dd8043`, **PR #2**): `lib/onboarding.mjs` + `bin/cc-install-hooks` (additive idempotent reversible `settings.json` hook merge) + `bin/cc-doctor` (10-check preflight). Built **C7 — rotating logs + consent-gated bug report** (`140baf5`): `lib/logger.mjs` (0600 rotated log + `bin/cc-logs`) + `lib/diag.mjs` + `/api/diag` + footer link. Each hardened by an adversarial review (C3: backup/relocation/LAN-port/malformed-shape; C7: log perms, loopback-gated error, username scrub). 40/40 tests. Linear PR stack #1←#2←#3; plans in `docs/{C3_ONBOARDING,C7_LOGS_DIAG}_PLAN.md`. v1.0 bar met — only docs polish (FAQ/GIF/CHANGELOG) remains. |
| 9 | 2026-06-24 | [session-9-2026-06-24.md](handoffs/session-9-2026-06-24.md) | Recorded the post-session-8 work the log hadn't captured — **v1.0.0 tag + GitHub release** (`docs polish`, FAQ), the **C7 missing-tests fix** (`6a327b9`, PR #5; CI caught untracked test files), and **C2 — Linux support + GitHub Actions CI matrix** (`2d3aa5e`/`f787620`, PR #7): `lib/platform.mjs` gate, `lib/watch.mjs` Linux poll fallback, cross-platform terminal attach / `start.sh` / systemd `--user` unit, `~/.config/Claude` desktop path; macOS+Linux CI (`node --check`+`node --test`+smoke boot) is the load-bearing Linux verification. Then **cut v1.1.0** (Linux = SemVer minor): `CHANGELOG [1.1.0]` + `package.json` bump + annotated `v1.1.0` tag + GitHub release. CI green on `master`; 43/43 tests, `node --check` clean (25). |
| 10 | 2026-06-25 | [session-10-2026-06-25.md](handoffs/session-10-2026-06-25.md) | Diagnosed + fixed a live `:7433` "Cost over time" crash (4-day-old LaunchAgent served the new disk HTML but 404'd the new routes; frontend read `r.buckets.length` unguarded) — restarted the agent + hardened `loadRollup` (shipped in v1.1.0). Then **cut v1.2.0 — AFK alerts (B-P3)**: `lib/{alerts,notify,config,presence}.mjs` + a gated `setInterval` in `server.mjs` — waiting-on-you digest + once-per-UTC-day budget alert + presence-aware suppression; config-driven & **default-OFF**, injection-safe `osascript`/`notify-send`, `CC_ALERT_DRYRUN`, single-flight state writes (caught a real read-modify-write race in dry-run verify). Built by a worktree agent (**PR #9**), code-reviewed + independently dry-run-verified before merge; 64/64 tests. Chose scoped npm name **`@shubhamparashar/cc-orchestrator`** (unscoped taken by `zhsks311`) + `publishConfig.access:public` — **`npm publish` still PENDING `npm login`** (user must auth; agent can't). |

_Sessions 1–2 dates are approximate (reconstructed from session context files); 3–8 are exact._
