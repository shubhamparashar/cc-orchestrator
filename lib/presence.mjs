import { statSync } from 'node:fs';

// Window within which a touched presence file counts as "user is here".
const PRESENCE_FRESH_MS = 5 * 60 * 1000;

// Best-effort "is the user at the machine right now?". Claude Code (v2.1.181+)
// can point CLAUDE_CLIENT_PRESENCE_FILE at a file it touches while a client is
// focused; a recent mtime means presence. This native path is not guaranteed to
// exist or be wired, so callers must treat a `false` result as "unknown/away",
// not a hard signal — and any error means away.
export function isUserPresent() {
    const file = process.env.CLAUDE_CLIENT_PRESENCE_FILE;
    if (!file) return false;
    try {
        const st = statSync(file);
        return Date.now() - st.mtimeMs < PRESENCE_FRESH_MS;
    } catch {
        return false;
    }
}
