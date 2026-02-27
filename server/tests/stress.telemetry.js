#!/usr/bin/env node
const { randomInt, randomUUID } = require('node:crypto');

function lcg(seed) {
    let state = seed >>> 0;
    return () => {
        state = (1664525 * state + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

function percentile(sortedValues, p) {
    if (!sortedValues.length) return 0;
    const idx = Math.min(sortedValues.length - 1, Math.floor((p / 100) * sortedValues.length));
    return sortedValues[idx];
}

function parseArgs(argv) {
    const args = {
        target: process.env.STRESS_TARGET || 'http://localhost:8090',
        agents: Number(process.env.STRESS_AGENTS || 120),
        durationSec: Number(process.env.STRESS_DURATION_SEC || 300),
        heartbeatMs: Number(process.env.STRESS_HEARTBEAT_MS || 3000),
        seed: Number(process.env.STRESS_SEED || 0),
        userIds: (process.env.STRESS_USER_IDS || '')
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean),
        dryRun: false
    };

    for (let i = 2; i < argv.length; i += 1) {
        const current = argv[i];
        const next = argv[i + 1];
        if (current === '--target' && next) {
            args.target = next;
            i += 1;
        } else if (current === '--agents' && next) {
            args.agents = Number(next);
            i += 1;
        } else if (current === '--duration' && next) {
            args.durationSec = Number(next);
            i += 1;
        } else if (current === '--heartbeat' && next) {
            args.heartbeatMs = Number(next);
            i += 1;
        } else if (current === '--seed' && next) {
            args.seed = Number(next);
            i += 1;
        } else if (current === '--user-ids' && next) {
            args.userIds = next.split(',').map((value) => value.trim()).filter(Boolean);
            i += 1;
        } else if (current === '--dry-run') {
            args.dryRun = true;
        }
    }

    if (!Number.isFinite(args.seed) || args.seed <= 0) {
        args.seed = randomInt(1, 1_000_000_000);
    }
    return args;
}

async function fetchDirectusUserIds(maxUsers) {
    const directusUrl = process.env.DIRECTUS_URL;
    const directusToken = process.env.DIRECTUS_TOKEN;
    if (!directusUrl || !directusToken) return [];

    const url = `${directusUrl.replace(/\/$/, '')}/items/Telemetry_Users?limit=${maxUsers}&fields=id`;
    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${directusToken}`
        }
    });
    if (!response.ok) return [];

    let payload = null;
    try {
        payload = await response.json();
    } catch (_ignored) {
        return [];
    }
    return Array.isArray(payload?.data)
        ? payload.data.map((row) => row?.id).filter(Boolean)
        : [];
}

async function resolveUserIds(cfg) {
    if (cfg.userIds.length > 0) {
        return {
            userIds: cfg.userIds,
            source: 'env_or_arg'
        };
    }

    const dynamicUserIds = await fetchDirectusUserIds(Math.max(1, Math.ceil(cfg.agents / 2)));
    if (dynamicUserIds.length > 0) {
        return {
            userIds: dynamicUserIds,
            source: 'directus'
        };
    }

    return {
        userIds: Array.from({ length: Math.max(1, Math.ceil(cfg.agents / 2)) }, (_v, idx) => `stress-user-${idx}`),
        source: 'synthetic_fallback'
    };
}

async function postJson(url, body) {
    const started = Date.now();
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    let payload = null;
    try {
        payload = await response.json();
    } catch (_ignored) {
        // payload opcional
    }
    return {
        ok: response.ok,
        status: response.status,
        payload,
        latencyMs: Date.now() - started
    };
}

async function getJson(url) {
    const response = await fetch(url);
    let payload = null;
    try {
        payload = await response.json();
    } catch (_ignored) {
        // payload opcional
    }
    return { ok: response.ok, status: response.status, payload };
}

async function run() {
    const cfg = parseArgs(process.argv);
    const rand = lcg(cfg.seed);
    const userPool = await resolveUserIds(cfg);

    if (cfg.dryRun) {
        console.log(JSON.stringify({
            mode: 'dry-run',
            config: cfg,
            userPoolSource: userPool.source,
            userPoolSize: userPool.userIds.length
        }, null, 2));
        return;
    }

    const telemetryUrl = `${cfg.target}/api/telemetry`;
    const healthUrl = `${cfg.target}/api/admin/health`;

    const agentState = Array.from({ length: cfg.agents }, (_, idx) => ({
        userId: userPool.userIds[idx % userPool.userIds.length],
        tabId: randomUUID(),
        version: null
    }));

    const metrics = {
        totalRequests: 0,
        okCount: 0,
        conflictCount: 0,
        failureCount: 0,
        latency: [],
        startedAt: new Date().toISOString(),
        seed: cfg.seed
    };

    const initialHealth = await getJson(healthUrl).catch(() => ({ ok: false, status: 0, payload: null }));
    const endAt = Date.now() + cfg.durationSec * 1000;

    while (Date.now() < endAt) {
        const batch = agentState.map(async (agent) => {
            const eventTypeRand = rand();
            const eventType = eventTypeRand > 0.85 ? 'state_change' : 'heartbeat';
            const state = rand() > 0.5 ? 'TAB_ACTIVE_FOCUSED' : 'TAB_ACTIVE_VISIBLE_UNFOCUSED';

            const payload = {
                userId: agent.userId,
                tabId: agent.tabId,
                type: eventType,
                state,
                timestamp: Date.now()
            };
            if (agent.version !== null) payload.version = agent.version;

            try {
                const result = await postJson(telemetryUrl, payload);
                metrics.totalRequests += 1;
                metrics.latency.push(result.latencyMs);

                if (result.ok) {
                    metrics.okCount += 1;
                    if (Number.isFinite(Number(result.payload?.sessionVersion))) {
                        agent.version = Number(result.payload.sessionVersion);
                    }
                    return;
                }

                if (result.status === 409) {
                    metrics.conflictCount += 1;
                    const conflictCurrent = Number(result.payload?.conflict?.currentVersion);
                    if (Number.isFinite(conflictCurrent)) {
                        agent.version = conflictCurrent;
                    }
                    return;
                }

                metrics.failureCount += 1;
            } catch (_error) {
                metrics.totalRequests += 1;
                metrics.failureCount += 1;
            }
        });

        await Promise.all(batch);
        await new Promise((resolve) => setTimeout(resolve, cfg.heartbeatMs));
    }

    const finalHealth = await getJson(healthUrl).catch(() => ({ ok: false, status: 0, payload: null }));
    const sortedLatency = [...metrics.latency].sort((a, b) => a - b);
    const throughputRps = Number((metrics.totalRequests / Math.max(1, cfg.durationSec)).toFixed(2));
    const successRate = metrics.totalRequests > 0
        ? Number((metrics.okCount / metrics.totalRequests).toFixed(4))
        : 0;

    const report = {
        config: cfg,
        userPool: {
            source: userPool.source,
            size: userPool.userIds.length
        },
        summary: {
            totalRequests: metrics.totalRequests,
            okCount: metrics.okCount,
            conflictCount: metrics.conflictCount,
            failureCount: metrics.failureCount,
            successRate,
            throughputRps,
            latency: {
                avgMs: sortedLatency.length
                    ? Math.round(sortedLatency.reduce((acc, v) => acc + v, 0) / sortedLatency.length)
                    : 0,
                p95Ms: percentile(sortedLatency, 95),
                p99Ms: percentile(sortedLatency, 99)
            }
        },
        health: {
            before: initialHealth.payload?.health || null,
            after: finalHealth.payload?.health || null
        },
        acceptanceHints: {
            targetP95Ms: 100,
            targetFailureRate: 0.01,
            observedP95Ms: percentile(sortedLatency, 95),
            observedFailureRate: metrics.totalRequests > 0
                ? Number((metrics.failureCount / metrics.totalRequests).toFixed(4))
                : 0
        }
    };

    console.log(JSON.stringify(report, null, 2));
}

run().catch((error) => {
    console.error(JSON.stringify({
        error: 'stress_run_failed',
        message: error.message
    }, null, 2));
    process.exitCode = 1;
});
