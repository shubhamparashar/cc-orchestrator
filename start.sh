#!/bin/zsh
# Restart the orchestrator detached from any terminal. Log: /tmp/cc-orch.log
# CC_LAN=1 ./start.sh binds 0.0.0.0 for LAN/phone access (token required).
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
P=${PORT:-7433}
# -sTCP:LISTEN: match only the listener, never clients holding SSE/poll sockets.
# Only kill if the listener is THIS checkout's server.mjs — never an unrelated
# process that happens to hold the port.
OLD=$(lsof -ti tcp:$P -sTCP:LISTEN 2>/dev/null || true)
if [[ -n "$OLD" ]]; then
    for pid in ${=OLD}; do
        if ps -p "$pid" -o args= 2>/dev/null | grep -q "$DIR/server.mjs"; then
            kill "$pid"
        else
            echo "port $P is held by an unrelated process (pid $pid). Stop it or set PORT=…"; exit 1
        fi
    done
    sleep 0.5
fi
PORT=$P CC_LAN=${CC_LAN:-} nohup node "$DIR/server.mjs" > /tmp/cc-orch.log 2>&1 &
disown
sleep 1
if curl -sf "http://127.0.0.1:$P/healthz" > /dev/null; then
    echo "running: http://127.0.0.1:$P (log: /tmp/cc-orch.log)"
    if [[ "$CC_LAN" == "1" ]]; then
        # Authoritative URL from the server (same interface enumeration it allowlists).
        URL=$(curl -s "http://127.0.0.1:$P/api/phone-link" | python3 -c "import sys,json; print(json.load(sys.stdin).get('url') or '')" 2>/dev/null || true)
        [[ -n "$URL" ]] && echo "LAN: $URL  (token required — open the 📱 panel on the Mac for the one-tap link)"
    fi
else
    echo "failed to start — see /tmp/cc-orch.log"; exit 1
fi
