#!/bin/zsh
# Installs the claude shim by appending a marked alias block to ~/.zshrc.
# The block is appended at the END so it wins over any earlier `alias claude=...`.
# Re-running is a no-op. Uninstall: delete the block between the markers.
set -e

SHIM="$(cd "$(dirname "$0")" && pwd)/claude-shim"
RC="$HOME/.zshrc"
MARKER="# >>> cc-orchestrator claude shim >>>"

chmod +x "$SHIM"

if grep -qF "$MARKER" "$RC" 2>/dev/null; then
    echo "shim already installed in $RC"
    exit 0
fi

[[ -f "$RC" ]] && cp "$RC" "$RC.bak.cc-orchestrator"
cat >> "$RC" <<EOF

$MARKER
# Interactive 'claude' launches get --remote-control by default (opt out: CLAUDE_NO_RC=1).
export CLAUDE_ORIG_BIN="\$HOME/.claude/local/claude"
alias claude="$SHIM"
# <<< cc-orchestrator claude shim <<<
EOF

echo "installed: alias claude -> $SHIM  (backup: $RC.bak.cc-orchestrator)"
echo "open a new shell or 'source ~/.zshrc' to activate"
