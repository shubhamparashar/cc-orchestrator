const STOPWORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
    'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these',
    'i', 'me', 'my', 'we', 'our', 'you', 'your', 'how', 'what', 'when', 'where', 'why',
    'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will', 'not', 'no', 'yes',
    'about', 'into', 'from', 'then', 'than', 'now', 'please', 'help', 'need', 'want',
]);

// Per-field boosts (BM25F-style). Saturated colour lives in title/tags; the body
// (the user's prompts) is high-recall but lower per-term weight. `work` holds the
// files edited and tools/commands run (distinctive locators like "cost.mjs"), so
// it ranks near repo-level — IDF keeps common files (package.json) from dominating.
const FIELD_BOOST = { title: 6, tags: 5, repo: 4, work: 4, goal: 3, body: 1.2 };
const K1 = 1.2;          // term-frequency saturation
const B = 0.75;          // body length normalization (standard BM25; penalizes sprawling transcripts so focused sessions win their own terms)
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

// Frequency-ordered, dedup-capped bag of terms from a term→count Map: the highest-
// frequency `termCap` distinct terms, each emitted up to `tfCap` times. Collapses
// runaway repetition so a long body indexes small while keeping its distinct
// vocabulary for IDF to weight at query time. Shared by the session-prompt body and
// the sub-agent dialogue body so both compress identically.
export function termBag(counts, { termCap, tfCap }) {
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, termCap);
    const out = [];
    for (const [term, c] of top) {
        for (let i = 0; i < Math.min(c, tfCap); i++) out.push(term);
    }
    return out.join(' ');
}

function fieldTokens(doc) {
    if (doc._ft) return doc._ft;
    doc._ft = {
        title: tokenize(doc.title || ''),
        tags: (doc.tags || []).flatMap((t) => tokenize(String(t))),
        repo: tokenize(doc.repo || ''),
        work: tokenize(doc.work || ''),
        goal: tokenize(doc.goal || ''),
        body: tokenize(doc.body || ''),
    };
    return doc._ft;
}

// Term frequency in a token list, with forward prefix credit only: a query term
// scores partial credit against a longer token it prefixes ("signoz" →
// "signoz-dashboard", "scan" → "scan.mjs"). The reverse direction — a short
// generic token crediting a longer specific query ("session" →
// "session-index.test.mjs") — is excluded, as it diluted exact filename/command
// matches and let non-matching sessions outrank the one that owns the term.
function tf(tokens, term) {
    let n = 0;
    for (const t of tokens) {
        if (t === term) n += 1;
        else if (term.length >= 4 && t.startsWith(term)) n += PREFIX_CREDIT;
    }
    return n;
}

// Lexical BM25F-lite ranker. Pure (no model calls), corpus stats computed from
// the passed docs, sub-millisecond on a personal-scale corpus.
// Doc shape: {title, tags[], goal, repo, work, body, updatedMs}. Returns [{doc, score}].
export function rankDocs(query, docs, { repo = null, limit = 8 } = {}) {
    const terms = [...new Set(tokenize(query))];
    if (!terms.length || !docs.length) return [];

    // average body length for length normalization
    let totalBodyLen = 0;
    for (const d of docs) totalBodyLen += fieldTokens(d).body.length;
    const avgBodyLen = totalBodyLen / docs.length || 1;

    // document frequency per term (in any field) → IDF
    const df = new Map(terms.map((t) => [t, 0]));
    for (const d of docs) {
        const ft = fieldTokens(d);
        const all = [...ft.title, ...ft.tags, ...ft.repo, ...ft.work, ...ft.goal, ...ft.body];
        for (const t of terms) if (all.some((x) => x === t || (t.length >= 4 && x.startsWith(t)))) df.set(t, df.get(t) + 1);
    }
    const N = docs.length;
    const idf = new Map(terms.map((t) => {
        const n = df.get(t);
        return [t, Math.log(1 + (N - n + 0.5) / (n + 0.5))];
    }));

    const now = Date.now();
    const scored = [];
    for (const doc of docs) {
        const ft = fieldTokens(doc);
        const bodyNorm = 1 - B + B * (ft.body.length / avgBodyLen);
        let score = 0;
        for (const term of terms) {
            let wtf = 0;
            for (const [field, boost] of Object.entries(FIELD_BOOST)) {
                let f = tf(ft[field], term);
                if (field === 'body' && f > 0) f /= bodyNorm;   // length-normalize the long field
                wtf += boost * f;
            }
            if (wtf > 0) score += idf.get(term) * (wtf * (K1 + 1)) / (wtf + K1);
        }
        if (score <= 0) continue;
        const ageDays = doc.updatedMs ? Math.max(0, (now - doc.updatedMs) / ONE_DAY_MS) : RECENCY_HALF_LIFE_DAYS;
        score *= 1 + 0.5 * Math.max(0, 1 - ageDays / RECENCY_HALF_LIFE_DAYS);
        if (repo && doc.repo === repo) score *= SAME_REPO_BOOST;
        scored.push({ doc, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
}
