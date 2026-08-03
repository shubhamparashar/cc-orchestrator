#!/usr/bin/env node
// Prompt-cache hit rate across Claude Code transcripts, aggregated per day.
// hit rate = cache_read / (cache_read + cache_creation + input); uncached
// input is billed full price, cache creation at 1.25-2x, reads at 0.1x, so
// this is the number a per-turn-varying prompt prefix drags down.
// Usage: node scripts/cache-stats.mjs [--days N] [--project <dir-name-substring>]
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const days = Number(args[args.indexOf('--days') + 1]) || 14;
const projFilter = args.includes('--project') ? args[args.indexOf('--project') + 1] : '';
const cutoff = Date.now() - days * 86400000;

const root = join(homedir(), '.claude', 'projects');
const files = [];
for (const dir of readdirSync(root)) {
    if (projFilter && !dir.includes(projFilter)) continue;
    const d = join(root, dir);
    let entries;
    try { entries = readdirSync(d); } catch { continue; }
    for (const f of entries) {
        if (!f.endsWith('.jsonl')) continue;
        const p = join(d, f);
        try { if (statSync(p).mtimeMs >= cutoff) files.push(p); } catch { /* gone */ }
    }
}

const byDay = new Map();
for (const p of files) {
    const rl = createInterface({ input: createReadStream(p), crlfDelay: Infinity });
    for await (const line of rl) {
        if (!line.includes('"cache_read_input_tokens"')) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        const u = e.message?.usage;
        const ts = Date.parse(e.timestamp);
        if (!u || !ts || ts < cutoff) continue;
        const day = e.timestamp.slice(0, 10);
        const s = byDay.get(day) || { read: 0, create: 0, input: 0, turns: 0 };
        s.read += u.cache_read_input_tokens || 0;
        s.create += u.cache_creation_input_tokens || 0;
        s.input += u.input_tokens || 0;
        s.turns += 1;
        byDay.set(day, s);
    }
}

const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.round(n / 1e3) + 'k';
const tot = { read: 0, create: 0, input: 0, turns: 0 };
console.log('day         turns   cache-read  cache-write  uncached   hit-rate');
for (const day of [...byDay.keys()].sort()) {
    const s = byDay.get(day);
    for (const k of ['read', 'create', 'input', 'turns']) tot[k] += s[k];
    const denom = s.read + s.create + s.input;
    console.log(`${day}  ${String(s.turns).padStart(5)}   ${fmt(s.read).padStart(10)}  ${fmt(s.create).padStart(11)}  ${fmt(s.input).padStart(8)}   ${denom ? ((100 * s.read) / denom).toFixed(1) : '-'}%`);
}
const denom = tot.read + tot.create + tot.input;
console.log(`TOTAL       ${String(tot.turns).padStart(5)}   ${fmt(tot.read).padStart(10)}  ${fmt(tot.create).padStart(11)}  ${fmt(tot.input).padStart(8)}   ${denom ? ((100 * tot.read) / denom).toFixed(1) : '-'}%`);
