import {
    accessSync, chmodSync, constants as FS, copyFileSync, existsSync, mkdirSync,
    readFileSync, readdirSync, renameSync, statSync, unlinkSync, watch, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// ── hook spec ────────────────────────────────────────────────────────────────
// The four Phase-2 context hooks → repo script + timeout, mirroring the verified
// live settings.json schema:
//   hooks: { <Event>: [ { hooks:[ { type:'command', command, timeout } ] } ] }
export function hookSpecs(repoRoot) {
    return [
        { event: 'SessionStart', script: join(repoRoot, 'hooks', 'session-start.mjs'), timeout: 10 },
        { event: 'UserPromptSubmit', script: join(repoRoot, 'hooks', 'ctx-prompt.mjs'), timeout: 10 },
        { event: 'Stop', script: join(repoRoot, 'hooks', 'ctx-update.mjs'), timeout: 10 },
        { event: 'PreCompact', script: join(repoRoot, 'hooks', 'ctx-update.mjs'), timeout: 15 },
    ];
}

// An installed entry is "ours" if its command references one of our hook scripts
// under a /hooks/ segment — robust to repo relocation, specific enough not to
// collide with another tool's hooks.
const OURS_RE = /\/hooks\/(?:session-start|ctx-prompt|ctx-update)\.mjs\b/;

function isOurCommand(cmd) {
    return typeof cmd === 'string' && OURS_RE.test(cmd);
}

function eventHasCommand(matchers, needle) {
    for (const m of matchers || []) {
        for (const hk of (Array.isArray(m?.hooks) ? m.hooks : [])) {
            if (typeof hk.command === 'string' && hk.command.includes(needle)) return true;
        }
    }
    return false;
}

// Refuse to touch a settings.json whose hooks block isn't the shape we understand,
// rather than crash with a confusing TypeError or silently discard a key. Throws a
// clear message; installHooks throws before any write, so the file is left intact.
function validateHooksShape(settings) {
    const h = settings?.hooks;
    if (h == null) return;
    if (typeof h !== 'object' || Array.isArray(h)) {
        throw new Error('settings.json "hooks" is not an object — fix it by hand; nothing was written.');
    }
    for (const [event, arr] of Object.entries(h)) {
        if (!Array.isArray(arr)) {
            throw new Error(`settings.json hooks.${event} is not an array — fix it by hand; nothing was written.`);
        }
        for (const m of arr) {
            if (m && m.hooks != null && !Array.isArray(m.hooks)) {
                throw new Error(`settings.json hooks.${event}[].hooks is not an array — fix it by hand; nothing was written.`);
            }
        }
    }
}

// ── pure merge / unmerge / status ──────────────────────────────────────────────
// Additive + idempotent: preserves every other key and any foreign hooks for the
// same event; re-running with the same repo path adds nothing.
export function mergeHooks(settings, { nodePath = process.execPath, repoRoot }) {
    const out = structuredClone(settings || {});
    validateHooksShape(out);
    const before = JSON.stringify(out.hooks ?? null);
    if (!out.hooks || typeof out.hooks !== 'object') out.hooks = {};
    const added = [];
    for (const { event, script, timeout } of hookSpecs(repoRoot)) {
        // Quote both paths so a home dir / repo path with spaces still runs.
        const command = `"${nodePath}" "${script}"`;
        const arr = Array.isArray(out.hooks[event]) ? out.hooks[event] : [];
        const hadCurrent = eventHasCommand(arr, script);
        // Strip ANY of our entries (any path), then add the current one — so a
        // relocated checkout converges to exactly one live command per event
        // instead of duplicating; foreign hooks (and their matcher keys) are kept.
        const kept = [];
        for (const m of arr) {
            const hooks = (Array.isArray(m?.hooks) ? m.hooks : []).filter((hk) => !isOurCommand(hk.command));
            if (hooks.length) kept.push({ ...m, hooks });
        }
        kept.push({ hooks: [{ type: 'command', command, timeout }] });
        out.hooks[event] = kept;
        if (!hadCurrent) added.push(event);
    }
    return { settings: out, changed: JSON.stringify(out.hooks) !== before, added };
}

// Removes only our entries; drops matchers/events/`hooks` that become empty so the
// file returns to its prior shape.
export function unmergeHooks(settings) {
    const out = structuredClone(settings || {});
    validateHooksShape(out);
    const removed = [];
    if (!out.hooks || typeof out.hooks !== 'object') return { settings: out, changed: false, removed };
    for (const event of Object.keys(out.hooks)) {
        const matchers = Array.isArray(out.hooks[event]) ? out.hooks[event] : [];
        let touched = false;
        const kept = [];
        for (const m of matchers) {
            const src = Array.isArray(m?.hooks) ? m.hooks : [];
            const hooks = src.filter((hk) => !isOurCommand(hk.command));
            if (hooks.length !== src.length) touched = true;
            if (hooks.length) kept.push({ ...m, hooks });
        }
        if (touched) removed.push(event);
        if (kept.length) out.hooks[event] = kept;
        else delete out.hooks[event];
    }
    if (Object.keys(out.hooks).length === 0) delete out.hooks;
    return { settings: out, changed: removed.length > 0, removed };
}

export function hooksStatus(settings, repoRoot) {
    const hooks = settings?.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
    const installed = [];
    const missing = [];
    for (const { event, script } of hookSpecs(repoRoot)) {
        // present if our specific script is wired under this event (any location → relocation-robust check is OURS_RE)
        const matchers = Array.isArray(hooks[event]) ? hooks[event] : [];
        const here = eventHasCommand(matchers, script);
        const anyOurs = matchers.some((m) => (Array.isArray(m?.hooks) ? m.hooks : []).some((hk) => isOurCommand(hk.command)));
        (here || anyOurs ? installed : missing).push(event);
    }
    return { installed: [...new Set(installed)], missing };
}

// ── settings.json I/O ──────────────────────────────────────────────────────────
function settingsPathFor(home) {
    return join(home, '.claude', 'settings.json');
}

// Read settings.json → object. Missing file → {}. Malformed → throw (so we never
// overwrite a file we couldn't parse).
export function readSettings(home) {
    const path = settingsPathFor(home);
    let raw;
    try {
        raw = readFileSync(path, 'utf8');
    } catch {
        return {};
    }
    if (!raw.trim()) return {};
    return JSON.parse(raw); // throws on malformed — caller must handle
}

function atomicWriteJson(path, obj) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}`;
    try {
        writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
        renameSync(tmp, path); // same dir → intra-filesystem, atomic
    } catch (err) {
        try { unlinkSync(tmp); } catch { /* nothing to clean */ }
        throw err;
    }
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
}

export function installHooks({ home = homedir(), repoRoot, nodePath = process.execPath, uninstall = false }) {
    const settingsPath = settingsPathFor(home);
    const existing = readSettings(home); // may throw on malformed — intentional
    const { settings, changed, added, removed } = uninstall
        ? { ...unmergeHooks(existing), added: [] }
        : { ...mergeHooks(existing, { nodePath, repoRoot }), removed: [] };
    if (!changed) {
        return { action: 'noop', added: added || [], removed: removed || [], settingsPath, backupPath: null };
    }
    let backupPath = null;
    if (existsSync(settingsPath)) {
        const bp = `${settingsPath}.bak.cc-orchestrator`;
        // Never overwrite an existing backup — the first one is the pristine,
        // pre-cc-orchestrator file; a later run must not clobber it with a copy
        // we already modified. Keep the original; still report where it is.
        if (existsSync(bp)) backupPath = bp;
        else { try { copyFileSync(settingsPath, bp); backupPath = bp; } catch { backupPath = null; } }
    }
    atomicWriteJson(settingsPath, settings);
    return {
        action: uninstall ? 'removed' : 'installed',
        added: added || [], removed: removed || [], settingsPath, backupPath,
    };
}

// ── doctor checks ──────────────────────────────────────────────────────────────
function check(id, label, status, detail, fix) {
    return fix ? { id, label, status, detail, fix } : { id, label, status, detail };
}

function onPath(bin) {
    for (const dir of (process.env.PATH || '').split(':')) {
        if (!dir) continue;
        try { accessSync(join(dir, bin), FS.X_OK); return join(dir, bin); } catch { /* keep looking */ }
    }
    return null;
}

// Probe the SAME host server.mjs binds (0.0.0.0 in LAN mode, else 127.0.0.1) so we
// don't report "free" for a conflict the real listen would hit. The IPv6 listener
// fails open in server.mjs, so the primary host is the one that matters. This
// momentarily binds+closes the port — the one (transient) side effect of doctor.
function portFree(port) {
    const host = process.env.CC_LAN === '1' ? '0.0.0.0' : '127.0.0.1';
    return new Promise((resolve) => {
        const srv = createServer();
        srv.once('error', () => resolve(false));
        srv.once('listening', () => srv.close(() => resolve(true)));
        srv.listen(port, host);
    });
}

function fsWatchRecursive() {
    try { watch(tmpdir(), { recursive: true }, () => {}).close(); return true; } catch { return false; }
}

function dirNonEmpty(path) {
    try { return readdirSync(path).length > 0; } catch { return false; }
}

// Writable if the path — or, when it doesn't exist yet, the nearest existing
// ancestor (which `mkdir -p` would extend) — is writable. Fresh setups have no
// ~/.config/cc-orchestrator yet, so checking the path alone would wrongly fail.
function writable(path) {
    let p = path;
    while (!existsSync(p)) {
        const parent = dirname(p);
        if (parent === p) break;
        p = parent;
    }
    try { accessSync(p, FS.W_OK); return true; } catch { return false; }
}

export async function runChecks({ home = homedir(), repoRoot, port = Number(process.env.PORT || 7433) } = {}) {
    const out = [];

    const major = Number.parseInt(process.versions.node, 10);
    out.push(Number.isFinite(major) && major >= 20
        ? check('node', 'Node ≥ 20', 'pass', `Node ${process.versions.node}`)
        : check('node', 'Node ≥ 20', 'fail', `Node ${process.versions.node}`, 'Upgrade Node (brew install node) — live refresh needs recursive fs.watch.'));

    const localClaude = join(home, '.claude', 'local', 'claude');
    const claudeAt = existsSync(localClaude) ? localClaude : onPath('claude');
    out.push(claudeAt
        ? check('claude', 'claude binary', 'pass', claudeAt)
        : check('claude', 'claude binary', 'fail', 'not found', 'Install Claude Code so `claude` is on PATH or at ~/.claude/local/claude.'));

    out.push(await portFree(port)
        ? check('port', `port ${port} free`, 'pass', `${port} available`)
        : check('port', `port ${port} free`, 'fail', `${port} in use`, `Stop the process on ${port} or run with PORT=… set.`));

    const configDir = join(home, '.config', 'cc-orchestrator');
    out.push(writable(configDir)
        ? check('configdir', 'config dir writable', 'pass', configDir)
        : check('configdir', 'config dir writable', 'fail', configDir, 'Fix permissions on ~/.config/cc-orchestrator.'));

    out.push(dirNonEmpty(join(home, '.claude', 'projects'))
        ? check('claudedir', '~/.claude/projects', 'pass', 'has sessions')
        : check('claudedir', '~/.claude/projects', 'warn', 'missing or empty', 'Run a Claude Code session first — the dashboard reads transcripts from here.'));

    let hookDetail = 'could not read settings.json';
    let hookStatus = 'warn';
    try {
        const st = hooksStatus(readSettings(home), repoRoot);
        if (st.missing.length === 0) { hookStatus = 'pass'; hookDetail = 'all 4 hooks installed'; }
        else hookDetail = `${st.installed.length}/4 installed (missing: ${st.missing.join(', ')})`;
    } catch {
        hookDetail = 'settings.json is malformed';
    }
    out.push(hookStatus === 'pass'
        ? check('hooks', 'context hooks', 'pass', hookDetail)
        : check('hooks', 'context hooks', 'warn', hookDetail, 'Run: cc-install-hooks  (enables context.md / related-sessions / 70%-warning).'));

    const tokenPath = join(home, '.config', 'cc-orchestrator', 'token');
    if (existsSync(tokenPath)) {
        let mode;
        try { mode = statSync(tokenPath).mode & 0o777; } catch { mode = null; }
        out.push(mode === 0o600
            ? check('tokenperms', 'token perms', 'pass', '600')
            : check('tokenperms', 'token perms', 'warn', mode == null ? 'unknown' : mode.toString(8), 'chmod 600 ~/.config/cc-orchestrator/token'));
    }

    out.push(existsSync(join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions'))
        ? check('desktop', 'Desktop metadata', 'pass', 'present')
        : check('desktop', 'Desktop metadata', 'warn', 'absent', 'Desktop-launched sessions won’t show titles/PR state (CLI sessions still work).'));

    out.push(fsWatchRecursive()
        ? check('fswatch', 'recursive fs.watch', 'pass', 'supported')
        : check('fswatch', 'recursive fs.watch', 'warn', 'unsupported', 'Live refresh needs recursive fs.watch (Node ≥ 20 on macOS).'));

    out.push(writable(join(home, '.claude', 'sessions')) || existsSync(join(home, '.claude', 'sessions'))
        ? check('sessions', '~/.claude/sessions', 'pass', 'readable')
        : check('sessions', '~/.claude/sessions', 'warn', 'missing', 'Running-session detection needs the live pid registry here.'));

    return out;
}

export { OURS_RE, settingsPathFor };
