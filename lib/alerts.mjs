import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { configDir } from './config.mjs';
import { osNotify } from './notify.mjs';
import { isUserPresent } from './presence.mjs';
import { log } from './logger.mjs';

const ALERT_STATE_FILE = 'alert-state.json';
const NOTIFY_TITLE = 'cc-orchestrator';

function stateFilePath() {
    return join(configDir(), ALERT_STATE_FILE);
}

async function writeAtomic(path, content) {
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, path);
}

async function readState() {
    try {
        const raw = await readFile(stateFilePath(), 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

// Pure decision core: given the current observation and the previous alert state,
// decide which notifications to fire and what the next persisted state is. No I/O,
// so it is fully unit-testable. The master `alerts.enabled` switch is enforced by
// the caller (the server only schedules checks when enabled), not here — this
// function evaluates the per-type rules unconditionally.
//
//  - Digest: fires when there are sessions waiting AND the count changed since the
//    last notification (dedup), unless the user is present and presence-aware
//    suppression is on. The next state always records the current count, so a
//    suppressed cycle still updates the baseline and won't re-fire the same count
//    later. Disabled entirely via alerts.digest.enabled = false.
//  - Budget: fires at most once per UTC day, the first time the day's spend reaches
//    the threshold. A threshold of 0 disables it. Not presence-suppressed — spend
//    matters even while you're at the keyboard.
export function evaluateAlerts({ waitingCount, todayUsd, config, prevState, today, present }) {
    const alerts = config?.alerts || {};
    const prev = prevState || {};
    const notifications = [];
    const nextState = {
        digest: { ...prev.digest },
        budget: { ...prev.budget },
    };

    const digestCfg = alerts.digest || {};
    if (digestCfg.enabled) {
        const suppressed = Boolean(alerts.presenceAware && present);
        const changed = waitingCount !== prev.digest?.lastCount;
        if (waitingCount > 0 && changed && !suppressed) {
            notifications.push({
                type: 'digest',
                title: NOTIFY_TITLE,
                message: `${waitingCount} session(s) waiting on your input`,
            });
        }
        nextState.digest.lastCount = waitingCount;
    }

    const budgetCfg = alerts.budget || {};
    const threshold = budgetCfg.thresholdUsd || 0;
    if (threshold > 0 && todayUsd >= threshold && prev.budget?.lastDayNotified !== today) {
        notifications.push({
            type: 'budget',
            title: NOTIFY_TITLE,
            message: `Today's spend crossed $${threshold} (now $${todayUsd.toFixed(2)})`,
        });
        nextState.budget.lastDayNotified = today;
    }

    return { notifications, nextState };
}

// Single-flight: a slow scan can let the check interval queue several ticks that
// then run back-to-back. Without this, two overlapping runs both read the state
// before either writes it (a read-modify-write race) and the once-per-day budget
// alert can fire twice. Coalescing overlapping calls into one keeps the dedup and
// once-per-UTC-day guarantees intact.
let inFlightCheck = null;

// Impure orchestrator: gather the live observation, run the pure evaluator, fire
// the OS notifications, and persist the next state. Never throws — a failure here
// must not take down the refresh loop that schedules it.
export function checkAlerts(opts) {
    if (inFlightCheck) return inFlightCheck;
    inFlightCheck = runCheck(opts).finally(() => { inFlightCheck = null; });
    return inFlightCheck;
}

async function runCheck({ getSessions, getTodayUsd, config, now = Date.now() }) {
    try {
        const sessions = await getSessions();
        const waitingCount = sessions.filter((s) => s.status === 'waiting-on-input').length;
        // Pricing the whole corpus is the expensive part of a tick. Skip it
        // entirely when the budget alert is off (threshold 0) so a digest-only
        // setup doesn't re-read every transcript on each interval.
        const budgetActive = (config?.alerts?.budget?.thresholdUsd || 0) > 0;
        const todayUsd = budgetActive ? (await getTodayUsd()) || 0 : 0;
        const today = new Date(now).toISOString().slice(0, 10);
        const present = isUserPresent();
        const prevState = await readState();

        const { notifications, nextState } = evaluateAlerts({
            waitingCount, todayUsd, config, prevState, today, present,
        });

        for (const n of notifications) {
            await osNotify({ title: n.title, message: n.message });
        }

        await mkdir(configDir(), { recursive: true });
        await writeAtomic(stateFilePath(), JSON.stringify(nextState));
        return { notifications, nextState };
    } catch (err) {
        log.error(`checkAlerts failed: ${err?.stack || err}`);
        return { notifications: [], nextState: null };
    }
}
