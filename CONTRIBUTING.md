# Contributing to cc-orchestrator

Thanks for helping out. cc-orchestrator is a **zero-dependency, local-first, read-only**
dashboard over your Claude Code sessions. Those three properties are load-bearing — please
keep them intact (see [Non-negotiables](#non-negotiables)).

Design rationale lives in [`REPORT.md`](REPORT.md); usage in [`README.md`](README.md). Read
those before re-deriving anything.

## Prerequisites

- **Node ≥ 20.** That's the only requirement — there are **no npm dependencies** (`dependencies`
  in `package.json` is intentionally empty), so there is **no `npm install` and no build step**.

## Running it locally

```bash
git clone https://github.com/shubhamparashar/cc-orchestrator
cd cc-orchestrator
node server.mjs            # → http://127.0.0.1:7433
```

The server reads `~/.claude/` (projects, sessions, contexts). It only ever **reads** your
transcripts — it never writes to them.

### Exercise a change without disturbing your real dashboard

If you run the always-on server (LaunchAgent / `brew services`), it owns port **7433**. When
testing a change, boot a **throwaway** instance on another port with an isolated `HOME` so you
never touch your live board or its session index:

```bash
TMP=$(mktemp -d); mkdir -p "$TMP/.claude/projects" "$TMP/logs"
HOME="$TMP" CC_LOG_DIR="$TMP/logs" PORT=7475 node server.mjs
# `os.homedir()` honours $HOME, and a non-default PORT writes its own
# index-<port>.json, so the throwaway instance is fully isolated.
```

## Tests & checks

```bash
node --test                 # the whole suite (test/*.test.mjs)
node --test test/health.test.mjs   # a single file
node --check lib/foo.mjs    # syntax-check a changed module
```

- Add tests for new `lib/` behaviour. Tests are hermetic — use `mkdtempSync(tmpdir())` and
  inject a throwaway dir (see `test/status.test.mjs`, `test/onboarding.test.mjs`) rather than
  reading the real `~/.claude`.
- **`git add` new test files.** CI has caught untracked test files before.
- CI runs `node --check` + `node --test` + a smoke boot on **macOS and Linux**.

## Code style

- **4-space indent, single quotes, semicolons, trailing commas** in multiline.
- **`.mjs` ES modules**, `node:`-prefixed core imports.
- **No `console.log`** — use `lib/logger.mjs` for server-side logging.
- **Comments explain the code, never the change.** No PR numbers, issue/ticket IDs, names, or
  "addresses review feedback" narrative in source — that context belongs in the commit message,
  PR description, and the [Handoff Log](CLAUDE.md#handoff-log). A comment must make sense to
  someone reading the file in isolation. Default to no comment; keep one only for a non-obvious
  *why* (an invariant, a gotcha, domain context).
- Keep functions small with clear behaviour; prefer named locals over deeply nested calls.

## Security-sensitive surfaces

This tool can be exposed to your phone over Tailscale, so treat these with care:

- **Untrusted input is the transcript.** Anything derived from a transcript field that becomes an
  object key must be prototype-pollution guarded (see `bump()` in `lib/health.mjs`,
  `isUnsafeModelKey` in `lib/cost.mjs`).
- **Never surface raw shell commands or secrets.** Where a command could carry a credential,
  expose a category/label, not the text (see the destructive-command detector in `lib/health.mjs`).
- **Escape everything injected into the DOM** with `esc()` in `public/index.html`.
- State-changing endpoints require the `X-CC` header (CSRF) and validate `sessionId` as a UUID.

## Submitting a change

1. **Branch off `master`** — never commit to `master` directly.
2. Make the change; add/update tests; run `node --test` and `node --check`.
3. Exercise it on a throwaway port (above) — for UI changes, in a real browser.
4. Open a PR. CI must be green (macOS + Linux).
5. For a release: bump `version` in `package.json`, add a `CHANGELOG.md` entry
   (**SemVer** — feature = minor, fix/perf = patch), and after merge cut an annotated
   `vX.Y.Z` tag + a GitHub release. Append a row to the [Handoff Log](CLAUDE.md#handoff-log).

## Installing via Homebrew (for users)

A formula ships in [`Formula/cc-orchestrator.rb`](Formula/cc-orchestrator.rb):

```bash
# from a tap
brew tap shubhamparashar/cc-orchestrator https://github.com/shubhamparashar/cc-orchestrator
brew install cc-orchestrator

# or directly from a checkout
brew install --build-from-source ./Formula/cc-orchestrator.rb

brew services start cc-orchestrator   # always-on, replaces the LaunchAgent
```
