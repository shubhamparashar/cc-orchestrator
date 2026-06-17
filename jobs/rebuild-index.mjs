// Rebuild ~/.claude/contexts/index.json from ALL transcripts (Tier-1, free —
// no model calls), enriched with any curated context.md. Safe to run anytime.
import { buildSessionIndex } from '../lib/sessionIndex.mjs';

const entries = await buildSessionIndex();
const withCtx = entries.filter((e) => e.hasContext).length;
console.log(`index rebuilt: ${entries.length} sessions (${withCtx} with context.md)`);
