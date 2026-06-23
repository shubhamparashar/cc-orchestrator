import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TASKS_DIR = join(homedir(), '.claude', 'tasks');

// Numbered task files only — `.lock`, `.highwatermark`, and any non-digit
// basename are bookkeeping entries the agent leaves behind, not tasks.
const TASK_FILE = /^(\d+)\.json$/;

function zeroed() {
    return { total: 0, done: 0, inProgress: 0, pending: 0, blocked: 0, items: [] };
}

// Roll the per-session task directory (~/.claude/tasks/<sessionId>/) into a
// status summary + ordered item list. Numbering can have gaps, so we sort by the
// parsed integer of the filename, not lexically (10.json must follow 9.json).
// Best-effort: a missing dir or an unreadable/unparseable file never throws —
// the caller always gets the full zeroed shape so it can render unconditionally.
export async function sessionTasks(sessionId) {
    const dir = join(TASKS_DIR, sessionId);
    let entries;
    try {
        entries = await readdir(dir);
    } catch {
        return zeroed();
    }

    const numbered = [];
    for (const name of entries) {
        const m = TASK_FILE.exec(name);
        if (m) numbered.push({ name, n: Number(m[1]) });
    }
    numbered.sort((a, b) => a.n - b.n);

    const out = zeroed();
    for (const { name } of numbered) {
        let task;
        try {
            task = JSON.parse(await readFile(join(dir, name), 'utf8'));
        } catch {
            // unreadable / partial / non-JSON file — skip
            continue;
        }
        out.total += 1;
        const status = task?.status;
        if (status === 'completed') out.done += 1;
        else if (status === 'in_progress') out.inProgress += 1;
        else if (status === 'pending') out.pending += 1;
        if (Array.isArray(task?.blockedBy) && task.blockedBy.length > 0 && status !== 'completed') {
            out.blocked += 1;
        }
        out.items.push({ subject: task?.subject, status });
    }
    return out;
}

export { TASKS_DIR };
