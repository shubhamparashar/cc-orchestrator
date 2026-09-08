# ctx-generate eval

Scores the rolling-context prompt in `lib/ctxPrompt.mjs`. The generator's whole
job is that a future agent resumes cold from the file, so the failure that
matters is a *stale* fact surviving a merge, not a malformed one.

Each case is `dialogue.txt` (+ optional `existing.md`) and an `expect.json` of
`must_contain` / `must_not_contain` regexes. Checks are deterministic: section
set, tag count, line cap, no preamble, and the per-case content assertions.
Outputs are recorded per model under `cases/<case>/outputs/<model>/`, so
re-scoring a prompt change costs nothing until you re-record.

```
node evals/ctx-generate/run.mjs                    # replay recorded outputs
node evals/ctx-generate/run.mjs --record           # call the model, then score
node evals/ctx-generate/run.mjs --model claude-sonnet-4-5 --samples 3
```

## Cases

| case | asks |
|---|---|
| `fresh-session` | no existing file; keep the migration constraint that still governs the next step |
| `drop-fixed-bug` | a bug the excerpt closed must vanish, symptom and error counts included |
| `reversed-decision` | a superseded plan (FIFO queue) must not survive as a Next step |
| `noisy-transcript` | greetings, typos and "brb lunch" must not reach the file |

## Findings

Baseline, prompt as originally written:

| model | samples passing |
|---|---|
| claude-haiku-4-5 | 6/8 |
| claude-sonnet-4-5 | 7/8 |

Both models failed the same way: a fixed bug's identifiers survived the merge
even though the prompt said to drop fixed bugs. Haiku also emitted a single tag
where 3 to 6 were specified.

The fix made deletion an explicit first pass over the existing file and said a
settled item leaves no trace. That over-corrected: the first version also
deleted a still-true constraint (`CREATE INDEX CONCURRENTLY` is unavailable
inside the migration runner's transaction), which the harness caught. Adding a
clause protecting standing constraints and invariants fixed both.

Haiku now passes 12/12 and Sonnet 8/8. Haiku is the generator's default
model, so this is the configuration that actually runs.
