const STOPWORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
    'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these',
    'i', 'me', 'my', 'we', 'our', 'you', 'your', 'how', 'what', 'when', 'where', 'why',
    'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will', 'not', 'no', 'yes',
    'about', 'into', 'from', 'then', 'than', 'now', 'please', 'help', 'need', 'want',
]);

const WEIGHTS = { title: 5, tags: 5, goal: 3, repo: 2, body: 1 };
const PREFIX_CREDIT = 0.5;
const RECENCY_HALF_LIFE_DAYS = 30;
const SAME_REPO_BOOST = 1.3;
const ONE_DAY_MS = 86_400_000;

export function tokenize(text) {
    if (typeof text !== 'string') return [];
    return text
        .toLowerCase()
        .split(/[^a-z0-9_.-]+/)
        .map((t) => t.replace(/^[.-]+|[.-]+$/g, ''))
        .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function fieldScore(queryTokens, fieldTokenSet, weight) {
    let score = 0;
    for (const q of queryTokens) {
        if (fieldTokenSet.has(q)) {
            score += weight;
            continue;
        }
        if (q.length >= 4) {
            for (const t of fieldTokenSet) {
                if (t.startsWith(q) || q.startsWith(t)) {
                    score += weight * PREFIX_CREDIT;
                    break;
                }
            }
        }
    }
    return score;
}

// Doc shape: {id, title, tags[], goal, body, repo, updatedMs}. Pure lexical —
// this runs inside hooks and per keystroke, so it must never call a model.
export function rankDocs(query, docs, { repo = null, limit = 5 } = {}) {
    const queryTokens = [...new Set(tokenize(query))];
    if (!queryTokens.length) return [];
    const now = Date.now();
    const scored = [];
    for (const doc of docs) {
        const fields = doc._tokens || (doc._tokens = {
            title: new Set(tokenize(doc.title || '')),
            tags: new Set((doc.tags || []).flatMap((t) => tokenize(String(t)))),
            goal: new Set(tokenize(doc.goal || '')),
            repo: new Set(tokenize(doc.repo || '')),
            body: new Set(tokenize(doc.body || '')),
        });
        let score = 0;
        for (const [field, weight] of Object.entries(WEIGHTS)) {
            score += fieldScore(queryTokens, fields[field], weight);
        }
        if (score <= 0) continue;
        const ageDays = doc.updatedMs ? Math.max(0, (now - doc.updatedMs) / ONE_DAY_MS) : RECENCY_HALF_LIFE_DAYS;
        const freshness = Math.max(0, 1 - ageDays / RECENCY_HALF_LIFE_DAYS);
        score *= 1 + 0.5 * freshness;
        if (repo && doc.repo === repo) score *= SAME_REPO_BOOST;
        scored.push({ doc, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
}
