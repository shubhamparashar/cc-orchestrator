# CLAUDE.md

Guidance for Claude Code working in this repo (cc-orchestrator).

cc-orchestrator is a zero-dependency local control plane over Claude Code sessions
(dashboard, remote control, rolling per-session `context.md`, BM25 session index,
launcher, cost calc, always-on LaunchAgent, Tailscale phone access). Full design and
audit live in `REPORT.md`; usage in `README.md`. Read those before re-deriving anything.

## Handoff Log

Session-by-session handoff history has moved to [handoffs/INDEX.md](handoffs/INDEX.md) - read that file for the full table and the append convention before writing a new handoff.

