# cc-orchestrator — C3 Onboarding Plan

Implements `docs/PRODUCT_IDEAS.md §C3` — the biggest v1.0 onboarding hole: the Phase-2 context
hooks ship in `hooks/` but nothing installs them, and there's no `doctor` to explain an empty or
broken dashboard. Two deliverables: a **hook-merge installer** and a **`doctor` preflight**.

Hard principles held: zero runtime npm deps · no build step · Mac-first · token-frugal. Tests use
Node stdlib only (`node:test`/`node:assert`).

**Sanctioned-write note:** the READ-ONLY principle covers `~/.claude/projects`, `sessions`, and the
Desktop storage (transcripts are never written). The **additive `~/.claude/settings.json` hook
merge is the one blessed exception** (REPORT.md Phase 2: hooks are "additively-merged into
`~/.claude/settings.json`"). The installer NEVER touches transcripts and NEVER tests against the
real `~/.claude` — all tests use a throwaway `HOME`.

---

## 1. Frozen contract — `lib/onboarding.mjs` (load-bearing)

Pure functions (no fs) are unit-testable; the I/O wrappers compose them.

```js
// The 4 events → repo hook script + timeout (verified against the live settings.json schema).
hookSpecs(repoRoot) -> [
  { event:'SessionStart',     script:`${repoRoot}/hooks/session-start.mjs`, timeout:10 },
  { event:'UserPromptSubmit', script:`${repoRoot}/hooks/ctx-prompt.mjs`,    timeout:10 },
  { event:'Stop',             script:`${repoRoot}/hooks/ctx-update.mjs`,    timeout:10 },
  { event:'PreCompact',       script:`${repoRoot}/hooks/ctx-update.mjs`,    timeout:15 },
]

// settings.json hooks schema (verified live):
//   hooks: { <Event>: [ { hooks:[ { type:'command', command:'<node> <abs script>', timeout:N } ] } ] }

// Ownership test: an entry is "ours" if its command contains one of our hook script
// basenames under a /hooks/ segment — robust to repo relocation, unlikely to collide.
OURS_RE = /\/hooks\/(session-start|ctx-prompt|ctx-update)\.mjs\b/

// PURE merge — additive, idempotent. Preserves every other key and any foreign hooks
// for the same event. nodePath defaults to process.execPath.
mergeHooks(settings, { nodePath, repoRoot }) -> { settings, changed, added:[event] }
// PURE uninstall — removes only entries matching OURS_RE; drops now-empty event arrays /
// empty hooks{} so the file returns to its prior shape.
unmergeHooks(settings, { }) -> { settings, changed, removed:[event] }
// PURE status — which of the 4 events have one of our commands wired.
hooksStatus(settings) -> { installed:[event], missing:[event] }

// I/O: read settings.json (→ {} if missing; throw on malformed so we never clobber),
// back up to settings.json.bak.cc-orchestrator, atomic tmp+rename, chmod 600.
installHooks({ home, repoRoot, nodePath, uninstall=false })
  -> { action:'installed'|'removed'|'noop', added, removed, settingsPath, backupPath }

// Doctor: each check → { id, label, status:'pass'|'warn'|'fail', detail, fix? }.
runChecks({ home, repoRoot, port }) -> [check]
```

### Doctor checks (FAIL blocks, WARN degrades)
| id | check | sev |
|---|---|---|
| node | Node ≥ 20 (`process.versions.node`) | FAIL |
| claude | `~/.claude/local/claude` exists, else `command -v claude` | FAIL |
| port | dashboard PORT free (probe `net.createServer`, not `lsof`) | FAIL |
| configdir | `~/.config/cc-orchestrator` exists/creatable + writable | FAIL |
| claudedir | `~/.claude/projects` exists & non-empty | WARN |
| hooks | all 4 hooks installed (`hooksStatus`) → "run cc-install-hooks" | WARN |
| tokenperms | token file mode `600` (if present) | WARN |
| desktop | Desktop metadata dir present | WARN |
| fswatch | recursive `fs.watch` works | WARN |
| sessions | `~/.claude/sessions` readable | WARN |

---

## 2. Tracks (disjoint files)
| Track | Owns (NEW unless noted) | Chokepoint? |
|---|---|---|
| Core | `lib/onboarding.mjs`, `test/onboarding.test.mjs` | no |
| Bins | `bin/cc-install-hooks`, `bin/cc-doctor` (`#!/usr/bin/env node`, thin → lib/onboarding) | no |
| INT | `package.json` (bin entries), `README.md` (onboarding), `docs/C3_ONBOARDING_PLAN.md` | yes |

Built directly (one cohesive, security-sensitive unit), then adversarially reviewed for merge safety.

## 3. Per-step exit criteria (done only when its test passes)
| Step | Exit test |
|---|---|
| every `.mjs` | `node --check` passes |
| merge units | `node --test test/onboarding.test.mjs` green: empty→4 added (abs paths, `process.execPath`); unrelated keys preserved; foreign same-event hook preserved; re-run→noop (no dupes); uninstall→only ours removed, shape restored; malformed JSON→throws, no write |
| install e2e | throwaway `HOME`: `cc-install-hooks` writes 4 events + backup; re-run noop; `--uninstall` clean |
| doctor e2e | real run prints grouped PASS/WARN/FAIL; throwaway HOME w/o hooks→WARN hooks; simulated Node<20→FAIL node + exit 1; busy port→FAIL port |
| docs | README onboarding section documents both commands + uninstall |

## 4. Build log

Built on branch `c3-onboarding`. All exit tests green:

| Step | Result |
|---|---|
| every `.mjs` | ✅ `node --check` clean on 23 files |
| merge units | ✅ `test/onboarding.test.mjs` 12/12; full suite **31/31** |
| install e2e | ✅ throwaway HOME: 4 events written (quoted, `process.execPath`), foreign keys preserved, backup made; re-run → "nothing to do"; `--uninstall` removes only ours, `hooks` block dropped |
| doctor e2e | ✅ real run → all PASS, exit 0; throwaway HOME → hooks WARN; Node<20 sim → FAIL node + exit 1; busy port → FAIL port |
| docs | ✅ README "Onboarding" section + `package.json` bin entries (`cc-doctor`, `cc-install-hooks`) |

**Adversarial review (2 agents) → fixes applied before sign-off:**
- HIGH: backup no longer clobbered on a second mutating run (keep the pristine first backup).
- HIGH: relocating the checkout no longer duplicates hooks — merge strips any of our entries (by
  `OURS_RE`, path-independent) then re-adds the current one, converging to one live command/event.
- HIGH: `doctor` port probe binds the **same host** server.mjs uses (`0.0.0.0` under `CC_LAN`, else
  `127.0.0.1`) — no false "free" in LAN mode.
- MED: malformed hooks shapes (non-array event/`hooks`, non-object `hooks`) now refuse with a clear
  message and **no write**, instead of a `TypeError` or silent data loss.
- LOW: hook commands quote both paths (spaces-safe); tmp file cleaned up on write failure.

**Accepted low-risk:** `OURS_RE` matches our hook **basenames** under any `/hooks/` segment
(relocation-robust + recognizes the already-installed markerless entries on this machine). A foreign
tool shipping `session-start.mjs`/`ctx-prompt.mjs`/`ctx-update.mjs` under its own `/hooks/` dir would
be mis-claimed on uninstall — unlikely given the specific names; a marker key was rejected because it
wouldn't recognize existing markerless installs.
