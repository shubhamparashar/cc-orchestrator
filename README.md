# cc-orchestrator

Local-first control plane over all Claude Code sessions on this Mac.
Read-only over `~/.claude` and the Claude Desktop storage — it never writes to either.

See [REPORT.md](REPORT.md) for the build-vs-reuse audit, architecture, and phased plan.

## Demo

> _Demo GIF coming soon — a ~10s capture of the status board plus a cost / prompt-history modal._

<!-- To add it: record a short screen capture, save it as docs/demo.gif (use a placeholder repo with
     no real session titles/costs, since the board shows live data), and replace the line above with:
     ![cc-orchestrator — status-bucketed board with live cost and health](docs/demo.gif) -->

## Quickstart

```sh
git clone <repo> && cd cc-orchestrator
node server.mjs          # → http://127.0.0.1:7433
```

Requires **Node ≥ 20** (no npm install — zero dependencies). Open the URL in your browser.
Optional: `npm i -g .` to get the `cc-orchestrator` / `cc-doctor` / `cc-install-hooks` commands;
`./install-launchagent.sh` to run it always-on; `./phone-link.sh` for private phone access over
Tailscale. See [SECURITY.md](SECURITY.md) for the trust model (loopback is unauthenticated; LAN is
plaintext — prefer Tailscale).

## Onboarding (`doctor` + hooks)

```sh
node bin/cc-doctor        # preflight: Node, claude on PATH, port, dirs, hooks, perms
node bin/cc-install-hooks # wire the Phase-2 context hooks into ~/.claude/settings.json
```

- **`cc-doctor`** prints grouped PASS / WARN / FAIL with a fix for each, and exits non-zero only on
  a blocking FAIL (Node < 20, no `claude`, port in use, config dir unwritable). Run it first if the
  dashboard is empty or live refresh seems dead. It also WARNs when an already-running always-on
  process is serving an older build than the code on disk (restart it to load new routes).
- **`cc-install-hooks`** does the additive `~/.claude/settings.json` merge that turns on the rolling
  per-session `context.md`, related-session surfacing, and the 70%-context warning — the features a
  fresh install otherwise ships *without*. It backs up your settings first, is idempotent (re-run
  safe), preserves any existing hooks, and reverses with `cc-install-hooks --uninstall`. This is the
  one place the tool writes outside its own config; transcripts are never written. Open a **new**
  Claude Code session afterwards for the hooks to take effect.

## Troubleshooting

Run `node bin/cc-doctor` first — it diagnoses most of the below and prints a fix for each.

- **Dashboard is empty / "no sessions".** The dashboard reads `~/.claude/projects` — you need at
  least one Claude Code session on this Mac. `cc-doctor` warns if that directory is missing or empty.
- **Cards don't live-update (refresh seems dead).** Live refresh uses recursive `fs.watch`, which
  needs **Node ≥ 20** (older Node fails silently). Check `node -v`; `cc-doctor` flags this as a FAIL.
  Recursive watch is unsupported on Linux — cc-orchestrator is Mac-only for v1.
- **Missing context features** (no `context.md`, related sessions, or 70%-context warning). The
  hooks aren't installed — run `node bin/cc-install-hooks`, then open a **new** Claude Code session.
- **"Port in use" / server won't start.** Something already holds the port (often a previous
  instance). Run on another port — `PORT=7456 node server.mjs` — or stop the other process.
  `cc-doctor` reports whether the port is free.
- **A button does nothing / console shows `404 {"error":"not found"}` after updating.** The
  always-on process serves `public/index.html` fresh from disk but freezes its HTTP route table at
  startup, so after a `git pull` that adds endpoints it keeps serving the new UI while 404-ing the
  new routes. **Restart the always-on process after pulling new code** so the new routes load:
    - macOS: `launchctl kickstart -k gui/$(id -u)/com.cc-orchestrator`
    - Linux: `systemctl --user restart cc-orchestrator.service`

  The dashboard now detects this itself (it compares the running commit to the commit on disk via
  `/api/version`) and raises an amber *"Dashboard code updated — restart…"* banner; `cc-doctor` also
  flags a stale running build under **WARN**.
- **Can't reach it from your phone.** See [Phone access](#phone-access-remote-control): use
  Tailscale, and open the tokenized one-tap link once. LAN mode is plaintext — prefer Tailscale.
- **Where are the logs?** `node bin/cc-logs` (last 200 lines; `-f` to follow). Rotating, `0600`,
  under `~/.config/cc-orchestrator/logs/`.
- **Something broke.** Click **Report a bug** in the footer — it opens a GitHub issue prefilled with
  a sanitized environment summary (no paths, tokens, or PII) and the last error. Nothing is sent
  automatically; you review and post it yourself.

## Run

```sh
node server.mjs          # http://127.0.0.1:7433  (PORT=… to change)
```

No dependencies; needs **Node ≥ 20**. Live refresh uses recursive `fs.watch` on macOS (best on
Node ≥ 20); on Linux, where recursive `fs.watch` isn't available, it falls back to a short poll.

## Platforms (macOS / Linux)

macOS is the primary platform; **Linux is supported** for the core dashboard. The read-only
scanners, cost/health/history, auth, and HTTP/SSE are pure Node and run on both.

- **Live refresh** — recursive `fs.watch` on macOS; a ~3 s poll on Linux (reuses the scanner's
  `(size,mtime)` cache, so a tick is cheap). The per-file in-app transcript nudge is macOS-only;
  the session list still refreshes on Linux.
- **Always-on** — `./install-launchagent.sh` on macOS (LaunchAgent); **`./install-systemd-user.sh`**
  on Linux (a `systemd --user` unit; `loginctl enable-linger $USER` to keep it up while logged out).
- **Open in Terminal** — `osascript`/Terminal.app on macOS; `x-terminal-emulator` /
  `gnome-terminal` / `konsole` / `xterm` on Linux (the first one found). Headless box with no
  terminal → the action returns the command to copy instead.
- **Claude Desktop metadata** (titles / PR state) — read from `~/Library/Application Support/Claude`
  on macOS and `~/.config/Claude` on Linux (**unverified** — fail-open; CLI sessions work regardless).
- **macOS-only conveniences:** the `bin/crc` and `bin/claude-shim` zsh launchers. Not needed to run
  the dashboard; on Linux launch sessions normally and open the dashboard in your browser.

CI runs the test suite + a smoke boot on both macOS and Linux (`.github/workflows/ci.yml`).

## What it shows (F1)

Every session across every repo/worktree: title, repo @ branch, entrypoint
(desktop / vscode / terminal), status, context-window % (1m-window aware),
last user + assistant message, PR links, live refresh (fs.watch → SSE).

Status semantics:

- `running` — process alive and the transcript was written to in the last 90 s
- `waiting-on-input` — process alive, Claude's turn is finished
- `open-idle` — process alive, no recent turn
- `idle` — no live process; `archived` — archived in Claude Desktop

## Actions (F2)

- **Attach in Terminal** — opens Terminal.app running `claude --resume <id>` in the session's cwd.
- **Send prompt** — headless `claude -p --resume <id> "<text>"` (default permission mode; never
  `--dangerously-skip-permissions`). If the target session is *also* open interactively, the CLI
  forks to a new session id — the job result shows the id so forks are visible.
- **Fork + prompt** — same with `--fork-session`.
- **Stop** — kills a job the orchestrator spawned. Foreign interactive sessions can't be paused
  (no public IPC); steer those via native Remote Control (claude.ai), which the shim enables.

## Shim (remote control by default)

```sh
bin/install-shim.sh      # appends a marked alias block to ~/.zshrc (backup kept)
```

After that, every interactive terminal `claude` launch gets `--remote-control`.

- Opt out per-invocation: `CLAUDE_NO_RC=1 claude`
- Never injected for: `-p/--print`, `--help/--version`, subcommands (`mcp`, `config`, …), non-TTY.
- Scope: terminal launches only — Desktop/VS Code spawn the binary directly and bypass shell aliases.
- Uninstall: delete the marked block from `~/.zshrc`.
- Debug: `CLAUDE_SHIM_DRYRUN=1 claude …` prints the resolved command.

## Phase 2 — context sharing, chat launcher (F3 + F4)

Rolling per-session context files let a new session pick up where an old one left off, and the
dashboard's chat launcher routes a task to the most relevant prior session.

### Rolling context files (F3)

Each session gets `~/.claude/contexts/<session-uuid>.md` — frontmatter (`session, repo, cwd,
title, tags, updated`) plus five curated sections (Goal / Key files / Decisions / State / Next
step), capped at ~50 lines. The generator **merges and shrinks**, never appends.

Driven by hooks (merged additively into `~/.claude/settings.json`):

- **SessionStart** → injects `session-id: <uuid>` (so the agent knows its own id) and the context path if one exists.
- **Stop** → if the transcript is ≥50 KB and the context file is >5 min old, spawns the generator **detached** and returns immediately.
- **PreCompact** → always regenerates before context is compacted away.
- **UserPromptSubmit** → on the first real prompt, surfaces relevant prior sessions; once per session, warns at ≥70% context-window usage and suggests `/context` + fork.

All hooks are **fail-open** (any error exits 0 silently) and never call a model on the hot path —
the model work happens only in the detached job. The recursion guard (`CC_CTX_JOB=1` on the
spawned process) stops the generator's own `claude` call from re-triggering the hooks.

- `jobs/ctx-generate.mjs` — dialogue-only tail (≤30 KB, never raw transcript) → `claude -p --model claude-fable-5 --effort low --no-session-persistence` → write context.md → rebuild `index.json`.
- `jobs/backfill-contexts.mjs --limit N` — **opt-in** backfill (costs quota; never auto-runs).
- `jobs/rebuild-index.mjs` — rebuild the index from context files on disk.
- `/context` skill (`~/.claude/skills/context/SKILL.md`) — manual high-fidelity variant: the agent writes its own context.md from live conversation knowledge.

### Index + retrieval (F4)

`~/.claude/contexts/index.json` (`{sessionId, repo, cwd, title, tags, goal, updated}`) is rebuilt
by the generator. `lib/rank.mjs` is a **pure lexical** scorer (weighted title/tags > goal > repo >
body, recency + same-repo boosts) — no model calls, sub-millisecond, shared by the hooks and the
server.

### Chat launcher (dashboard hero)

The hero search box (⌘K) debounces ~150 ms and hits `GET /api/related?q=…`, ranking the context
index **and** live session titles. Per match:

- **Open chat** → `/api/attach` (Terminal, `claude --resume`).
- **Continue here** → `/api/send` (headless resume).
- **New chat w/ context** → `POST /api/launch` opens Terminal running `claude "Read <context.md path> for prior context, then: <your prompt>"`. The new session reads the context file itself — quoting-safe and token-cheap; transcripts are never inlined.

No match → plain new chat in a chosen repo (dropdown of known cwds). Session cards with a context
file show a **context** chip → a modal that renders the file and has a **Related** tab
(rank.mjs against that session's goal) plus a copy-`--resume`-command button.

New endpoints: `GET /api/related`, `GET /api/context/<uuid>`, `POST /api/launch` (with `dry:true`
returning the command string). All behind the same Host-header check; `/api/context` is gated by a
strict session-uuid allowlist (no path traversal).

## Phone access (remote control)

Open the dashboard on your phone and do everything except the two Terminal actions
(those open on your Mac, and are labelled "opens on your Mac"). The server keeps binding
`127.0.0.1`; remote access is brokered by a transport and gated by a token.

### Transport (pick one)

1. **Tailscale (recommended)** — private, TLS for free, reachable only from your tailnet:
   ```sh
   ./phone-link.sh          # runs `tailscale serve --bg http://127.0.0.1:7433`
   ```
   It auto-detects your `https://<machine>.<tailnet>.ts.net` URL, adds that host to the
   allowlist (`~/.config/cc-orchestrator/hosts`), and the server picks it up within ~2s.
   If Tailscale isn't installed it prints the one-liner:
   `brew install --cask tailscale && open -a Tailscale`.
2. **LAN (opt-in)** — same Wi-Fi only:
   ```sh
   CC_LAN=1 ./start.sh      # binds 0.0.0.0; prints http://<mac-lan-ip>:7433
   ```
   The allowlist then accepts the Mac's own LAN IP/hostname (computed at boot) and keeps
   rejecting everything else.

No funnel / ngrok / cloudflared — the server is never exposed to the public internet.

### Auth

- A random 32-byte token is generated on first remote access → `~/.config/cc-orchestrator/token` (chmod 600).
- **Loopback stays tokenless** (local UX unchanged). Every non-loopback request needs the token.
- One-tap: open `<url>/login?key=<token>` once → sets an `HttpOnly; SameSite=Strict` cookie
  (plus `Secure` over Tailscale HTTPS) → redirects to `/`. The 401 page is a clean token form.
- POSTs additionally require an `X-CC: 1` header (set by the frontend) as a CSRF belt; SSE needs only the cookie.
- Failed auth is rate-limited to 10/min/IP.

### Onboarding panel

The header's **📱 phone** button opens a modal with the active remote URL, the **tokenized
one-tap link**, and Copy/Open buttons. `GET /api/phone-link` returns `{url, mode}` (the token
and one-tap link are included only for loopback callers). QR is intentionally omitted — a
correct encoder is >300 lines and unverifiable without a scanner; copy/AirDrop the link instead.

### Always-on

So the link works whenever you pick up your phone:
```sh
./install-launchagent.sh           # localhost only
CC_LAN=1 ./install-launchagent.sh  # also bind LAN
```
Writes `~/Library/LaunchAgents/com.cc-orchestrator.plist` (RunAtLoad + KeepAlive), validates
it with `plutil -lint`, and loads it. Uninstall is printed on success
(`launchctl bootout gui/$(id -u)/com.cc-orchestrator && rm <plist>`).

### Mobile UI

Responsive under 700px (full-width cards, ≥44px touch targets, condensed header, bottom-sheet
dialogs), plus a web-app manifest + theme-color + apple-mobile-web-app meta and an SVG icon so
add-to-home-screen feels native (no service worker).

## Per-session cost calculator

Every session card shows its **lifetime API cost** in gold (with a per-model
breakdown on hover), and the header shows total spend across all sessions.

- `lib/pricing.mjs` — USD-per-1M-token table (input + output per model). Current Claude
  models are flat-priced across the full 1M context window (no long-context premium), so
  one rate per model is correct. Cache economics: reads 0.1×, writes 1.25× (5-min) / 2×
  (1-hour) of the base input rate. Override or extend via `~/.claude/contexts/pricing.json`
  (same shape, merged over the defaults); `GET /api/pricing` returns the active table.
- `lib/cost.mjs` — sums every assistant turn's token usage per model across the **whole**
  transcript (cumulative, not the tail), cached on `(size, mtime)` so a refresh re-reads
  only changed files. `<synthetic>` harness placeholders are excluded (not billable).

Cost is computed inside the cached scan: cold first read ~1 s for all sessions, ~10 ms
warm. The figure is cumulative lifetime spend for the session, broken down by model
(input / output / cache-read / cache-write tiers). If a transcript uses a model missing
from the table, that session's total marks itself `*` and the model shows as `unpriced` —
add it to `pricing.json`.

### Token frugality (design requirement)

All orchestrator-internal model jobs use `claude-fable-5 --effort low --no-session-persistence` —
never Opus. Models never see raw transcripts (dialogue text only, ≤30 KB tail). Ranking and search
are purely lexical so they're free and fast enough to run inside hooks and on every keystroke.
Context is shared by injecting the ≤50-line context.md (or just its path) — never transcript chunks.
