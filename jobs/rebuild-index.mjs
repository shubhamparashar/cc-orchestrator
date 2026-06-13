// Rebuild ~/.claude/contexts/index.json from the context files on disk.
// Used by the /context skill after a manual context write.
import { rebuildIndex } from '../lib/contextStore.mjs';

const entries = await rebuildIndex();
console.log(`index rebuilt: ${entries.length} context(s)`);
