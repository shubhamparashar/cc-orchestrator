#!/bin/bash
# Build cc-orchestrator.app — a bare .app bundle whose launcher adopts an
# already-running server on :7433 or installs the LaunchAgent from the copy
# of the repo bundled under Contents/Resources/app. No Electron, no deps.
#   ./scripts/build-app.sh          -> dist/cc-orchestrator.app
#   ./scripts/build-app.sh --dmg    -> also dist/cc-orchestrator.dmg
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=dist/cc-orchestrator.app
rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources/app"

# Bundle the runnable tree (server + UI + install scripts), nothing else.
rsync -a --delete \
    --exclude '.git' --exclude '.claude' --exclude 'dist' \
    --exclude 'test' --exclude 'docs' --exclude '*.log' \
    --exclude 'CLAUDE.md' --exclude 'AGENTS.md' --exclude 'REPORT.md' \
    --exclude 'handoffs' \
    ./ "$OUT/Contents/Resources/app/"

cat > "$OUT/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>cc-orchestrator</string>
    <key>CFBundleIdentifier</key><string>com.cc-orchestrator.app</string>
    <key>CFBundleVersion</key><string>1</string>
    <key>CFBundleShortVersionString</key><string>1.0</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleExecutable</key><string>cc-orchestrator</string>
    <key>LSUIElement</key><false/>
</dict>
</plist>
EOF

cp scripts/app-launcher.sh "$OUT/Contents/MacOS/cc-orchestrator"
chmod +x "$OUT/Contents/MacOS/cc-orchestrator"
plutil -lint "$OUT/Contents/Info.plist"
echo "built $OUT"

if [[ "${1:-}" == "--dmg" ]]; then
    rm -f dist/cc-orchestrator.dmg
    hdiutil create -volname cc-orchestrator -srcfolder "$OUT" -ov -format UDZO dist/cc-orchestrator.dmg
    echo "built dist/cc-orchestrator.dmg"
fi
