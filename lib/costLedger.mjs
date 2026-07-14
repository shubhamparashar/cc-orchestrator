import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { configDir } from './config.mjs';
import { log } from './logger.mjs';

// Lifetime spend must survive a session being deleted. Cost is otherwise derived
// live from transcript files, so the moment a transcript is removed its spend
// vanishes from the total. We bank each session's high-water-mark USD in a small
// on-disk ledger keyed by sessionId; a deleted session simply stays in the ledger
// and keeps counting toward the lifetime total.
//
// ponytail: high-water mark, so lowering a price in pricing.json won't shrink an
// already-banked session — reset the ledger file to re-price historicals.
//
// { [sessionId]: usd } — highest total ever observed for that session.
let ledger = null;

function ledgerPath() {
    return join(configDir(), 'cost-ledger.json');
}

function load() {
    if (ledger) return ledger;
    try {
        const parsed = JSON.parse(readFileSync(ledgerPath(), 'utf8'));
        ledger = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        ledger = {};
    }
    return ledger;
}

function persist() {
    try {
        mkdirSync(configDir(), { recursive: true, mode: 0o700 });
        writeFileSync(ledgerPath(), JSON.stringify(ledger), { mode: 0o600 });
    } catch (err) {
        log.warn(`cost ledger write failed: ${err.message}`);
    }
}

// Bank the current live sessions' costs (high-water mark per session), persist if
// anything changed, and return the banked USD for sessions NOT currently live —
// i.e. deleted/archived sessions whose spend would otherwise disappear from the
// lifetime total. liveCosts: [{ sessionId, usd }].
export function bankAndDeletedUsd(liveCosts) {
    const l = load();
    let changed = false;
    const liveIds = new Set();
    for (const { sessionId, usd } of liveCosts) {
        if (!sessionId) continue;
        liveIds.add(sessionId);
        if (usd > 0 && !(l[sessionId] >= usd)) {
            l[sessionId] = usd;
            changed = true;
        }
    }
    if (changed) persist();

    let deletedUsd = 0;
    for (const [id, usd] of Object.entries(l)) {
        if (!liveIds.has(id)) deletedUsd += usd;
    }
    return Math.round(deletedUsd * 1e4) / 1e4;
}

// Daily spend must survive transcript deletion too: the day×model rollup is
// derived live, so once a day's transcripts age out its bucket vanishes. Bank
// each day's bucket (high-water mark by usd, whole snapshot including byModel
// so the breakdown stays consistent with the total) in a second ledger file.
//
// { [YYYY-MM-DD]: { usd, byModel } }
let daily = null;

function dailyPath() {
    return join(configDir(), 'daily-usage.json');
}

function loadDaily() {
    if (daily) return daily;
    try {
        const parsed = JSON.parse(readFileSync(dailyPath(), 'utf8'));
        daily = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        daily = {};
    }
    return daily;
}

function persistDaily() {
    try {
        mkdirSync(configDir(), { recursive: true, mode: 0o700 });
        writeFileSync(dailyPath(), JSON.stringify(daily), { mode: 0o600 });
    } catch (err) {
        log.warn(`daily usage ledger write failed: ${err.message}`);
    }
}

// Bank live day buckets ([{ date, usd, byModel }]), then return all buckets with
// banked days merged back in — a day whose transcripts were deleted (or partially
// deleted, live usd below the banked mark) is served from the ledger.
export function bankAndMergeDaily(buckets) {
    const d = loadDaily();
    let changed = false;
    const byDate = new Map();
    for (const b of buckets || []) {
        if (!b?.date) continue;
        byDate.set(b.date, b);
        if (b.usd > 0 && !(d[b.date]?.usd >= b.usd)) {
            d[b.date] = { usd: b.usd, byModel: b.byModel || {} };
            changed = true;
        }
    }
    if (changed) persistDaily();
    for (const [date, banked] of Object.entries(d)) {
        const live = byDate.get(date);
        if (!live || banked.usd > live.usd) byDate.set(date, { date, usd: banked.usd, byModel: banked.byModel || {} });
    }
    const merged = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
    const totalUsd = Math.round(merged.reduce((s, b) => s + b.usd, 0) * 1e4) / 1e4;
    return { buckets: merged, totalUsd };
}

// test-only: drop the in-memory caches so the next call re-reads from disk.
export function _reset() {
    ledger = null;
    daily = null;
}
