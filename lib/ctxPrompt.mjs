// Prompt + parser for the rolling session-context file. Pure: no I/O, no
// model call, so the eval harness (evals/ctx-generate) can score it offline.
export const MAX_BODY_LINES = 55;

export function buildPrompt({ existing, dialogue, repo, title }) {
    return `You maintain a rolling context file for coding sessions—a future agent must resume from it cold.

TASK: Merge EXISTING with NEW EXCERPT. Keep only facts that are still true and still actionable.

First, before writing anything, go line by line through EXISTING and delete every line the NEW EXCERPT has settled:
• Tasks marked done or verified
• Bugs that are fixed — delete the symptom, the error counts and the fix's own identifiers too, not just the "open" marker
• Approaches tried and rejected
• Decisions that are reversed
A settled item leaves no trace: if the excerpt closed it, the merged file must not mention it at all.
Settled means the work is finished, not that it was mentioned. Never delete a standing constraint, invariant, gotcha or environment fact that still governs the next step — those survive every merge.
Compress mercilessly: one line per fact, reuse existing phrasing if accurate. Never append; overwrite stale sections. Hard limit: ${MAX_BODY_LINES - 5} lines total.

Output EXACTLY this with no preamble, code fences, or extra markdown:
tags: <exactly 3 to 6 comma-separated topic tags, never fewer than 3>
## Goal
<1–2 lines: what this session achieves>
## Key files
<bullets: file paths + their role/what's changing>
## Decisions
<bullets: architectural choices, constraints, tradeoffs made>
## State
<bullets: done/verified, broken/stuck, what blocks next step>
## Next step
<1–3 bullets: exact immediate actions to make progress>

Session: ${repo} — ${title}

EXISTING FILE:
${existing || '(none)'}

NEW CONVERSATION EXCERPT (oldest first):
${dialogue}`;
}

export function composeFile({ sessionId, repo, cwd, title, modelOutput }) {
    let body = modelOutput.trim()
        .replace(/^```[a-z]*\n/, '').replace(/\n```$/, '');
    let tags = [];
    const tagsMatch = body.match(/^tags:\s*(.+)$/m);
    if (tagsMatch) {
        tags = tagsMatch[1].split(',').map((t) => t.trim()).filter(Boolean).slice(0, 6);
        body = body.replace(/^tags:.*\n?/m, '');
    }
    const goalAt = body.indexOf('## Goal');
    if (goalAt === -1) throw new Error('model output missing "## Goal" section');
    body = body.slice(goalAt).trim();
    body = body.split('\n').slice(0, MAX_BODY_LINES).join('\n');
    const fm = [
        '---',
        `session: ${sessionId}`,
        `repo: ${repo}`,
        `cwd: ${cwd}`,
        `title: ${String(title).replace(/\n/g, ' ').slice(0, 120)}`,
        `tags: [${tags.join(', ')}]`,
        `updated: ${new Date().toISOString()}`,
        '---',
    ];
    return `${fm.join('\n')}\n\n${body}\n`;
}
