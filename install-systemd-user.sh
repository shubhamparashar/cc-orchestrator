#!/bin/bash
# Install cc-orchestrator as an always-on systemd --user service (Linux).
# The macOS equivalent is ./install-launchagent.sh.
#   PORT=… CC_LAN=1 ./install-systemd-user.sh
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
P=${PORT:-7433}
LAN=${CC_LAN:-0}

NODE=$(command -v node || true)
[ -z "$NODE" ] && { echo "node not found on PATH"; exit 1; }
command -v systemctl >/dev/null 2>&1 || { echo "systemctl not found — this script is for systemd Linux"; exit 1; }

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/cc-orchestrator.service"
mkdir -p "$UNIT_DIR"

cat > "$UNIT" <<EOF
[Unit]
Description=cc-orchestrator — local Claude Code dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=$DIR
ExecStart="$NODE" "$DIR/server.mjs"
Environment=PORT=$P
Environment=CC_LAN=$LAN
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now cc-orchestrator.service
sleep 1

if curl -sf "http://127.0.0.1:$P/healthz" >/dev/null 2>&1; then
    echo "installed + running at login: http://127.0.0.1:$P"
    echo "logs: cc-logs   (or: journalctl --user -u cc-orchestrator -f)"
    echo "uninstall: systemctl --user disable --now cc-orchestrator.service && rm '$UNIT' && systemctl --user daemon-reload"
    echo "tip: 'loginctl enable-linger $USER' keeps it running while you're logged out."
else
    echo "loaded but healthcheck failed — see: journalctl --user -u cc-orchestrator"; exit 1
fi
