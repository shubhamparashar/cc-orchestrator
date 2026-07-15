#!/bin/bash
# .app launcher: adopt a running server on :7433, else install/kick the
# LaunchAgent from the bundled repo copy, then open the UI in the browser.
set -u
CONTENTS="$(cd "$(dirname "$0")/.." && pwd)"
APP_REPO="$CONTENTS/Resources/app"
PORT="${PORT:-7433}"
URL="http://127.0.0.1:$PORT"

fail() {
    /usr/bin/osascript -e "display dialog $(printf '%s' "$1" | /usr/bin/python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo '"cc-orchestrator failed to start."') with title \"cc-orchestrator\" buttons {\"OK\"} default button 1 with icon caution" >/dev/null 2>&1
    exit 1
}

alive() { /usr/bin/curl -s -m 2 -o /dev/null "$URL/"; }

# GUI apps launch with a bare PATH — search the usual node homes and return
# the first binary that is actually >= 20 (a PATH default can be older).
find_node() {
    local c p
    for c in node /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.local/bin/node" "$HOME/.nvm/versions/node/"*/bin/node; do
        p="$(command -v "$c" 2>/dev/null)" || continue
        [ "$("$p" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 20 ] && { echo "$p"; return 0; }
    done
    return 1
}

if ! alive; then
    NODE="$(find_node)" || fail "Node.js 20+ is required but was not found. Install it from nodejs.org or Homebrew, then relaunch."
    if [ -f "$HOME/Library/LaunchAgents/com.cc-orchestrator.plist" ]; then
        /bin/launchctl kickstart -k "gui/$(id -u)/com.cc-orchestrator" 2>/dev/null \
            || /bin/launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.cc-orchestrator.plist" 2>/dev/null || true
    else
        PATH="$(dirname "$NODE"):$PATH" /bin/zsh "$APP_REPO/install-launchagent.sh" || fail "LaunchAgent install failed — see /tmp/cc-orch.log."
    fi
    for _ in $(seq 1 30); do alive && break; sleep 0.5; done
    alive || fail "Server did not come up on port $PORT — see /tmp/cc-orch.log."
fi

/usr/bin/open "$URL"
