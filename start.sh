#!/bin/bash
# Restart the orchestrator detached from any terminal. Console log: /tmp/cc-orch.log
# (the app also writes a rotating log under ~/.config/cc-orchestrator/logs — `cc-logs`).
# CC_LAN=1 ./start.sh binds 0.0.0.0 for LAN/phone access (token required).
# Portable across macOS and Linux.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
P=${PORT:-7433}

# Listener PID(s) on the port — lsof where present (macOS), else ss (Linux). Match
# only the LISTEN socket, never clients holding SSE/poll sockets.
listener_pids() {
    if command -v lsof >/dev/null 2>&1; then
        lsof -ti tcp:"$P" -sTCP:LISTEN 2>/dev/null || true
    elif command -v ss >/dev/null 2>&1; then
        ss -tlnpH "sport = :$P" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true
    fi
}
pid_args() { ps -p "$1" -o args= 2>/dev/null; }
pid_cwd() {
    if [ -r "/proc/$1/cwd" ]; then readlink "/proc/$1/cwd"
    elif command -v lsof >/dev/null 2>&1; then lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
    fi
}

# Only kill if the listener is THIS checkout's server.mjs — never an unrelated
# process that happens to hold the port.
for pid in $(listener_pids); do
    args=$(pid_args "$pid")
    if [[ "$args" == *"$DIR/server.mjs"* ]] || { [[ "$args" == *server.mjs* ]] && [ "$(pid_cwd "$pid")" = "$DIR" ]; }; then
        kill "$pid"
    else
        echo "port $P is held by an unrelated process (pid $pid). Stop it or set PORT=…"; exit 1
    fi
done
if [ -n "$(listener_pids)" ]; then sleep 0.5; fi

PORT=$P CC_LAN=${CC_LAN:-} nohup node "$DIR/server.mjs" > /tmp/cc-orch.log 2>&1 &
disown 2>/dev/null || true
sleep 1
if curl -sf "http://127.0.0.1:$P/healthz" > /dev/null; then
    echo "running: http://127.0.0.1:$P (log: /tmp/cc-orch.log  or  cc-logs)"
    if [ "$CC_LAN" = "1" ]; then
        # Authoritative URL from the server (same interface enumeration it allowlists).
        URL=$(curl -s "http://127.0.0.1:$P/api/phone-link" | python3 -c "import sys,json; print(json.load(sys.stdin).get('url') or '')" 2>/dev/null || true)
        [ -n "$URL" ] && echo "LAN: $URL  (token required — open the 📱 panel on the Mac for the one-tap link)"
    fi
else
    echo "failed to start — see /tmp/cc-orch.log"; exit 1
fi
