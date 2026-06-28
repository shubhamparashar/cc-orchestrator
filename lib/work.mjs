import { parseLines } from './scan.mjs';

// Shared "work" harvest — the high-signal locators a transcript performs but its
// prose rarely names: the files it touched, the tools it ran, the leading verb of
// each shell command, and the sub-agent types it spawned. Lives in its own module
// so both the session index and the sub-agent index can fold it into their `work`
// field without an import cycle between them (both already depend on scan.mjs).

const WORK_TOKEN_CAP = 500;  // distinct work tokens (files + tools + commands) kept per doc

// Keys an assistant tool_use input may use to name the file it acts on.
const FILE_PATH_KEYS = ['file_path', 'filePath', 'path', 'notebook_path'];

// Harvest the "work" of a transcript from assistant tool_use blocks: distinct files
// touched (basenames), tool names used, leading bash command words, and sub-agent
// types spawned. These are high-signal locators ("find the session where I edited
// cost.mjs / ran the migration") the prose doesn't name. Folded into the `work`
// index field so they rank near repo-level. `work` may be seeded to accumulate
// across an incremental read.
export function harvestWorkTokens(text, work = new Set()) {
    for (const r of parseLines(text)) {
        if (r.type !== 'assistant' || !Array.isArray(r.message?.content)) continue;
        for (const b of r.message.content) {
            if (!b || b.type !== 'tool_use' || typeof b.name !== 'string') continue;
            work.add(b.name.toLowerCase());
            const inp = b.input || {};
            for (const k of FILE_PATH_KEYS) {
                if (typeof inp[k] === 'string' && inp[k]) {
                    const base = inp[k].split(/[/\\]/).pop();
                    if (base && base.length >= 2) work.add(base.toLowerCase());
                }
            }
            if (typeof inp.command === 'string') {
                // Capture the verb of each chained sub-command — "cd … && git … &&
                // node …" yields git and node, not just the leading cd — and skip
                // junk like assignments (d=$(mktemp)) or quoted args (a command must
                // start with a letter and be a bare word).
                for (const seg of inp.command.split(/&&|\|\|?|;|\n/)) {
                    const lead = seg.trim().split(/\s+/)[0]?.split(/[/\\]/).pop();
                    if (lead && lead.length >= 2 && /^[a-z][a-z0-9._-]*$/i.test(lead)) {
                        work.add(lead.toLowerCase());
                    }
                }
            }
            if (typeof inp.subagent_type === 'string' && inp.subagent_type) {
                work.add(inp.subagent_type.toLowerCase());
            }
        }
    }
    return work;
}

// The work set → a space-joined string for the index `work` field, capped.
export function workString(work) {
    return [...work].slice(0, WORK_TOKEN_CAP).join(' ');
}
