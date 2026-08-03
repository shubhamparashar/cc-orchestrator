// PostToolUse hook: task canvas. Large tool outputs are spilled to disk under
// the session's canvas dir with a stable ID, and canvas.md keeps a one-line map
// (id, tool, what ran, size, file). The model is told about the canvas exactly
// once per session so per-turn prompt content stays stable (prefix-cache safe).
if (process.env.CC_CTX_JOB) process.exit(0);

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { isSessionUuid } from '../lib/contextStore.mjs';

const SPILL_MIN_CHARS = 10_000;

function asText(resp) {
    if (typeof resp === 'string') return resp;
    if (resp && typeof resp === 'object') {
        // common shapes: {output}, {stdout}, [{type:'text',text}]
        if (typeof resp.output === 'string') return resp.output;
        if (typeof resp.stdout === 'string') return resp.stdout;
        if (Array.isArray(resp)) {
            const texts = resp.map((b) => (b && typeof b.text === 'string' ? b.text : null)).filter(Boolean);
            if (texts.length) return texts.join('\n');
        }
    }
    return JSON.stringify(resp, null, 2);
}

function inputSummary(toolName, toolInput) {
    if (!toolInput) return '';
    if (toolName === 'Bash' && toolInput.command) return toolInput.command;
    if (toolInput.pattern) return toolInput.pattern;
    if (toolInput.file_path) return toolInput.file_path;
    if (toolInput.url) return toolInput.url;
    return JSON.stringify(toolInput);
}

function clip(s, max) {
    const flat = String(s).replace(/\s+/g, ' ').trim();
    return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const sessionId = input.session_id;
    if (!isSessionUuid(sessionId)) process.exit(0);

    const text = asText(input.tool_response);
    if (!text || text.length < SPILL_MIN_CHARS) process.exit(0);

    const dir = join(homedir(), '.claude', 'contexts', 'canvas', sessionId);
    mkdirSync(dir, { recursive: true });

    const seq = readdirSync(dir).filter((f) => /^\d{3}-/.test(f)).length + 1;
    const id = `c${String(seq).padStart(3, '0')}`;
    const tool = (input.tool_name || 'tool').replace(/[^\w-]/g, '_');
    const file = `${String(seq).padStart(3, '0')}-${tool}.txt`;
    const summary = clip(inputSummary(input.tool_name, input.tool_input), 160);

    writeFileSync(join(dir, file), `# ${id} ${input.tool_name}: ${summary}\n\n${text}`);

    const canvasPath = join(dir, 'canvas.md');
    if (!existsSync(canvasPath)) {
        writeFileSync(canvasPath, `# Task canvas - session ${sessionId}\nLarge tool outputs spilled from context. Read the listed file to re-open the raw evidence.\n\n`);
    }
    const kb = Math.round(text.length / 1024);
    appendFileSync(canvasPath, `- [${id}] ${input.tool_name} \`${summary}\` (${kb}KB) → ${file}\n`);

    // one-time pointer to the model; announcing every spill would churn the prompt
    const marker = join(dir, '.announced');
    if (!existsSync(marker)) {
        writeFileSync(marker, '');
        process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
                hookEventName: 'PostToolUse',
                additionalContext: `Task canvas active: large tool outputs from this session are saved with IDs in ${canvasPath} (raw files alongside it). After compaction or when you need an earlier result's full text, read canvas.md and open the file by ID instead of re-running the tool.`,
            },
        }));
    }
} catch {
    // fail-open: a broken hook must never break a session
}
process.exit(0);
