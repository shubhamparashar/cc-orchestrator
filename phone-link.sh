#!/bin/zsh
# Expose the localhost orchestrator to your phone over Tailscale (private, TLS,
# tailnet-only). The server keeps binding 127.0.0.1; tailscale serve proxies to it.
# Writes the ts.net URL to ~/.config/cc-orchestrator/remote.json and adds the
# ts.net hostname to the Host allowlist (~/.config/cc-orchestrator/hosts).
set -e
P=${PORT:-7433}
CONFIG="$HOME/.config/cc-orchestrator"
mkdir -p "$CONFIG"
chmod 700 "$CONFIG"   # tighten even if it already existed at a looser mode

# Resolve the Tailscale CLI (PATH, then the macOS app bundle).
TS=""
if command -v tailscale >/dev/null 2>&1; then
    TS="tailscale"
elif [[ -x "/Applications/Tailscale.app/Contents/MacOS/Tailscale" ]]; then
    TS="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
fi

if [[ -z "$TS" ]]; then
    echo "Tailscale is not installed."
    echo "Install it, then re-run this script:"
    echo "    brew install --cask tailscale   # or: https://tailscale.com/download/mac"
    echo "    open -a Tailscale                # sign in once"
    exit 1
fi

STATE=$("$TS" status --json 2>/dev/null || echo '{}')
BACKEND=$(printf '%s' "$STATE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('BackendState',''))" 2>/dev/null || echo "")
if [[ "$BACKEND" != "Running" ]]; then
    echo "Tailscale is installed but not logged in (BackendState=$BACKEND)."
    echo "    open -a Tailscale   # sign in, then re-run this script"
    exit 1
fi

# DNSName is like "machine.tailnet.ts.net." (trailing dot) — strip it.
HOSTNAME=$(printf '%s' "$STATE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('Self',{}).get('DNSName','').rstrip('.'))" 2>/dev/null || echo "")
if [[ -z "$HOSTNAME" ]]; then
    echo "Could not read this machine's ts.net hostname from tailscale status."
    exit 1
fi
URL="https://$HOSTNAME"

# Proxy https://<machine>.ts.net → 127.0.0.1:$P, in the background.
# `tailscale serve` blocks (waiting for you to enable Serve) when the tailnet's
# Serve/HTTPS capability is off, so bound it with a timeout and then verify via
# `serve status` instead of trusting the command's exit code.
SERVE_OUT=$(mktemp)
( "$TS" serve --bg "http://127.0.0.1:$P" > "$SERVE_OUT" 2>&1 ) &
SERVE_PID=$!
COUNT=0
while kill -0 "$SERVE_PID" 2>/dev/null; do
    sleep 1; COUNT=$((COUNT + 1))
    if (( COUNT >= 10 )); then kill "$SERVE_PID" 2>/dev/null; break; fi
done
wait "$SERVE_PID" 2>/dev/null || true

if ! "$TS" serve status 2>/dev/null | grep -q "127.0.0.1:$P"; then
    echo "Tailscale Serve is not active yet."
    ENABLE_URL=$(grep -oE 'https://login\.tailscale\.com[^ ]+' "$SERVE_OUT" | head -1)
    if [[ -n "$ENABLE_URL" ]]; then
        echo "Serve/HTTPS must be enabled once on your tailnet. Open this in a browser and follow the steps:"
        echo "    $ENABLE_URL"
    else
        echo "Details from tailscale:"; sed 's/^/    /' "$SERVE_OUT"
    fi
    echo "Then re-run ./phone-link.sh  (it will finish and write the host allowlist entry)."
    rm -f "$SERVE_OUT"
    exit 1
fi
rm -f "$SERVE_OUT"

# Persist for the server: remote URL + Host allowlist entry (config is 700; keep files 600).
printf '{"mode":"tailscale","url":"%s"}\n' "$URL" > "$CONFIG/remote.json"
chmod 600 "$CONFIG/remote.json"
if ! grep -qxF "$HOSTNAME" "$CONFIG/hosts" 2>/dev/null; then
    echo "$HOSTNAME" >> "$CONFIG/hosts"
fi
chmod 600 "$CONFIG/hosts" 2>/dev/null || true

echo "Tailscale serve is up."
echo "  Remote URL:  $URL"
echo "  One-tap link with token is in the dashboard's 📱 panel (open http://127.0.0.1:$P locally)."
echo "  The server picks up the new host within ~2s — no restart needed."
echo "Stop sharing later with:  $TS serve reset   # clears this serve config"
