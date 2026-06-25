import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Config/state for the orchestrator live in its own dir, never in the read-only
// ~/.claude tree. CC_CONFIG_DIR lets tests and one-off runs point at a throwaway
// location.
export function configDir() {
    return process.env.CC_CONFIG_DIR || join(homedir(), '.config', 'cc-orchestrator');
}

export function configPath() {
    return join(configDir(), 'config.json');
}

// The whole alert subsystem is opt-in: enabled:false means existing users see no
// new notifications until they create a config.json that turns it on.
export const ALERT_DEFAULTS = {
    enabled: false,
    checkIntervalMs: 60000,
    digest: { enabled: true },
    budget: { thresholdUsd: 0 },
    presenceAware: true,
};

function isPlainObject(v) {
    return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

// Shallow-merge the on-disk config over `defaults`, with a one-level deeper merge
// for the `alerts` object so a config that sets only `alerts.budget` doesn't drop
// the `alerts.digest`/`alerts.enabled` defaults. A missing or malformed file
// yields the defaults untouched.
export function loadConfig(defaults = {}) {
    let raw;
    try {
        raw = readFileSync(configPath(), 'utf8');
    } catch {
        return defaults;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return defaults;
    }
    if (!isPlainObject(parsed)) return defaults;

    const merged = { ...defaults, ...parsed };
    if (isPlainObject(defaults.alerts) || isPlainObject(parsed.alerts)) {
        const baseAlerts = isPlainObject(defaults.alerts) ? defaults.alerts : {};
        const overAlerts = isPlainObject(parsed.alerts) ? parsed.alerts : {};
        merged.alerts = {
            ...baseAlerts,
            ...overAlerts,
            digest: { ...baseAlerts.digest, ...overAlerts.digest },
            budget: { ...baseAlerts.budget, ...overAlerts.budget },
        };
    }
    return merged;
}
