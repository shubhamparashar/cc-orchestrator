# Changelog

All notable changes to cc-orchestrator. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); this project uses [SemVer](https://semver.org/).

## [1.3.0] — 2026-06-26

### Added
- **Sub-agent transcript indexing (A9).** The nested sub-agent transcripts
  (`<session>/subagents/**/agent-*.jsonl` — Explore / Task / workflow runs, ~565 on
  this machine) are folded into both cost and search from one `(size, mtime)`-cached
  walk (`lib/subagents.mjs`):
  - **Cost recovery** — sub-agent spend (e.g. Explore → Haiku) was previously
    unattributed; it now merges into each session's cost, the header total, the
    cost-over-time rollup, and the budget alert. Purely additive and double-count-free
    (the parent transcript carries only a model-less `Agent` rollup that the
    assistant-only accumulator never counts). `/api/sessions` gains `subagents`
    (count) and `subagentCost`; ~$1,080 of fleet spend recovered in testing.
  - **Search corpus (~5.5×)** — each sub-agent becomes a searchable Tier-1 index
    entry (task description + agent type + dialogue tail); a hit navigates to its
    parent session. Index grew 100 → ~654 entries here.
  - **UI** — a per-session "⛬ N subagents" chip and distinct "↳ type: description"
    search hits.
  - `lib/cost.mjs` now exports its line-accumulation helpers so the sub-agent walk
    reuses them rather than duplicating the cost logic.

## [1.2.1] — 2026-06-26

### Fixed
- **Context-window % was ~5× too high for 1M-native models.** The per-session
  context-used percentage divided by a hardcoded 200k window unless the model id
  carried a `[1m]` marker. Current models (Opus 4.6/4.7/4.8, Sonnet 4.6, Fable 5)
  ship a 1M window as standard and carry no marker, so e.g. an Opus 4.8 session at
  130k tokens showed 65% instead of the correct 13% (Claude Desktop's figure).
  `contextWindowFor` now resolves the window from a per-model table (longest-prefix
  match on the Desktop id, then the transcript id), still honors the `[1m]` beta
  marker for 1M-beta sessions on otherwise-200k models, and keeps a usage-based
  safety net for unrecognized models.

## [1.2.0] — 2026-06-25

AFK alerts — opt-in OS notifications for sessions waiting on you and for daily spend crossing a
budget, so an unattended fleet can reach you without watching the dashboard. Off by default.

### Added
- **AFK alert subsystem** (`lib/alerts.mjs`, `lib/notify.mjs`, `lib/config.mjs`, `lib/presence.mjs`),
  config-driven via `<config-dir>/config.json`, **disabled unless `alerts.enabled` is set**:
  - **Waiting-on-you digest** — notifies when the count of `waiting-on-input` sessions changes
    (deduped so an unchanged count never re-fires); suppressed while you're present at the machine.
  - **Budget-exceeded alert** — fires at most once per UTC day, the first time the day's spend
    reaches `alerts.budget.thresholdUsd` (not presence-suppressed — spend matters even at the keyboard).
  - **Presence-aware suppression** — best-effort via `CLAUDE_CLIENT_PRESENCE_FILE` mtime.
  - **OS notifications** — injection-safe `osascript` (macOS) / `notify-send` (Linux); headless is a
    no-op; `CC_ALERT_DRYRUN=1` logs instead of firing. Alert state persists to the config dir
    (`CC_CONFIG_DIR` override), never to the read-only `~/.claude`.

### Changed
- Package renamed to the scoped **`@shubhamparashar/cc-orchestrator`** for npm distribution (the
  unscoped name was already taken); added `publishConfig.access: "public"`.
- `/api/cost/rollup` and the budget alert now share one `costRollup()` helper in `server.mjs`.

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
- **Cost-over-time modal** — checks `res.ok` and renders from the guarded `buckets` local, so a failed
  rollup request now shows a clean "could not load: HTTP …" message instead of throwing
  `Cannot read properties of undefined (reading 'length')` on any response without a `buckets` array.

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

[1.3.0]: https://github.com/shubhamparashar/cc-orchestrator/releases/tag/v1.3.0
[1.2.1]: https://github.com/shubhamparashar/cc-orchestrator/releases/tag/v1.2.1
[1.2.0]: https://github.com/shubhamparashar/cc-orchestrator/releases/tag/v1.2.0
[1.1.0]: https://github.com/shubhamparashar/cc-orchestrator/releases/tag/v1.1.0
[1.0.0]: https://github.com/shubhamparashar/cc-orchestrator/releases/tag/v1.0.0
