import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// USD per 1M tokens. Current Claude models are flat-priced across the full 1M
// context window (no >200K long-context premium), so a single input/output rate
// per model is correct. Override or extend via ~/.claude/contexts/pricing.json
// (same shape) if rates change or a new model appears.
// Keep in sync with PRICES in ~/repo/claude-conductor/skills/cost-stats/costs.py - both
// tables hardcode the same public API rates and drift silently if only one is updated.
export const DEFAULT_PRICING = {
    'claude-fable-5': { input: 10, output: 50 },
    'claude-opus-4-8': { input: 5, output: 25 },
    'claude-opus-4-7': { input: 5, output: 25 },
    'claude-opus-4-6': { input: 5, output: 25 },
    'claude-opus-4-5': { input: 5, output: 25 },
    'claude-opus-4-1': { input: 15, output: 75 },
    'claude-sonnet-5': { input: 3, output: 15 },
    'claude-sonnet-4-6': { input: 3, output: 15 },
    'claude-sonnet-4-5': { input: 3, output: 15 },
    'claude-haiku-4-5': { input: 1, output: 5 },
};

// Prompt-cache economics relative to base input price.
const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_5M_MULT = 1.25;
const CACHE_WRITE_1H_MULT = 2.0;
const PER_MILLION = 1_000_000;
const PRICING_OVERRIDE_PATH = join(homedir(), '.claude', 'contexts', 'pricing.json');

function isRate(r) {
    return Boolean(r) && typeof r === 'object' && Number.isFinite(r.input) && Number.isFinite(r.output);
}

export function loadPricing() {
    try {
        const raw = readFileSync(PRICING_OVERRIDE_PATH, 'utf8');
        const override = JSON.parse(raw);
        if (override && typeof override === 'object') {
            // Drop malformed entries so a typo (e.g. `"model": 5`) can't overwrite
            // a valid built-in rate and silently produce NaN costs.
            const clean = {};
            for (const [model, rate] of Object.entries(override)) {
                if (isRate(rate)) clean[model] = rate;
            }
            return { ...DEFAULT_PRICING, ...clean };
        }
    } catch {
        // no override file - defaults
    }
    return DEFAULT_PRICING;
}

// Transcript model ids may carry a "[1m]" window marker or a date suffix; match
// the bare id, else the LONGEST known key that is a prefix (longest = most
// specific, so resolution is independent of object insertion order). Only ever
// returns a well-formed rate, so a malformed entry reads as "unpriced", not NaN.
export function rateFor(model, pricing = DEFAULT_PRICING) {
    if (typeof model !== 'string') return null;
    const clean = model.replace(/\[.*$/, '').trim();
    if (isRate(pricing[clean])) return pricing[clean];
    let best = null;
    for (const key of Object.keys(pricing)) {
        if (clean.startsWith(key) && isRate(pricing[key]) && (!best || key.length > best.length)) {
            best = key;
        }
    }
    return best ? pricing[best] : null;
}

function costForModel(tokens, rate) {
    const inputRate = rate.input / PER_MILLION;
    return (
        (tokens.input || 0) * inputRate +
        (tokens.output || 0) * (rate.output / PER_MILLION) +
        (tokens.cacheRead || 0) * inputRate * CACHE_READ_MULT +
        (tokens.cacheWrite5m || 0) * inputRate * CACHE_WRITE_5M_MULT +
        (tokens.cacheWrite1h || 0) * inputRate * CACHE_WRITE_1H_MULT
    );
}

// byModel: { <model>: {input, output, cacheRead, cacheWrite5m, cacheWrite1h} }
// → { totalUsd, byModel: [{model, usd, tokens, priced}], pricedKnown }
export function costSummary(byModel, pricing = DEFAULT_PRICING) {
    const rows = [];
    let totalUsd = 0;
    let pricedKnown = true;
    for (const [model, tokens] of Object.entries(byModel || {})) {
        const rate = rateFor(model, pricing);
        const priced = Boolean(rate);
        const usd = priced ? costForModel(tokens, rate) : 0;
        if (!priced) pricedKnown = false;
        totalUsd += usd;
        rows.push({ model, usd, tokens, priced });
    }
    rows.sort((a, b) => b.usd - a.usd);
    return { totalUsd, byModel: rows, pricedKnown };
}
