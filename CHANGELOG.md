# Changelog

All notable changes to cc-orchestrator. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); this project uses [SemVer](https://semver.org/).

## [1.8.2] — 2026-06-28

### Fixed
- **Status filter now collapses the board to just that bucket.** Picking a status in
  the filter (e.g. `running`) used to keep rendering all four bucket columns and their
  headers, with the non-matching ones showing "none". It now drops the bucketed chrome
  entirely and lays the matching sessions out as a plain responsive card grid — only
  the sessions you filtered for, no other headers or empty columns. Clearing the filter
  restores the full board. Keyboard selection still works in the filtered view.
- **"Open on your phone" dialog can be scrolled and closed.** Expanding the "First time?
  Set up Tailscale" disclosure made the dialog grow past the screen; with the dialog
  clipped (`overflow:hidden`) and no max height, the content — including the Close
  button — was cut off, and on a phone there's no Esc key, so there was no way out.
  Dialogs now cap at `92vh` with a scrollable body (`max-height` + `overflow-y:auto`),
  keeping the footer reachable, and a tap on the backdrop dismisses any dialog — the
  natural close gesture on a phone. Applies to every dialog, not just the phone panel.

## [1.8.1] — 2026-06-28

### Fixed
- **Sub-agents are now findable by a file they only touched in a tool call.** A
  sub-agent's search body is a frequency-capped term bag, so a filename mentioned
  just once (a lone `Read`/`Edit`) could be evicted from it — leaving the sub-agent
  unsearchable by that file. Sub-agent docs now carry the same unconditionally-kept
  `work` field session docs already have — file basenames, tool names, leading bash
  command verbs, and spawned sub-agent types, harvested from the transcript's
  `tool_use` blocks and scored at the ranker's existing `work` boost (no ranker
  change). The harvest logic moved into a shared `lib/work.mjs` (depending only on the
  leaf `lib/scan.mjs`) so the session index and the sub-agent index share it without
  an import cycle.

## [1.8.0] — 2026-06-27

### Added
- **Homebrew formula + contributing guide (C1 distribution).** `Formula/cc-orchestrator.rb`
  installs the zero-dep server (`depends_on "node"`), wires the `cc-orchestrator` /
  `cc-doctor` / `cc-install-hooks` / `cc-logs` commands, and ships a `brew services`
  definition so always-on is just `brew services start cc-orchestrator` (replacing the
  hand-run LaunchAgent script). `CONTRIBUTING.md` documents dev setup, the throwaway-port
  workflow, tests, code style, the security-sensitive surfaces, and the release/handoff
  conventions; the README gains a Homebrew quickstart line.

## [1.7.0] — 2026-06-27

### Added
- **Keyboard-first board navigation (B-P1).** Drive the dashboard without the mouse:
  `j`/`k` (or `↓`/`↑`) move a selection ring between sessions, `Enter` opens the chat,
  `c` opens context, `s` sends a prompt, `f` forks, `t` attaches a terminal (local only),
  `/` focuses the filter, `Esc` clears the selection, and `?` toggles a shortcuts
  cheatsheet (also reachable from the new `⌨` header button). `⌘`/`Ctrl`+`K` still opens
  the search launcher. Single-key shortcuts are ignored while typing in a field or while a
  dialog is open, and the selection ring survives the periodic board refresh.

## [1.6.0] — 2026-06-27

### Added
- **Triage signals: blast radius + stuck detection (B-P1).** Each session card now
  surfaces, from `lib/health.mjs`'s existing whole-transcript pass:
  - a **`✎ N files` metric** in the health line — distinct files touched by
    `Edit`/`Write`/`MultiEdit`/`NotebookEdit`;
  - a red **`⚠ N destructive`** badge when the session ran high-blast-radius shell
    commands (`git reset --hard`, `git push --force`, `git clean -f`, `drop`/`truncate`,
    `dd of=`, `mkfs`, `chmod -R 777`, and `rm -rf` of root/home/sudo) — shown by
    **category only**, never the raw command (which can carry a credential). Routine
    recursive `rm` of build artifacts / scoped paths is intentionally not flagged, and
    matching is per command-segment so `rm -rf dist && cd ..` isn't a false positive;
  - an amber **`⟳ stuck`** badge when a session hits a run of consecutive tool errors
    (≥4 in a row) — the "looping on the same error" signal.
  All read-only, derived from data already scanned; aggregation keys are
  prototype-pollution guarded.

## [1.5.0] — 2026-06-27

### Added
- **Per-session attribution: which skills, MCP servers, and sub-agent types a session
  used (A5).** Each card now shows a `📜` badge listing the distinct skills run and a
  `🔌` badge listing the MCP servers used (busiest-first, with the full `name×count`
  breakdown in the tooltip), and the `⛬ subagents` tooltip gains a by-type breakdown
  (e.g. `Explore×4`). `lib/health.mjs` derives these in its existing whole-transcript
  pass from `attributionSkill`, `attributionMcpServer`, and the `Agent` tool's
  `subagent_type` — guarding object keys so a crafted transcript can't use a JS-magic
  key (`__proto__`/`constructor`/`prototype`/inherited methods) to corrupt the
  aggregation maps. Surfaced on `s.health` in `/api/sessions`; no new endpoint.

## [1.4.0] — 2026-06-27

### Added
- **Global status chips in the header (A8).** A new chip row beside the session counts
  shows the installed Claude Code version, the configured approval mode, and how many MCP
  servers are flagged for re-auth (their names in the chip's tooltip). Read from three
  small `~/.claude` files — `.last-update-result.json`, `config.json`,
  `mcp-needs-auth-cache.json` — via a tolerant `lib/status.mjs` (a missing or malformed
  file degrades to "signal unavailable", never an error) and served at `GET /api/status`.
  No secret leaves the box: only the version, the approval-mode string, and MCP server
  names are exposed (never the per-server id/token), so the chips are safe to show on the
  authenticated phone dashboard too.
- **Compaction badge now shows where context filled up (A4).** The per-session
  "N× compact" badge gains a "· ~969k" suffix — the context size (pre-compaction tokens)
  at the most recent compaction — turning it into a sharper handoff/split signal.
  `lib/health.mjs` reads `compactMetadata.preTokens` from the last `compact_boundary`
  during its existing whole-transcript pass, correct across the incremental-append path.

## [1.3.8] — 2026-06-27

### Changed
- **Smaller session index, wider sub-agent search recall.** Each sub-agent search
  doc stored a raw ~4 KB tail of its most recent dialogue; the index is now built
  from a deduped significant-term bag over the agent's WHOLE dialogue (the same
  compression used for session prompt bodies, now a shared `termBag` helper). The
  sub-agent bodies — the bulk of the index — shrink ~50% (`index.json` ~32% smaller
  overall: 3.6 MB → 2.4 MB on a 581-sub-agent corpus), while recall *improves*: a
  term mentioned early in a long agent is now searchable instead of being lost with
  the old recent-only tail. Distinct vocabulary is kept over raw repetition (presence
  over frequency), so BM25F's IDF still weights the rare, high-signal terms. The index
  is rebuilt from transcripts on the next reindex, so no migration is needed.

## [1.3.7] — 2026-06-27

### Fixed
- **Two servers no longer clobber each other's session index.** `~/.claude/contexts/
  index.json` was a single shared file, so a second server on another port (e.g. a
  throwaway verify/dev instance) overwrote the primary's index on its reindex tick —
  surfacing as missing search hits until the next rebuild. The index is now namespaced
  by port (`indexFileForPort`): the default port keeps the legacy `index.json` name (no
  migration), every other port writes its own `index-<port>.json`. Port resolution is
  canonicalized with `Number()` to match the server's bind logic exactly, so a
  non-canonical `PORT` can't point the index at a file the server never reads.

## [1.3.6] — 2026-06-27

### Security
- **Broader secret redaction in the prompt palette and bug-report URL.** The
  `redact()` net (shared by `/api/history` and the consent-gated issue link) now
  also catches **Slack incoming-webhook URLs** (the `hooks.slack.com/services/…`
  path is collapsed, host kept), **Google OAuth `ya29.` access tokens**, and bare
  **`npm_` tokens** — common pasted credentials the previous shapes missed. The
  palette is reachable from a phone over Tailscale and the issue URL is meant to be
  pasted publicly, so these were real leak gaps. All three patterns are linear (no
  ReDoS) and tuned to avoid false positives (`npm_config` and a bare `ya29` survive).
  Verified end-to-end against the live `/api/history` endpoint. A wider audit of the
  remaining surfaces (OS-spawn, ReDoS, prototype pollution, path traversal,
  DNS-rebinding/CORS) found no exploitable issues.

## [1.3.5] — 2026-06-27

### Security
- **CSRF is now enforced on every state-changing request, including loopback.**
  The first-party `X-CC` header was previously required only for authenticated
  *remote* POSTs — loopback mutating requests were unguarded. A page the user
  visits can issue a "simple" cross-origin POST to `127.0.0.1:7433`, which would
  have reached `/api/send` (spawns `claude`) or `/api/attach` (opens a terminal).
  Every non-`GET`/`HEAD` request now requires `X-CC: 1` — a custom header a
  cross-origin form or simple fetch cannot set without a CORS preflight this
  server never answers — closing the drive-by vector.
- **`/api/send` and `/api/attach` now validate `sessionId` as a UUID.** A
  malformed `sessionId` previously reached the spawn/attach path; it is now
  rejected with `400` before any process is launched.
- **Prototype pollution via the transcript `model` field is blocked.** The
  attacker-controllable `model` value was used as an object key during cost
  accumulation, so `__proto__` / `constructor` / `prototype` could write onto
  `Object.prototype`. Those keys are now skipped across every accumulation path;
  real model ids are never these, so no genuine usage is dropped.
- **Auth identity hardening.** The rate-limit key trusts `X-Forwarded-For` only
  when the socket peer is loopback (a local reverse proxy such as Tailscale
  serve), so a direct LAN/remote peer can no longer rotate its `XFF` to evade the
  failed-auth limit — its socket address is the one identity it can't forge.
  Cookie parsing now tolerates a malformed `%`-escape instead of throwing, which
  in the pre-handler path would have left the request hanging.

## [1.3.4] — 2026-06-26

### Fixed
- **Exact filename/command search was diluted by generic-prefix matches.** The
  ranker credited partial matches in *both* prefix directions, so a short common
  token (e.g. `session`) credited a long specific query (`session-index.test.mjs`)
  — letting sessions that merely mention the generic word outrank the one that
  actually owns the exact file (a one-of-a-kind file ranked 8th instead of 1st).
  Prefix credit is now **forward-only**: a query still matches a longer token it
  prefixes (`scan` → `scan.mjs`, `signoz` → `signoz-dashboard`), but the reverse is
  dropped. A distinctive file/command now ranks its owning session first; common
  files correctly return all editing sessions, recency-ordered.

## [1.3.3] — 2026-06-26

### Fixed
- **The `work` field (v1.3.2) wasn't actually searched.** The related/search
  endpoint built its ranking docs without `work`, so a query for a file or command
  scored against an empty field — the work was indexed but unsearchable. Pass
  `work` through to the ranker.
- **Chained shell commands only captured their first verb.** `cd … && git … &&
  node …` recorded only `cd`. Each sub-command's verb is now captured (split on
  `&&` / `||` / `|` / `;` / newline) and junk tokens (variable assignments, quoted
  args) are skipped — so `git` / `launchctl` / `node` become findable and the field
  is cleaner.

## [1.3.2] — 2026-06-26

### Added
- **Search by the work you did, not just what you typed.** The index now harvests
  each session's "work" from its assistant `tool_use` blocks — the **files
  edited/read** (basenames like `cost.mjs`), **tools used**, **leading bash
  commands** (`git`, `yarn`, …), and **sub-agent types** spawned — into a dedicated
  repo-weighted `work` field. So "find the session where I touched `cost.mjs`" or
  "…where I ran the migration" now resolves, which prompt text alone couldn't.
  Deduped; harvested in the same incremental transcript pass (no extra read, no
  model); IDF keeps ubiquitous files (`package.json`) from dominating.

### Changed
- Raised the per-session distinct-term cap (800 → 1500) so even very large
  multi-task sessions never drop a term (well within the index's size budget).

## [1.3.1] — 2026-06-26

### Changed
- **Search now covers the whole session, not just the recent tail.** The Tier-1
  index body had been the most-recent ~4000 chars of prompts from only the last
  512 KB of a transcript, so earlier tasks in a long, multi-task session weren't
  findable by their content. It now harvests the significant terms from *every*
  user prompt across the full transcript, deduped with a small per-term frequency
  cap (a word used 50× collapses to 3) so a sprawling session indexes completely
  while staying small. Lexical only — no model call; the harvest is incremental
  (byte-offset resume, like the cost reader) so the growing live session stays
  cheap, and BM25F's IDF still weights the rare, high-signal terms at query time.

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

[1.3.4]: https://github.com/shubhamparashar/cc-orchestrator/releases/tag/v1.3.4
[1.3.3]: https://github.com/shubhamparashar/cc-orchestrator/releases/tag/v1.3.3
[1.3.2]: https://github.com/shubhamparashar/cc-orchestrator/releases/tag/v1.3.2
[1.3.1]: https://github.com/shubhamparashar/cc-orchestrator/releases/tag/v1.3.1
[1.3.0]: https://github.com/shubhamparashar/cc-orchestrator/releases/tag/v1.3.0
[1.2.1]: https://github.com/shubhamparashar/cc-orchestrator/releases/tag/v1.2.1
[1.2.0]: https://github.com/shubhamparashar/cc-orchestrator/releases/tag/v1.2.0
[1.1.0]: https://github.com/shubhamparashar/cc-orchestrator/releases/tag/v1.1.0
[1.0.0]: https://github.com/shubhamparashar/cc-orchestrator/releases/tag/v1.0.0
