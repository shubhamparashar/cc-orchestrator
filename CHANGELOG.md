# Changelog

All notable changes to cc-orchestrator. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); this project uses [SemVer](https://semver.org/).

## [1.0.0] — 2026-06-23

First tagged release: a zero-dependency, no-build, local-first, read-only web + phone dashboard over
all your Claude Code sessions, made installable and honest for someone other than the author.

### Dashboard
- **Status-bucketed board** — Waiting on you / Working / Idle / Done; "needs input" is a
  first-class, filterable column.
- **TodoWrite progress** (A1) — per-session `N/M done · k in progress` + task list, from
  `~/.claude/tasks`.
- **Tool-mix + error-rate health** (A2) — per-session tool histogram, error-rate gauge,
  retry-loop flag, and compaction count.
- **Cost rollups + export** — day/week/month and per-model spend via `/api/cost/rollup`, as JSON or
  CSV, on top of the existing per-session lifetime cost.
- **Surfaced fields** (A7) — model, reasoning effort, permission mode, session uptime, kind.
- **Cross-session prompt palette** (A6) — searchable log of every prompt typed across all sessions,
  with secret redaction (login token, API keys, JWT/bearer, DB-URL passwords, env-var credentials).

### Productization
- **`LICENSE`** (MIT) and **`package.json`** (zero dependencies, `bin` entries, `engines: node >=20`).
- **Node ≥ 20 startup gate** ahead of the recursive `fs.watch` (fails loud instead of a
  silently-never-refreshing dashboard); README corrected from ≥18.
- **`SECURITY.md`** documenting the trust model (loopback is unauthenticated; LAN is plaintext —
  prefer Tailscale), plus **`cc-rotate-token`** and the opt-in **`CC_REQUIRE_TOKEN_LOCAL`**.
- **Onboarding** (C3) — **`cc-install-hooks`** (additive, idempotent, reversible
  `~/.claude/settings.json` hook merge) and **`cc-doctor`** (preflight: Node, `claude` on PATH, port,
  config/data dirs, hooks, token perms, Desktop metadata, recursive watch).
- **Logging & reporting** (C7) — **`cc-logs`** + a `0600` size-rotating log under
  `~/.config/cc-orchestrator/logs/`, and a consent-gated "Report a bug" link that opens a prefilled,
  sanitized GitHub issue (no backend, no auto-send, no PII).
- **Docs** — top-of-README quickstart, onboarding section, and a troubleshooting/FAQ section.

### Notes
- Mac-only for v1 (recursive `fs.watch`, `osascript`, LaunchAgent). Linux/Windows, a menu-bar app,
  team/multi-tenant, and backend telemetry are explicit non-goals for v1.
- All session data is read-only; the only write outside the tool's own config is the additive
  `settings.json` hook merge performed by `cc-install-hooks`.

[1.0.0]: https://github.com/shubhamparashar/cc-orchestrator/releases/tag/v1.0.0
