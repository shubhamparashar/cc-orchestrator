import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Tolerant read of a small JSON object from the ~/.claude tree. Any failure —
// file absent, unreadable, malformed JSON, or a non-object (array / scalar) —
// yields null, so a missing or corrupt status file degrades to "signal
// unavailable" rather than throwing the whole /api/status request.
async function readJsonObject(path) {
    try {
        const parsed = JSON.parse(await readFile(path, 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

// Global Claude Code status assembled from three tiny ~/.claude files (one read
// each): the installed CC version, the configured approval mode, and which MCP
// servers are flagged for re-auth. `home` is injectable so tests can point at a
// throwaway tree; the server always uses the real home directory.
export async function claudeStatus({ home = homedir() } = {}) {
    const dir = join(home, '.claude');
    const [update, config, mcpAuth] = await Promise.all([
        readJsonObject(join(dir, '.last-update-result.json')),
        readJsonObject(join(dir, 'config.json')),
        readJsonObject(join(dir, 'mcp-needs-auth-cache.json')),
    ]);

    // version_to is the version the last auto-update installed; fall back to
    // version_from so a record that only carries the prior version still reports
    // something. updateOk flags a last-update that did not finish cleanly.
    let version = null;
    let updateOk = true;
    if (update) {
        version = typeof update.version_to === 'string'
            ? update.version_to
            : typeof update.version_from === 'string' ? update.version_from : null;
        const result = update.outcome ?? update.status;
        updateOk = result == null || result === 'success';
    }

    const approvalMode = typeof config?.approvalMode === 'string' ? config.approvalMode : null;

    // The cache is a map of "<server name>": {timestamp, id?}; its keys are the
    // servers needing re-auth. Names are display-only (the caller escapes them).
    const mcpNeedsAuth = mcpAuth ? Object.keys(mcpAuth) : [];

    return { version, updateOk, approvalMode, mcpNeedsAuth };
}
