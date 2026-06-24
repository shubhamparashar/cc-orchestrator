# cc-orchestrator — Linux support (cross-platform)

Implements `docs/PRODUCT_IDEAS.md §C2` — make the Mac-only tool run on Linux by isolating the
platform glue behind a single gate, while keeping macOS behavior byte-for-byte. ~80% of the code
(read-only scanners, cost/health/history, auth, HTTP/SSE) was already portable.

**Verification constraint (load-bearing):** this was built on macOS, which cannot boot a Linux
runtime. macOS no-regression is verified locally; **Linux is verified by CI** (`ubuntu-latest`:
`node --test` + `node --check` + a smoke boot). Shell-script Linux branches are verified by
inspection + an adversarial review (can't be run here).

## Decisions

- **File watcher** (`lib/watch.mjs`) — recursive `fs.watch` on macOS/Windows (unchanged); on Linux,
  where recursive `fs.watch` throws, a **~3 s poll calling `scheduleRefresh`**, which reuses the
  scanner's `(size,mtime)` cache (cheap; a no-op when no SSE clients). Rejected mtime-diffing: a
  session *appending* to its `.jsonl` bumps the file mtime, not the parent dir's, so dir-mtime polls
  miss the common case; the cached full-scan poll is correct and simpler. The per-file in-app
  transcript nudge is macOS-only; the session list still refreshes on Linux.
- **Node ≥ 20 gate** kept as a baseline; message no longer claims recursive `fs.watch` is the reason.
- **Terminal attach** (`lib/actions.mjs`) — `osascript` on macOS; on Linux the first available of
  `x-terminal-emulator` / `gnome-terminal` / `konsole` / `xterm`, running `bash -lc <cmd>; exec bash`
  with the command as a **distinct argv element** (preserves the macOS no-injection guarantee — the
  `shq()`-escaped command is inert data). Headless box → returns the command to copy.
- **Desktop metadata** (`lib/desktop.mjs`) — `~/.config/Claude` on Linux (**UNVERIFIED**; fail-open).
- **Always-on** — `install-systemd-user.sh` (systemd `--user` unit) on Linux; `install-launchagent.sh`
  now refuses on non-macOS and points to it.
- **Scripts** — `start.sh` ported zsh→bash with portable listener/cwd detection (`lsof` on macOS,
  `ss` + `/proc/<pid>/cwd` on Linux); PID-kill still fails *closed* (only kills our `server.mjs`).
- **CI** (`.github/workflows/ci.yml`) — macOS + Linux matrix; the actual Linux verification.

Out of scope (documented Mac-only conveniences): the `bin/crc` / `bin/claude-shim` zsh launchers —
not needed to run the dashboard.

## Files
| New | Changed |
|---|---|
| `lib/platform.mjs`, `lib/watch.mjs`, `test/watch.test.mjs` | `server.mjs` (watch wiring, gate msg) |
| `install-systemd-user.sh`, `.github/workflows/ci.yml` | `lib/actions.mjs`, `lib/desktop.mjs` |
| | `start.sh`, `install-launchagent.sh`, `README.md` |

## Exit tests
| Step | Result |
|---|---|
| every `.mjs` | ✅ `node --check` clean (25) |
| watch units | ✅ `test/watch.test.mjs` 3/3 (watch mode; forced-poll ticks then `stop()` halts); full suite **43/43** |
| macOS no-regression | ✅ booted: `live refresh: watch`, 81 sessions w/ tasks/health/effort, SSE `hello` |
| scripts | ✅ `bash -n start.sh install-systemd-user.sh`, `zsh -n install-launchagent.sh` |
| CI | ✅ `ci.yml` valid; macOS+Linux matrix → check + test + smoke boot (`/healthz`, `/api/sessions`, `/api/diag`) |
| Linux runtime | ⏳ verified by CI on first push (cannot boot Linux locally) |

## Adversarial review → fixes
A security/correctness review of the Linux glue confirmed the **terminal dispatch is injection-safe**
(shq + argv-element preserves the macOS guarantee even with attacker-controlled cwd/prompt), the
poll-timer lifecycle is clean, and desktop is fail-open. Fixed: `install-systemd-user.sh` `ExecStart`
now quotes paths (+ `WorkingDirectory`) so a repo path with spaces works; `start.sh` made the
`set -e`-fragile `&&`-sleep an explicit `if`. Documented best-effort: `ss` PID extraction can't
always read the owner pid (fails *safe* — a missed kill just makes the duplicate start fail its
healthcheck loudly, never kills the wrong process).
