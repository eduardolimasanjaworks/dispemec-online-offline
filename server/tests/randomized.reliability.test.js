const test = require('node:test');
const assert = require('node:assert/strict');
const { randomInt } = require('node:crypto');
const { TabLockManager } = require('../reliability/tabLockManager');
const { HealthMonitor } = require('../reliability/healthMonitor');

function lcg(seed) {
    let state = seed >>> 0;
    return () => {
        state = (1664525 * state + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

function pickSeed() {
    const envSeed = Number(process.env.TEST_SEED || 0);
    if (Number.isFinite(envSeed) && envSeed > 0) return envSeed;
    return randomInt(1, 1_000_000_000);
}

test('randomized lock invariant: nunca executar mesmo tab em paralelo', async (t) => {
    const seed = pickSeed();
    t.diagnostic(`seed=${seed}`);
    const rand = lcg(seed);
    const lockManager = new TabLockManager();

    const keys = ['tab-a', 'tab-b', 'tab-c', 'tab-d'];
    const inFlightPerKey = new Map();
    const maxInFlightPerKey = new Map();

    const tasks = Array.from({ length: 80 }, (_, idx) => (async () => {
        const key = keys[Math.floor(rand() * keys.length)];
        const delay = Math.floor(rand() * 8);
        await lockManager.withLock(key, async () => {
            const current = (inFlightPerKey.get(key) || 0) + 1;
            inFlightPerKey.set(key, current);
            maxInFlightPerKey.set(key, Math.max(maxInFlightPerKey.get(key) || 0, current));
            await new Promise((resolve) => setTimeout(resolve, delay));
            inFlightPerKey.set(key, (inFlightPerKey.get(key) || 1) - 1);
        });
        return idx;
    })());

    await Promise.all(tasks);

    for (const key of keys) {
        const maxObserved = maxInFlightPerKey.get(key) || 0;
        assert.ok(maxObserved <= 1, `lock violado para ${key}, maxObserved=${maxObserved}`);
    }
});

test('randomized health invariants: taxas e latências válidas sob eventos aleatórios', (t) => {
    const seed = pickSeed();
    t.diagnostic(`seed=${seed}`);
    const rand = lcg(seed);
    const monitor = new HealthMonitor({
        heartbeatSlaMs: 12000,
        windowMs: 60000,
        maxEvents: 10000
    });

    let expectedFailures = 0;
    let expectedConflicts = 0;
    let generated = 0;
    const latencies = [];

    for (let i = 0; i < 500; i += 1) {
        const ok = rand() > 0.22;
        const conflict = rand() > 0.9;
        const latencyMs = Math.floor(rand() * 1200);
        monitor.recordTelemetryEvent({ ok, conflict, latencyMs, eventType: 'heartbeat' });
        generated += 1;
        if (!ok) expectedFailures += 1;
        if (conflict) expectedConflicts += 1;
        latencies.push(latencyMs);
    }

    const now = Date.now();
    const activeSessions = {
        u1: {
            t1: { lastSeen: new Date(now - 1000).toISOString() },
            t2: { lastSeen: new Date(now - 30000).toISOString() }
        },
        u2: {
            t3: { lastSeen: new Date(now - 2000).toISOString() }
        }
    };

    const snapshot = monitor.buildSnapshot({ activeSessions, breakerState: 'CLOSED' });

    assert.equal(snapshot.telemetryEventCount, generated);
    assert.equal(snapshot.telemetryFailureCount, expectedFailures);
    assert.equal(snapshot.telemetryConflictCount, expectedConflicts);
    assert.ok(snapshot.failureRate >= 0 && snapshot.failureRate <= 1);
    assert.ok(snapshot.conflictRate >= 0 && snapshot.conflictRate <= 1);
    assert.ok(snapshot.latency.p99Ms >= snapshot.latency.p95Ms);
    assert.ok(snapshot.latency.p95Ms >= 0);
    assert.ok(snapshot.latency.avgMs >= 0);
    assert.equal(snapshot.activeUsers, 2);
    assert.equal(snapshot.activeTabs, 3);
    assert.equal(snapshot.sessionsOverSla, 1);
    assert.equal(snapshot.breakerState, 'CLOSED');

    // Invariante adicional para reduzir viés: média do monitor deve ficar próxima da média real calculada.
    const realAvg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
    assert.ok(Math.abs(snapshot.latency.avgMs - realAvg) <= 1);
});
