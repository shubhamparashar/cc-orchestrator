# Changelog

All notable changes to cc-orchestrator. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); this project uses [SemVer](https://semver.org/).

## [1.1.0] — 2026-06-24

Linux support. The Mac-only platform glue is now isolated behind a single platform gate, so the
dashboard runs on Linux while macOS behavior is unchanged. (v1.0.0 listed Linux as an explicit
non-goal; this reverses that.)

### Added
- **Cross-platform support (Linux)** — `lib/platform.mjs` (`isMac`/`isLinux` single source of truth)
  gates every Mac-only path:
  - **Live refresh** (`lib/watch.mjs`) — recursive `fs.watch` on macOS; on Linux, where it throws, a
    ~3 s poll that reuses the scanner's `(size, mtime)` cache (a no-op when no SSE clients are
    connected). The per-file in-app transcript nudge stays macOS-only; the session list still
    refreshes on Linux.
  - **Terminal attach** (`lib/actions.mjs`) — `osascript` on macOS; on Linux the first available of
    `x-terminal-emulator` / `gnome-terminal` / `konsole` / `xterm`, passing the `shq`-escaped command
    as a distinct argv element so the no-injection guarantee is preserved. Headless hosts get the
    command to copy.
  - **Always-on** — `install-systemd-user.sh` (systemd `--user` unit) for Linux;
    `install-launchagent.sh` now refuses on non-macOS and points to it.
  - **Desktop metadata** (`lib/desktop.mjs`) — reads `~/.config/Claude` on Linux (fail-open).
  - **`start.sh`** — ported zsh→bash with portable listener/cwd detection (`lsof` on macOS, `ss` +
    `/proc/<pid>/cwd` on Linux); PID-kill still fails closed (only ever kills our `server.mjs`).
- **CI matrix** (`.github/workflows/ci.yml`) — `macos-latest` + `ubuntu-latest` running `node --check`,
  `node --test`, and an end-to-end smoke boot (`/healthz`, `/api/sessions`, `/api/diag`). This is the
  authoritative Linux verification, since the tool was built on macOS.

### Changed
- **Node ≥ 20 startup gate** message no longer attributes the requirement to recursive `fs.watch`
  (the Linux path no longer relies on it).

### Fixed
- **Hermetic `tasks` test** — reads fixtures / temp dirs instead of the live `~/.claude`, after CI
  surfaced the non-hermetic read.

### Docs
- README **Platforms (macOS / Linux)** section and a **Demo** placeholder (GIF pending a recording).

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

[1.1.0]: https://github.com/shubhamparashar/cc-orchestrator/releases/tag/v1.1.0
[1.0.0]: https://github.com/shubhamparashar/cc-orchestrator/releases/tag/v1.0.0
