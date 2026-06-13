#!/bin/zsh
# Install a LaunchAgent so the orchestrator runs at login and restarts if it dies
# (so the phone link works whenever you pick up your phone). Opt-in — you run this.
# Honors PORT and CC_LAN from the environment at install time.
#   ./install-launchagent.sh            # localhost only (pair with phone-link.sh for Tailscale)
#   CC_LAN=1 ./install-launchagent.sh   # also bind LAN
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.cc-orchestrator"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
P=${PORT:-7433}
CC_LAN_VAL=${CC_LAN:-0}

NODE=$(command -v node || true)
if [[ -z "$NODE" ]]; then
    echo "node not found on PATH; cannot install."; exit 1
fi
NODE_DIR=$(dirname "$NODE")

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE</string>
        <string>$DIR/server.mjs</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PORT</key>
        <string>$P</string>
        <key>CC_LAN</key>
        <string>$CC_LAN_VAL</string>
        <key>PATH</key>
        <string>$NODE_DIR:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/cc-orch.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/cc-orch.log</string>
</dict>
</plist>
EOF

if ! plutil -lint "$PLIST" >/dev/null; then
    echo "generated plist failed plutil -lint — not loading. See $PLIST"; exit 1
fi

# Free the port first so the agent's own server can bind — but only if the
# listener is THIS checkout's server.mjs, never an unrelated process.
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

UID_NUM=$(id -u)
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST"
launchctl enable "gui/$UID_NUM/$LABEL"
sleep 1

if curl -sf "http://127.0.0.1:$P/healthz" >/dev/null; then
    echo "installed + running at login: http://127.0.0.1:$P  (PORT=$P CC_LAN=$CC_LAN_VAL)"
    echo "logs: /tmp/cc-orch.log"
    echo "uninstall:  launchctl bootout gui/$UID_NUM/$LABEL && rm '$PLIST'"
else
    echo "loaded but healthcheck failed — see /tmp/cc-orch.log"; exit 1
fi
