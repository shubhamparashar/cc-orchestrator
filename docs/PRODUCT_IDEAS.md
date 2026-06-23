# cc-orchestrator — Feature Discovery & Productization Audit

_Product/engineering roadmap. Evidence-backed against the real code and the real `~/.claude`
data on this machine (Claude Code v2.1.181, macOS, Node v20.19.5), 2026-06-22._

Every idea carries: **Impact** (H/M/L) · **Effort** (S/M/L) · **Principle-fit** (does it break
zero-dep / no-build / single-vanilla-file / local-first / read-only / token-frugal?) ·
**Native?** (does Claude Code / its CLI / FleetView already do this?).

---

## ⚠️ The one strategic fact that reframes everything

**Claude Code now ships a native fleet view.** `claude agents` (research preview, docs at
code.claude.com/docs/en/agent-view) is a terminal dashboard that lists background sessions across
projects, bucketed Needs-input / Working / Ready-for-review / Done, with PR-check colors and
Haiku one-line summaries. It is scriptable: **verified on this machine**, `claude agents --json`
returns live sessions. But the JSON it returns here is *thin*:

```json
[{ "pid": 15579, "cwd": ".../cc-orchestrator", "kind": "interactive",
   "startedAt": 1782133784671, "sessionId": "e826ecb8-..." }]
```

That is essentially the `~/.claude/sessions/<pid>.json` registry cc-orchestrator already reads —
**no branch, no context-%, no cost, no last-message, no PR state, only live sessions.** Native
Remote Control (claude.ai/mobile) also covers live single-session steering and per-session push.

**Implication for the roadmap (this is the spine of every recommendation below):**

- The flat "list sessions with a status dot" wedge is being absorbed by native. Do **not** invest
  there as a differentiator.
- cc-orchestrator's durable wedge is the **union native doesn't provide**: a *local, read-only,
  web+phone* aggregate monitor with **per-session lifetime cost**, **context-% / branch /
  last-message enrichment**, **free BM25 history search**, and **deep transcript-derived signals**
  (progress, health, errors, triage) over **all** sessions — interactive *and* Desktop, live *and*
  historical. The native TUI agent-view (background sessions only) and per-session RC don't cover
  this union.
- Correction to in-flight assumptions: a prior research pass claimed the `claude-shim`/`crc`
  launchers were broken (RC flags rejected). **Verified false** — `--fork-session` is accepted
  (a genuinely unknown flag returns `error: unknown option`; this didn't), and
  `remoteControlAtStartup: true` is already in `~/.claude/settings.json`. The shim isn't broken;
  it's partly *redundant* (the settings toggle already enables RC), which is a simplification
  opportunity, not a bug.

---

## 1. Top 5 recommendations (do these next)

**1. Transcript-derived "what is it doing & is it healthy" signals (Section A cluster).**
The highest-leverage, lowest-risk work. The scanner already opens every transcript but stops at
`usage`/`model` — it ignores `tool_use`, `tool_result.is_error`, `TodoWrite`, `turn_duration`, and
`compact_boundary`. Surfacing these turns the dashboard from "running/idle dot" into "running a
TodoWrite plan, 33/38 done, 4.1% tool-error rate, compacted twice at ~143k tokens, 38 active
minutes" — exactly the depth native's thin JSON omits. All read-only, zero new infra, fits every
principle. Impact **H**, effort **S–M**, principle-fit **clean**, native: **no**.

**2. A status-bucketed triage board with "Waiting on you" as a first-class signal (Section B).**
The single most convergent UX across Devin/Cursor/Copilot/Conductor *and* native `claude agents`:
group by Waiting-on-you / Working / Idle / Done instead of a flat list, and make "needs your input"
a filterable, badge-able, push-able state. cc-orchestrator already computes `waiting-on-input`
(scan.mjs:125) — this is mostly re-organizing existing data into the layout users now expect, in
the web+phone form factor native's TUI lacks. Impact **H**, effort **S**, principle-fit **clean**,
native: **partial (TUI only, not web/phone, not over interactive+Desktop)**.

**3. Cost rollups + budget alert + sub-agent cost attribution (Section A/B).**
The cost calculator is cc-orchestrator's most uniquely valuable, least-likely-to-be-absorbed piece
($24.7k lifetime surfaced per REPORT.md). Add day/week/month rollups + per-model breakdown + CSV/
JSON export (ccusage parity, all read-only), a **read-only budget-exceeded alert** (no native hook
exists for this), and close the known accuracy gap by indexing the **387 nested sub-agent
transcripts** (5.4× the corpus the scanner can't currently see — these hold the ~0.1–1.3% spend
`cost.mjs` documents as unattributed). Impact **H**, effort **S** (rollups) to **L** (sub-agent
indexing), principle-fit **clean**, native: **`/usage` is in-session only; no cross-session table,
no budget event**.

**4. The v1.0 productization bar — make it safe & pleasant for a *stranger* to install.**
Today there is no `package.json`, no tests, no CI, no `LICENSE`, no installer, no `doctor`, and the
hooks are *documented but never shipped as a script* — so a new user gets the dashboard with none
of the Phase-2 context features and no signal why. Plus README says Node ≥18 but recursive
`fs.watch` (server.mjs:473) makes it **≥20** (and silently no-ops on Linux). This is the gate
between "author's personal tool" and "product." See Section C for the full checklist. Impact **H**,
effort **M**, principle-fit **clean** (npm `package.json` with empty deps doesn't break zero-dep).

**5. Reposition the wedge & de-risk against native.**
Not a feature — a positioning + de-bloat pass. Explicitly **kill the flat-list-as-selling-point**;
lean the README/landing into "local read-only web+phone monitor with cost + history + health."
**Simplify the RC shim** (feature-detect or rely on the already-set `remoteControlAtStartup`
instead of always injecting `--remote-control`), and **consume `claude agents --json`** as a
corroborating liveness source where present. Impact **M** (strategic), effort **S**, principle-fit
**clean**, native: this is *about* native.

---

## Section A — Quick wins from already-available data (ranked)

The headline: **the highest-value data is already inside the transcripts the scanner opens every
refresh.** `lib/scan.mjs` collects `cwd/gitBranch/title/model/lastUser/lastAssistant/usedTokens/
prNumbers` and early-breaks; it never parses tool calls, tool results, todos, turn durations, or
compaction events. `lib/desktop.mjs` even *reads* `effort` and `permissionMode` and then throws
them away (desktop.mjs:52-53). These are "free" features — a few more record/block types in the
existing tail walk.

| # | Feature | Value (one line) | Data source (verified counts) | Impact | Effort | Principle | Native? |
|---|---|---|---|---|---|---|---|
| A1 | **TodoWrite progress bar** | "33/38 done · 4 in progress" + current task list per session | `TodoWrite.input.todos` in transcript, or the cleaner `~/.claude/tasks/<uuid>/N.json` mirror (clean sessionId=dirname join; real `blocks`/`blockedBy` DAG; 38 task files / 4 sessions, 33 done / 5 pending here) | H | S | clean | no |
| A2 | **Tool-mix + error-rate health gauge** | bar of tool usage + "4.1% errors, Bash = 74% of them" → spot stuck retry-loops | `tool_use.name` + `tool_result.is_error` joined on `tool_use_id` (17,702 calls / 725 errors in sample; Bash 60% of calls) | H | S–M | clean | no |
| A3 | **Real active-time + hour-of-day heatmap** | honest wall-clock active minutes (not first↔last, which spans *months* on resumed sessions) | `system`/`turn_duration`.`durationMs` (1,246 records; e.g. a session spanning Mar→Jun where last−first is meaningless) | M | S–M | clean | no |
| A4 | **Compaction / health markers** | "compacted 2× · last at ~143k tokens" badge → handoff/split candidate | `system`/`compact_boundary`.`compactMetadata` (49 corpus-wide: 40 auto / 9 manual) + `api_error` retry storms (504 records) | M | S | clean | partial (PreCompact hook exists; not surfaced) |
| A5 | **Sub-agent / skill / MCP attribution** | "spawned 12 sub-agents (Explore×64) · used signoz/postgres MCP · ran /review /handoff" | `Agent.input.subagent_type` (105 spawns, note tool is **`Agent`** not `Task`), `attributionSkill`, `attributionMcpServer/Tool` (all per-turn fields already in records) | M | S–M | clean | no |
| A6 | **Cross-session prompt palette** | searchable log of every prompt you typed (incl. slash commands), jump-to-session | `~/.claude/history.jsonl` (`display`+`project`+`sessionId`, joins to session list; rotating ~93-entry window) — index with the existing free `lib/rank.mjs` | M | S | clean | no |
| A7 | **Surface fields already parsed-then-dropped** | model badge, reasoning effort, permission mode, session uptime on the card | `model`/`contextWindow`/`usedTokens`/`sizeBytes` shipped by API but UI-ignored; `effort`/`permissionMode` read+dropped in desktop.mjs:52-53; `startedAt`/`kind` dropped in live.mjs:36-37 | M | S | clean | no (RC shows effort in-session only) |
| A8 | **Status chips** | CC version + "update available", approval mode, "3 MCPs need re-auth" | `.last-update-result.json` (2.1.181), `config.json` (`approvalMode:auto`), `mcp-needs-auth-cache.json` (n8n/GDrive/Notion) — one tiny file read each | L | S | clean | no |
| A9 | **Index the 387 nested sub-agent transcripts** | 5.4× searchable corpus + recover unattributed sub-agent cost | `projects/**/subagents/**/agent-*.jsonl` + `journal.jsonl` (different schema: `type:started/result`) — 387 nested vs 71 top-level files | M | L | clean (new walk, still read-only) | no |

**Dead ends — checked and not worth chasing (don't let these reappear in a future audit):**

- **`telemetry/`** (43 files, 2,250 events, 4.9 MB) — the richest-*looking* source is the
  emptiest: **zero numeric payloads** (no durations/tokens/latencies), only categorical pings, and
  it **embeds PII** (email, org/account/device ids). Don't surface it.
- **`file-history/`** (33 MB, 4,209 files) — **no hash→path manifest**; only 20/41 dirs join a
  transcript; snapshots already mirrored as `file-history-snapshot` records inside transcripts. At
  best a disk-cleanup metric.
- **`session-env/`** (563 dirs) — empty 0-byte markers. Useful only as an "all UUIDs ever" roster.
- **`shell-snapshots/`** (6 files) — near-identical zsh dumps, no session key. Prune target.
- **`plans/`** (3 files) — **no session id anywhere** (grep = 0 UUID matches); can't join.
- **`stats-cache.json`** — prebuilt `dailyActivity`/`hourCounts`/`longestSession`, but **stale
  (last computed 2026-02-18, ~4 months)** and `costUSD` always 0. Use only as a one-time backfill
  seed, clearly labeled; otherwise recompute from transcripts (already done for cost).

---

## Section B — Differentiated features, by persona (ranked)

Legend as above. "Native?" reflects the verified state (see top of doc).

### B-P1 · Solo power-user (many sessions across repos on one Mac) — the strongest fit

| Feature | Value | Impact | Effort | Principle | Native? |
|---|---|---|---|---|---|
| **Status-bucketed triage board** | Waiting-on-you / Working / Idle / Done columns over the existing scanner | H | S | clean | partial — `claude agents` does this in TUI, **not web/phone, not over interactive+Desktop, thin JSON** |
| **Cost rollups + per-model breakdown + CSV/JSON export** | day/week/month spend; the one analytic native won't absorb soon | H | S | clean | no (`/usage` in-session only) |
| **Keyboard-first nav (Raycast/Linear bar)** | extend ⌘K into full keyboard navigation of the board (j/k, actions) | M | M | clean (vanilla JS) | no |
| **Risk/triage ranking** | rank sessions by blast-radius (large diff, destructive Bash, many files touched) — Codex-style, read from transcripts | M | M | clean (read-only) | no |
| **Health/stuck detector** | flag sessions looping on the same error or idle-mid-turn (ties A2/A3/A4) | M | M | clean | no |

### B-P2 · Team lead (visibility across a team's agents) — **breaks local-first; flag as a fork**

| Feature | Value | Impact | Effort | Principle | Native? |
|---|---|---|---|---|---|
| Cross-teammate fleet view | one board across many devs' Macs | H | L | **❌ breaks local-first + read-only-of-your-own-~/.claude** — needs a per-Mac agent + a shared aggregator | partial (Slack `@Claude`, Channels) |

**Verdict: do not build for v1.** This is a *different product* (multi-tenant control plane), it
abandons the trust model that makes the tool credible, and it competes directly with Anthropic's
own org tooling. If ever pursued: per-Mac server that *pushes* a read-only summary to a shared
board, never reading others' raw transcripts — and state it as a deliberate architecture change.

### B-P3 · AFK / overnight agent runner — the best whitespace vs native's per-session push

| Feature | Value | Impact | Effort | Principle | Native? |
|---|---|---|---|---|---|
| **Fleet "N sessions waiting on you" digest push** | one aggregate notification with deep-links, vs native's per-session pings | H | M | clean (read-only detect + a notifier) | **no — native RC push is per-session only, no cross-fleet digest** |
| **Budget-exceeded alert** | "fleet spend crossed $X today" from JSONL cost | H | M | clean (alert, not a cap) | **no native budget hook** |
| **Presence-aware suppression** | don't notify when you're actively at the machine | M | S | clean | reuse native `CLAUDE_CLIENT_PRESENCE_FILE` (v2.1.181) — mirror it, don't reinvent |
| Per-session morning recap | overnight summary per session | M | S | clean | overlaps `/recap` + `context.md` — **extend existing, don't rebuild** |
| Auto-resume on rate-limit/idle | keep long runs going unattended | M | M | **⚠️ borderline — steering/writing crosses read-only**; not native (issue open) | defer / explicit tradeoff |

---

## Section C — Product-readiness checklist to ship

Grouped. Mac-only → cross-platform gaps called out explicitly. Everything here is *productization*,
not dashboard features.

### C1 · Distribution & install
- **Today:** `git clone` → `node server.mjs`, then four hand-run zsh scripts in README-order. No
  installer. **Effort to fix: M.**
- **Recommended primary — npm.** A minimal `package.json` (**empty `dependencies`** so zero-dep
  holds, `bin` entry, `engines:{node:">=20"}`) → `npx cc-orchestrator` / `npm i -g`. The `engines`
  gate fixes the Node-version footgun for free. No build step. **S–M, principle-clean.**
- **Recommended secondary — Homebrew formula** (`depends_on "node"`, `brew services` replaces the
  LaunchAgent script). Idiomatic for a Mac-only always-on tool; gives upgrade for free. **M.**
- **Defer — notarized `.app` / menu-bar.** Tauri (Rust toolchain) or Electron (~150 MB Chromium)
  both **break no-build and effectively zero-dep**, need a $99/yr signing cert + notarization. The
  localhost-page + Tailscale story already solves "open it anywhere." **L, breaks principles.**

### C2 · Cross-platform — **the biggest gap (Mac-only today)**
**~80% of the `.mjs` is portable** (`scan/live/cost/pricing/rank/contextStore/sessionIndex` +
HTTP/SSE — all `node:fs`/`path`/`os` over `homedir()`). **~20% is Mac glue.** Concrete blockers:

| Mac dependency | file:line | Linux | Windows | Effort |
|---|---|---|---|---|
| recursive `fs.watch` (live refresh) | server.mjs:473,475 | **throws on Linux** (`ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`) — needs walk+watch or poll; `watchSafe` silently swallows it so refresh just dies | works (recursive supported) | M (Linux) |
| Terminal attach via `osascript` | actions.mjs:118-141 | `gnome-terminal`/`x-terminal-emulator` (fragile, no single API) | `wt.exe` / `cmd /c start` | M each |
| Desktop metadata path `~/Library/Application Support/Claude/...` | desktop.mjs:5-11, server.mjs:475 | `~/.config/Claude/…`? **UNVERIFIED whether Desktop writes these off-Mac** (fails open → loses titles/PR/archived) | `%APPDATA%\Claude\…`? **UNVERIFIED** | S to switch path; **must verify** |
| LaunchAgent (`launchctl`, plist, `plutil`) | install-launchagent.sh | systemd user unit | Task Scheduler / Service | M each |
| `lsof`/`scutil`/`.local` mDNS | start.sh:10, crc:46, auth.mjs:166 | `ss`/`hostname`/Avahi | `netstat`/`hostname` | S each |
| `chmod 600` token perms | auth.mjs:16-41 | POSIX-fine | **ineffective on NTFS** — token-at-rest perms | S–M (Windows) |
| 6× `#!/bin/zsh` scripts | all `.sh`, `bin/crc`, `bin/claude-shim` | rewrite POSIX `sh`/bash | `.ps1`/`.cmd` | M |

**Linux ≈ M**, **Windows ≈ L** (no zsh, Service model, `wt.exe`, NTFS perms, path conventions).
Cross-platform breaks **no principle** but triples the OS-glue surface and needs CI on 3 runners
(none exists). **Recommendation: stay Mac-only for v1; Linux is the natural v2.**

### C3 · Onboarding & first-run
- **No first-run wizard, no `doctor`, no health check** (verified). Empty `~/.claude` → working-but-
  empty dashboard with no guidance.
- **Hooks are documented (README:64) but no script ships them** — a stranger gets the dashboard
  *without* context.md / related-sessions / 70%-warning and **no signal why.** This is the biggest
  onboarding hole. **Fix: a hook-installer that does the additive `settings.json` merge. M.**
- **Add a `doctor`/preflight:** Node ≥20? `claude` on PATH? `~/.claude` exists? hooks installed?
  port free? Plus a startup Node-version gate (fail loud, not silent). **M + S.**

### C4 · Settings / config UX
- All config is env-vars + hand-edited files, **no settings UI**, scattered across three locations:
  env (`PORT`, `CC_LAN`, `CLAUDE_NO_RC`, `CLAUDE_ORIG_BIN`, `CLAUDE_SHIM_DRYRUN`, `CC_CTX_*`,
  `CRC_PYBIN`), `~/.config/cc-orchestrator/{hosts,remote.json,token}`, and `~/.claude/contexts/
  pricing.json`. **Consolidate into one documented `~/.config/cc-orchestrator/config.json`** +
  a read-only "Settings/About" surface. A full settings *UI* edges into feature territory — keep
  v1 to a config file + docs. **M.**

### C5 · Security / trust model for *other people's* machines
The model is genuinely well-built **for the author's own Mac** (32-byte token, Host allowlist vs
DNS-rebinding, non-spoofable rate-limit key, CSRF `X-CC`, argv-not-interpolated osascript). New
risks when a *stranger* runs it:

| Risk | Where | Why worse for strangers | Fix | Effort |
|---|---|---|---|---|
| **Loopback = unauthenticated full control to spawn `claude`** | auth.mjs:58, server.mjs:319-322 | any local user/process/webpage hitting 127.0.0.1:7433 can run Claude in their repos (cost + code exec); the author understands this, a stranger won't | document loudly + opt-in `CC_REQUIRE_TOKEN_LOCAL=1` | S–M (breaks tokenless-local UX → opt-in) |
| **LAN mode sends token in plaintext HTTP** | README:120, server.mjs:24 | coffee-shop sniffer gets full control | strong warning; steer to Tailscale (free TLS); gate LAN behind explicit "I understand" | S–M |
| **Token never rotates / no revoke** | auth.mjs:25-43 | leaked one-tap link valid forever (30-day cookie) | `rotate-token` command | S |
| No TLS of its own | — | relies entirely on Tailscale | make Tailscale the documented-only remote path | S (docs) |

**Must-do before handing to non-experts:** a `SECURITY.md` stating "loopback is unauthenticated and
can run Claude; LAN is plaintext, prefer Tailscale," token rotation, and the opt-in local-token
gate. **Combined M.**

### C6 · Auto-update
None exists. **Recommend: rely on `brew upgrade` / `npm i -g @latest`** (zero new code,
principle-clean). Optionally a **passive** "newer version on GitHub" notice via `node:https`
(opt-out; mild local-first tension — make it opt-out). **S.** Don't build an auto-installer.

### C7 · Crash/error reporting + telemetry
- Logging is unstructured `console.*` → `/tmp/cc-orch.log` (no levels/rotation). **Move to
  `~/.config/cc-orchestrator/logs/` with rotation + a `logs` command. S.**
- **Consent-gated GitHub-issue prefill** on unhandled error (opens a prefilled `issues/new` URL with
  error + sanitized env; no auto-send, no PII, no backend). **S–M, principle-clean.**
- **Backend telemetry: skip entirely for v1.** A local-first tool that reads private transcripts and
  phones home is a trust-killer; the issue-prefill covers the real debugging need.

### C8 · Docs & support
README/REPORT are excellent for a *contributor*, weak for a first-time *installer*. Missing:
top-of-README quickstart, per-OS install, troubleshooting/FAQ ("dashboard empty," "live refresh
dead" = the Node<20/Linux watch issue, "port in use"), **SECURITY.md** (disclosure address +
trust model), **CONTRIBUTING.md** (+ the handoff convention), a **demo GIF** (a read-only dashboard
is highly screenshot-able — high ROI), CHANGELOG + git tags. **M; GIF+quickstart S.**

### C9 · Licensing
**No LICENSE exists.** Recommend **MIT** (maximally adoptable; the tool's only real value is
spreading) — or **Apache-2.0** if you want an explicit patent grant. Source-available/commercial
makes no sense (no defensible core). **Open question to verify (not legal advice):** redistributing
a tool that reads Claude Desktop's `Application Support` storage and auto-injects `--remote-control`
— check against Anthropic's current ToS / Claude Code license before publishing. Plausibly fine
(it's the user's own data, public flags), but **verify, don't assume.** Zero deps → clean
attribution surface. **S.**

### C10 · Monetization — be blunt
**Keep it free OSS (MIT).** No defensible moat (REPORT.md:45 itself: "a read-only join + a UI + CLI
spawns"), and native `claude agents` + Remote Control are absorbing the core use case. The only
speculative paid wedges — a team/cloud aggregation plane or org cost analytics — both require a
backend + sales motion the project isn't built for and break local-first. **Highest-value role: a
portfolio / community-goodwill piece** that demonstrates taste (the security review, token
frugality, zero-dep discipline). Don't contort it into a paid app.

---

## Section D — Non-goals / principle conflicts (what NOT to build, and why)

- **Don't rebuild the flat session list as a headline feature** — native `claude agents` does it.
  Compete on enrichment + web/phone + history + cost + health, not on "here are your sessions."
- **Don't build live single-session steering / a TTY bridge** — native Remote Control owns it
  (and it needs no inbound ports). Steering foreign interactive sessions has no public IPC anyway
  (REPORT.md:39). Keep the phone surface a *monitor*, not a second steering channel.
- **Don't build per-session "finished/needs-input" push** — native RC push does it. Build only the
  *aggregate* "N waiting on you" digest and the *budget* alert (the two gaps native leaves).
- **Don't build worktree/dispatch/background-execution** — `--bg`/`--worktree`/the supervisor are
  native; building them **breaks read-only**. State this as a deliberate boundary.
- **Don't build the team/multi-tenant control plane in v1** — **breaks local-first**; it's a
  different product competing with Anthropic's org tooling. (Section B-P2.)
- **Don't ship a `.app`/Electron/Tauri for v1** — **breaks no-build + zero-dep.** (Section C1.)
- **Don't add backend telemetry** — **breaks local-first** and the trust premise. (Section C7.)
- **Don't auto-resume/auto-steer unattended runs** — **crosses the read-only line**; defer or make
  it an explicit, loudly-flagged opt-in. (Section B-P3.)
- **Don't surface `telemetry/`** — no numeric value and it leaks PII. (Section A dead-ends.)
- **Don't trust loopback blindly when shipping to others** — keep it the default for solo-Mac UX,
  but ship the opt-in `CC_REQUIRE_TOKEN_LOCAL` and document the risk. (Section C5.)

---

## Definition of v1.0 (the minimum shippable bar)

> **v1.0 = the existing well-built Mac tool, made installable, honest, and licensed for a stranger:**
> a one-command install (`npx`/Homebrew) that also wires the hooks, a Node ≥20 gate + `doctor`
> preflight, a `LICENSE` (MIT) and `SECURITY.md` documenting the loopback-trust + LAN-plaintext
> model with token rotation, rotating local logs + consent-gated issue-prefill (no backend
> telemetry), and a quickstart + demo GIF — staying Mac-only, with at least the **status-bucketed
> board (B)** and the **TodoWrite progress + tool-error health signals (A1/A2)** landed so the first
> thing a new user sees is the differentiated value native doesn't provide.

**v1.0 checklist:** `LICENSE` (MIT) · `package.json` (empty deps, `bin`, `engines>=20`) ·
Node-version gate + README fix (≥18→≥20) · one-command installer **incl. hook merge** · `doctor` ·
`SECURITY.md` + `CC_REQUIRE_TOKEN_LOCAL` opt-in + token rotation · rotating logs + issue-prefill ·
quickstart + troubleshooting + demo GIF · `brew upgrade`/`npm` update path · status-bucketed board ·
A1/A2 health signals. **Deferred to v2+:** Linux/Windows, `.app`/menu-bar, team/multi-user/cloud,
settings UI, sub-agent-transcript indexing.
