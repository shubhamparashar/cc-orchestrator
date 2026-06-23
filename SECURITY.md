# Security Policy

cc-orchestrator is a zero-dependency, read-only local control plane over Claude Code
sessions. This document states its trust model precisely so you can judge what it does
and does not protect against. The model is well-suited to a single-user Mac; the notes
below call out what changes on shared or networked machines.

## Trust model

- **The server binds `127.0.0.1` and reads `~/.claude` read-only.** It never writes to
  your transcripts or session data.
- **Loopback is UNAUTHENTICATED by default.** Any local user, process, or web page that
  can reach `127.0.0.1:7433` is treated as you — including the ability to spawn `claude`,
  which incurs cost and executes code in your repos. This is intentional for a solo Mac
  (it keeps local use tokenless), but it means the dashboard is only as trusted as
  everything else running on the machine.
- **Shared / multi-user machines:** set `CC_REQUIRE_TOKEN_LOCAL=1` to require the token
  even on loopback. With this set, every request — local or remote — must present a valid
  token, closing the tokenless-local path.

## Network exposure

- **Remote access:** prefer **Tailscale**, which gives you TLS and a private tailnet for
  free. The server is designed to sit behind Tailscale serve; the Tailscale-injected
  headers force the token-required path and provide a non-spoofable rate-limit identity.
- **LAN mode (`CC_LAN=1`) sends the token over plaintext HTTP.** A sniffer on the same
  network (e.g. shared Wi-Fi) can capture the token and gain full control. Use LAN mode
  only on a network you trust, and prefer Tailscale otherwise.
- **Never expose cc-orchestrator to the public internet** — no Funnel, ngrok,
  cloudflared, or reverse proxy to the open web. It has no TLS of its own and the
  loopback-trust model assumes the only reachable clients are ones you control.

## Token

- The remote-access token is **32 bytes of random data**, stored at
  `~/.config/cc-orchestrator/token` with `chmod 600` (directory `chmod 700`).
- **Rotate it with `bin/cc-rotate-token`.** This removes the token file; a fresh token is
  generated automatically on the next remote access. The running server caches the token
  in memory, so you must **restart the server** (or, with the LaunchAgent,
  `launchctl kickstart -k gui/$(id -u)/com.cc-orchestrator`) for rotation to take effect.
  Rotation invalidates any previously shared one-tap link and existing session cookies.
- **Failed remote authentication is rate-limited to 10 attempts/minute** per identity
  (in-memory, sliding window).

## Reporting a vulnerability

Please report security issues privately by email to **shubham.p@joinfleek.com**. Do not
open a public issue for security bugs.
