# Claude Code Session Orchestrator — Phase-1 Report

Audited on this machine (Claude Code v2.1.170, macOS, node v20.19.5) on 2026-06-12,
before any feature code was written.

## 0. Audit findings (what actually exists here)

| Source | Location | What it gives us | Verified |
|---|---|---|---|
| CLI transcripts | `~/.claude/projects/<sanitized-cwd>/<uuid>.jsonl` (7 project dirs, 56 files; worktrees get own dirs) | Full history. Record types seen: `user`, `assistant`, `progress`, `system`, `queue-operation`, `file-history-snapshot`, `last-prompt`, `custom-title`, `ai-title`, `pr-link`, `attachment`, `mode`. Assistant records carry `message.usage` (input + cache_read + cache_creation tokens → context %), `message.model`; records carry `cwd`, `gitBranch`, `sessionId`, `timestamp`. | ✅ |
| Live-process registry | `~/.claude/sessions/<pid>.json` | `{pid, sessionId, cwd, startedAt, version, kind, entrypoint}`. Entrypoints observed: `claude-desktop`, `claude-vscode`. pid-liveness check = authoritative **running** signal. 8 alive right now. | ✅ |
| Background tasks | `~/.claude/tasks/<uuid>/N.json` | Per-session task lists (subject, status, blockedBy). | ✅ |
| Desktop session metadata | `~/Library/Application Support/Claude/claude-code-sessions/<org>/<user>/local_<uuid>.json` | **Plain JSON, not LevelDB.** `{cliSessionId, title, cwd, model (incl. "[1m]" marker), effort, permissionMode, isArchived, prNumber, lastActivityAt}`. `cliSessionId` joins 1:1 to the JSONL transcript. | ✅ |
| FleetView MCP (in-session) | `list_sessions`, `search_session_transcripts`, `send_message`, `archive_session`, `request_directory` | Works, but **session-scoped** (callable only from inside a CCD session). `list_sessions` lacks branch/context-%/last-messages. `send_message` **always prompts the user and is unavailable in auto/bypass mode** → it is a human-confirmed handoff channel, not an automation transport. | ✅ |
| Native CLI control | `--remote-control [name]`, `--remote-control-session-name-prefix`, `-r/--resume <id>`, `-c`, `--fork-session`, `--from-pr`, `-p --output-format/--input-format stream-json`, `--model`, `--effort`, `-n/--name`, `--no-session-persistence` | All present in v2.1.170 help. | ✅ |
| `/handoff` skill | `~/.claude/skills/handoff/SKILL.md` | Exists; writes a handoff doc to OS temp dir. Base for F3. | ✅ |
| Hooks | settings.json `hooks` (SessionStart, UserPromptSubmit, PreCompact, Stop, …) | Native harness feature. Base for F3/F4 triggers. | ✅ |
| `claude` on this machine | zsh **alias** → `~/.claude/local/claude` (`.zshrc:109`); nvm copy also on PATH | Shim must override the alias (a PATH shim alone would lose to the alias). | ✅ |

**Key discovery:** Desktop-launched Claude Code sessions are already first-class citizens of the
CLI data plane — they register live pids with `entrypoint=claude-desktop` and write standard JSONL.
The Electron storage is only needed for nice titles / PR state / archived flags, and those live in
plain `local_*.json` files. So "Desktop best-effort coverage" costs ~40 lines of JSON reading,
not an IndexedDB excavation.

## 1. Build-vs-reuse matrix

| Capability | Reuse (exists) | Build (thin glue only) |
|---|---|---|
| F1: enumerate sessions | JSONL files + `~/.claude/sessions` pid registry + Desktop `local_*.json` | Scanner that joins the three sources (no new storage) |
| F1: status running/idle/waiting | pid registry (alive = open) | Heuristic: alive+recent-write→running; alive+last-turn-assistant→waiting-on-input; dead→idle; Desktop `isArchived`→archived |
| F1: context % | `message.usage` in transcripts; `[1m]` window marker in Desktop metadata | Sum + divide |
| F1: last user/asst message, repo/branch, title | All in transcript records (`custom-title`/`ai-title`) + Desktop title | Tail-parse |
| F1: live refresh | — | `fs.watch` + SSE (stdlib) |
| F2: remote control channel | **Native `--remote-control`** (claude.ai Remote Control) | 40-line shim that injects the flag for interactive launches (opt-out `CLAUDE_NO_RC=1`) |
| F2: attach to a session | **Native `claude --resume <id>`** | One osascript to open it in Terminal |
| F2: send prompt / steer | **Native `claude -p --resume <id>`** (headless continue, persists to same session) | Spawn + job tracking; surface returned session_id (resume of a *concurrently open* session forks — caveat shown in UI) |
| F2: fork | **Native `--fork-session`** | Flag pass-through |
| F2: pause | — (no public IPC into a foreign interactive TTY) | Kill only jobs *we* spawned; out of scope for foreign interactive sessions (documented) |
| F2: cross-session messaging | **FleetView `send_message`** for human-confirmed handoffs from inside CCD sessions | Nothing — don't rebuild; it's deliberately human-gated |
| F3: handoff content | **`/handoff` skill** | Evolve into `/context` + hook wiring (phase 2) |
| F3: triggers | **Native hooks** (SessionStart/UserPromptSubmit/PreCompact/Stop) | Hook scripts (phase 2) |
| F4: transcript search | **FleetView `search_session_transcripts`** (in-session, substring) | Index over `context.md` + ranking + ~70 % trigger (phase 2) |

Verdict: every hard capability already exists. The orchestrator is a **read-only join + a UI + CLI spawns**.

## 2. Local vs web — recommendation

**Local-first: a zero-dependency localhost web UI (Node 20 stdlib, binds 127.0.0.1), launched on the Mac.**

- All three data sources and the `claude` binary are local files/processes; a hosted web app would need an agent on the Mac anyway.
- A localhost page beats a Tauri/menu-bar app for slice 1: no build toolchain, no signing, instant iteration; a menu-bar wrapper can be added later (phase 2+) without changing the server.
- Remote access later = Tailscale to the same localhost port, not a rewrite.

## 3. Architecture sketch

```
~/.claude/projects/**/*.jsonl  ─┐  (read-only)
~/.claude/sessions/*.json      ─┼─► scanner (lib/scan|live|desktop) ─► GET /api/sessions
~/Library/…/local_*.json       ─┘             fs.watch ────────────► SSE /api/events ─► browser UI
                                                                             │ actions
claude CLI (alias→shim adds --remote-control) ◄── spawn -p --resume/--fork ──┘
                                                  osascript "Terminal: claude --resume <id>"
```

Components: `server.mjs` (http+SSE+jobs), `lib/scan.mjs` (transcript tail-parser),
`lib/live.mjs` (pid registry), `lib/desktop.mjs` (Desktop join), `lib/actions.mjs`
(spawn claude / Terminal attach), `public/index.html` (UI), `bin/claude-shim` + installer.
Transcripts are never written, only read.

## 4. Phased plan

- **Slice 1 (this delivery, F1+F2):** scanner + localhost UI with live refresh; status, context %, last messages, PR links; actions: attach-in-Terminal, send-prompt (headless resume), fork; `claude` shim defaulting `--remote-control` on with `CLAUDE_NO_RC=1` opt-out.
- **Slice 2 (F1 polish):** task-list (`~/.claude/tasks`) surfacing, per-repo grouping, archived view, menu-bar wrapper if wanted.
- **Phase 2 (F3):** evolve `/handoff` → rolling `context.md` per session via SessionStart/UserPromptSubmit/PreCompact/Stop hooks; curation (shrink, not append) enforced by the skill prompt schema {goal, key files, decisions, state, next step}.
- **Phase 2 (F4):** index `context.md` files (+ titles); rank keyword-first (embeddings optional later, `claude-fable-5` for summarize/rank jobs per model policy); triggers: SessionStart hook (offer relevant prior session) and context-% ≥ 70 % (PreCompact/usage check) → offer inject / `--resume` / `--fork-session`.

## 5. Open questions (defaults taken so work could proceed)

1. **One Mac or multi-machine?** Assumed one Mac. Multi-machine later = run the server per-Mac + Tailscale; no design change needed now.
2. **Read-only transcripts?** Confirmed in design: the orchestrator never writes to `~/.claude` or the Electron storage.
3. **Desktop coverage effort?** Resolved by audit: near-zero cost via `local_*.json` + the shared CLI data plane — included in slice 1. Claude.ai web/mobile chats are not local and stay out of scope.
4. **NEW — shim scope:** the shim only affects terminal launches (Desktop/VS Code spawn their own binary directly and never see the shell alias). Acceptable?
5. **NEW — steering caveat:** headless `--resume` of a session that is *also open interactively* creates a fork rather than injecting into the live TTY (no public IPC). The UI surfaces the returned session id so forks are visible. For live sessions, native Remote Control (claude.ai) is the steering channel — that's exactly what the shim turns on by default.

---

## Phase 2 — context sharing + chat launcher (F3 + F4)

Built on the hardened Phase 1 base. New modules are read-only over the three protected stores
(`~/.claude/projects`, `~/.claude/sessions`, Desktop Electron) and write only to the
orchestrator's own `~/.claude/contexts/` and the additively-merged hooks block in
`~/.claude/settings.json`.

### Components added

| File | Role |
|---|---|
| `lib/rank.mjs` | Pure lexical ranker (title/tags > goal > repo > body, recency + same-repo boosts). No model calls, sub-ms. Shared by hooks + server. |
| `lib/contextStore.mjs` | Context `.md` read/write (atomic tmp+rename), frontmatter parse, `index.json` rebuild, per-session state files. Strict session-uuid gate on every path. |
| `hooks/session-start.mjs` | Injects `session-id` + context path. |
| `hooks/ctx-update.mjs` | Stop + PreCompact → spawn generator **detached**, exit 0. Recursion guard + debounce + size gate. |
| `hooks/ctx-prompt.mjs` | UserPromptSubmit → relevant-prior-sessions block + once-per-session 70% warning. Lexical only, fail-open. |
| `jobs/ctx-generate.mjs` | Dialogue-only tail (≤30 KB) → `claude -p` (haiku-4-5, no persistence; default-model fallback) → context.md → index rebuild. |
| `jobs/backfill-contexts.mjs` | Opt-in backfill (quota cost; never auto-runs). |
| `jobs/rebuild-index.mjs` | Rebuild index after a manual `/context` write. |
| `lib/actions.mjs` (+) | `shq()` shell-quoting, `runInTerminal`, `buildLaunchCommand`, `launchInTerminal`. |
| `server.mjs` (+) | `GET /api/related`, `GET /api/context/<id>`, `POST /api/launch`; `hasContext` flag on sessions. |
| `public/index.html` | Rewritten: modern dark UI, hero chat launcher (⌘K), context.md viewer modal. Phase-1 behaviors preserved. |
| `~/.claude/skills/context/SKILL.md` | Manual high-fidelity `/context` variant. |

### Design choices

- **Hooks never block a turn.** Hot paths do stat/tail/score only; the model runs in a detached,
  unref'd child. Every hook is fail-open and guards on `CC_CTX_JOB` as its first statement.
- **New chat reads the context file itself** (`claude "Read <path>…, then: <prompt>"`) instead of
  the orchestrator inlining transcript text — both quoting-safe and token-cheap.
- **Ranking is lexical, not embedding-based** — it runs inside hooks and per keystroke, so it must
  be free and <100 ms. Embeddings can be added later behind the same `lib/rank.mjs` interface.

### Verification (this delivery)

- Hooks: simulated stdin for recursion guard (instant exit), fail-open on garbage, Stop debounce
  (no spawn on tiny transcript), 70% warning fired once on a real 1m-window transcript (computed 82%).
- Generator: stub-binary smoke test end-to-end (hook → detached job → context.md → index), then
  one real `claude-fable-5` run on this session's transcript (20 s, produced a clean 5-section file).
- Server: `/api/related` ranks correctly; `/api/context` rejects traversal (`..%2F…` → invalid id);
  `/api/launch` dry-run proven inert against `$()`/backticks/quotes injection in the prompt.
- UI: preview panel — launcher ranking, context modal (Context + Related tabs), new-chat command
  construction; fixed one grid-item overflow in the match list. Phase-1 SSE/visibility/banner intact.
- An adversarial multi-agent review over the full Phase-2 surface was run before sign-off.

---

## Per-session cost calculator

Adds lifetime API-cost accounting per session, computed from the same transcripts the
dashboard already reads — no new data source, still read-only over `~/.claude`.

### Components

| File | Role |
|---|---|
| `lib/pricing.mjs` | USD-per-1M-token table (input/output per model; current models flat-priced across 1M — no long-context premium). Cache tiers: read 0.1×, write-5m 1.25×, write-1h 2.0× of base input. `loadPricing()` merges `~/.claude/contexts/pricing.json` over defaults; `rateFor()` strips the `[1m]` marker and prefix-matches dated ids; `costSummary()` returns `{totalUsd, byModel[], pricedKnown}`. |
| `lib/cost.mjs` | `sessionUsageByModel()` sums every assistant turn's usage per model across the whole transcript (cumulative). Substring-prefilters `"usage"` lines, splits cache_creation into 5m/1h tiers, excludes `<synthetic>` placeholders, caches on `(size, mtime)`. |
| `server.mjs` | `attachCost()` (bounded `mapLimit` concurrency 8) sets `s.cost` in the cached scan; `GET /api/pricing`. |
| `public/index.html` | Gold per-card cost badge with per-model tooltip; header total = Σ raw `totalUsd`. |

### Pricing source

Rates taken from the Claude API reference (consulted rather than recalled): Fable 5
$10/$50, Opus 4.x $5/$25, Sonnet 4.6 $3/$15, Haiku 4.5 $1/$5 per 1M in/out. Confirmed
there is **no >200K long-context premium** on the current models, so a single rate per
model is correct.

### Verification

- Unit math exact: Fable 1M across every tier = $93.50; Opus 200k-in + 50k-out = $2.25;
  unknown model → `pricedKnown:false`, contributes $0.
- Real data: 57/57 sessions priced, **$24,711 lifetime** total; 0 unpriced once
  `<synthetic>` is excluded; per-model breakdown surfaces (e.g. a $2,396 session split
  across opus-4-7/4-6/fable-5).
- Perf: cold scan ~1.1 s (reads all transcripts once), ~9 ms warm (cost cache hit) —
  consistent with the digest-cache model; no regression to steady-state refresh.
- Confirmed top-level `usage.*` is the per-message total (equals `Σ iterations[]`), so
  reading top-level only does not double-count.
- An adversarial multi-agent review was run over the cost code before sign-off.

---

## Phone access (remote control)

Remote phone access over a private transport, gated by a token. Server still binds
`127.0.0.1`; transcripts stay read-only.

### Transport audit (in priority order)

| Option | Status on this machine | Decision |
|---|---|---|
| Tailscale serve | **Not installed** (no CLI, no `/Applications/Tailscale.app`) | `phone-link.sh` built + reviewed; prints the `brew install --cask tailscale` one-liner when absent. End-to-end against a real tailnet is unverified (no Tailscale here). |
| LAN (`CC_LAN=1`) | Verified end-to-end from the Mac | Opt-in only; binds 0.0.0.0, allowlists the Mac's own LAN IP/hostname. |
| Funnel / ngrok / cloudflared | — | Excluded by design (no public-internet exposure). |

### Components

| File | Role |
|---|---|
| `lib/auth.mjs` | Token (32-byte, chmod 600), `isLocalRequest` (loopback socket + no proxy headers + loopback Host), cookie helpers, 10/min/IP failed-auth limiter, Host allowlist (loopback + LAN + `hosts` file, 2s cache), `remoteLink`. |
| `server.mjs` | Auth gate (loopback tokenless; remote needs cookie; `/login?key=` exchange; X-CC on remote POST), `/api/phone-link`, static `/manifest.json` + `/icon.svg`, LAN binding. |
| `public/index.html` | 📱 phone modal, mobile CSS, PWA meta, X-CC on POSTs, "(on Mac)" hints. |
| `phone-link.sh` | Tailscale serve setup + allowlist wiring; graceful when absent. |
| `install-launchagent.sh` | Opt-in LaunchAgent (RunAtLoad+KeepAlive), `plutil -lint` gated. |

### Key security decision

Tailscale serve proxies from `127.0.0.1`, so a loopback-socket check alone can't tell a
real local request from a proxied phone request. `isLocalRequest` therefore also requires
the **absence** of `Tailscale-User-Login` / `X-Forwarded-For` and a loopback `Host` — so any
proxied or LAN request takes the token-required path even though its socket is loopback.

### Verification

Full auth matrix passed via curl (loopback 200; spoofed-Host 403; remote no-token 401;
bad-token 401; `?key=` login → 302 + `HttpOnly; SameSite=Strict` cookie; valid cookie 200;
POST without X-CC 403; POST with X-CC 200; Tailscale-proxied no-token 401; `Secure` set over
https; rate-limit trips at 10/min/IP). Mobile layout verified at 390×844 (no overflow,
bottom-sheet dialogs, phone modal). plist passes `plutil -lint`. An adversarial multi-agent
security review was run over the auth/transport/allowlist surface before sign-off.

## Open questions (phase-2 / phone)

- **Tailscale not installed here** — `phone-link.sh` is logic-reviewed but its real-tailnet
  path (DNSName parse, `tailscale serve`, host pickup) is unverified until Tailscale is set up.
- **PWA icon is SVG only** — iOS prefers a PNG `apple-touch-icon`; the SVG degrades gracefully
  but a rasterized PNG would look sharper on the home screen.
- **LAN IP at boot** — computed once at server start; if the Mac's IP changes, restart (or the
  LaunchAgent's KeepAlive picks it up on the next bounce).

### Security review outcome (phone access)

A 31-agent adversarial review (5 dimensions, 2 skeptics/finding) confirmed 6 issues
(refuted 7); all fixed and re-verified:

- **CRITICAL** — the failed-auth rate limiter keyed on `clientIp` = the *first*
  `X-Forwarded-For` hop, which is client-supplied (proxies append the real peer). An
  attacker could rotate it per request to evade the 10/min cap and brute-force the token.
  Fixed: a `rateLimitKey()` that uses `Tailscale-User-Login` when present, else the *last*
  XFF hop (the proxy-appended real peer), else the socket address; the failures Map is now
  bounded. Verified: rotating the spoofed first hop now hits 429 (the constant real peer is
  the key).
- **MEDIUM** — `start.sh` / `install-launchagent.sh` killed *any* listener on the port;
  now only kill a PID whose argv references this checkout's `server.mjs`, else error out.
- **MEDIUM** — `phone-link.sh` printed a teardown command (`serve --https=443 off`) that
  doesn't undo a `--bg` serve; now prints `tailscale serve reset`, and the `serve` call is
  error-guarded so a failure doesn't leave a half-configured state.
- **LOW** — `remoteLink()` now rejects non-http(s) URLs from a hand-edited `remote.json`
  (closes a `javascript:` self-XSS in the modal's "Open" link).
- **LOW** — `phone-link.sh` chmods the config dir to 700 and `remote.json`/`hosts` to 600;
  `getToken()` self-heals loose perms on a pre-existing dir/token.
