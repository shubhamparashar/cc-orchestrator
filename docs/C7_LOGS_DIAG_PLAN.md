# cc-orchestrator — C7: rotating logs + consent-gated issue prefill

Implements `docs/PRODUCT_IDEAS.md §C7`: replace the unbounded `/tmp/cc-orch.log` with a
size-rotated, leveled log under `~/.config/cc-orchestrator/logs/` + a `cc-logs` command, and add a
**consent-gated** "Report a bug" prefill (sanitized env + last error → a GitHub `issues/new` URL —
no backend, no auto-send, no PII). Backend telemetry is explicitly out of scope.

Principles held: zero runtime npm deps · no build · Mac-first · token-frugal. Tests: Node stdlib only.

## Contract

- **`lib/logger.mjs`** — `log.info/warn/error`: append to `${CC_LOG_DIR or ~/.config/cc-orchestrator/logs}/cc-orch.log`
  (mode `0600`), echo to console (so the LaunchAgent stdout redirect / tty still see it), and
  size-rotate (`rotate(file,{maxBytes:2MB,keep:5})` — pure, testable). Logging never throws.
- **`lib/diag.mjs`** — `sanitizedEnv()` (app/node/platform/os/arch — no cwd/home/user/token);
  `scrub(text)` (collapse `/Users|home/<name>` → `~`, redact bare username, then the shared
  `redact()` secret scrubber); `issueUrl({title,error})` → prefilled `issues/new` URL.
- **`server.mjs`** — `console.*` → `log.*`; `process.on('uncaughtException')` logs then exits,
  `unhandledRejection` logs + records `lastError`; request 5xx records `lastError` + logs.
  `GET /api/diag` → `{env, issueUrl}`, with the error **only for loopback callers**.
- **`bin/cc-logs`** — print last N lines (`-n`) or follow (`-f`); **`bin/cc-doctor`** unchanged but
  the token-perms check already complements this. `package.json` gains the `cc-logs` bin.
- **`public/index.html`** — a footer "Report a bug ↗" link, upgraded from a plain `issues/new`
  fallback to the prefilled URL via `loadDiag()`; refreshed on a load failure.

## Build log — all exit tests green (branch `c7-logs-diag`)

| Step | Result |
|---|---|
| every `.mjs` | ✅ `node --check` clean (26 files) |
| logger+diag units | ✅ `test/logger.test.mjs` + `test/diag.test.mjs`; full suite **40/40** |
| runtime | ✅ booted server: `/api/diag` → sanitized env + `issues/new` URL (no home leak); rotating log written at `0600`; `cc-logs` reads it |
| UI | ✅ footer link → prefilled GitHub issue (env in body), opens new tab, no console errors (Claude Preview MCP) |

## Adversarial review (1 agent, privacy/leak surface) → fixes applied
- **HIGH** — log file was `0644`; now `0600` (owner-only, like the token). The local log keeps raw
  stacks (debugging fidelity) — only the *externally-shared* issue URL is scrubbed. The request-line
  log uses `url.pathname` (no query string), so the `/login?key=` token is never logged.
- **HIGH** — `lastError` is process-global; on a shared Tailscale/LAN dashboard that could bleed one
  viewer's error into another's report. Fixed: the prefilled error is included **only for loopback**
  callers (env-only for remote), mirroring `/api/phone-link`.
- **MED** — `scrub()` only collapsed an exact `homedir()` match, leaking the username via
  case-variant / non-prefix paths. Fixed: generic `/Users|home/<name>` collapse + bare-username
  redaction.
- **Accepted:** `os.release()` (standard in bug reports, not PII); bare 32-hex/base64 secrets in a
  stack (the error now only reaches the local user's own review; UI says "common secrets are
  redacted"). The app's own 64-hex token is redacted bare and `key=`-prefixed.
