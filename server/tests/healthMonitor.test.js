const test = require('node:test');
const assert = require('node:assert/strict');
const { HealthMonitor } = require('../reliability/healthMonitor');

function lcg(seed) {
    let state = seed >>> 0;
    return () => {
        state = (1664525 * state + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

test('health monitor should compute objective metrics', () => {
    const monitor = new HealthMonitor({ heartbeatSlaMs: 10000, windowMs: 60000, maxEvents: 1000 });

    monitor.recordTelemetryEvent({ ok: true, conflict: false, latencyMs: 50, eventType: 'heartbeat' });
    monitor.recordTelemetryEvent({ ok: true, conflict: true, latencyMs: 120, eventType: 'state_change' });
    monitor.recordTelemetryEvent({ ok: false, conflict: false, latencyMs: 300, eventType: 'heartbeat' });

    const now = Date.now();
    const snapshot = monitor.buildSnapshot({
        breakerState: 'CLOSED',
        activeSessions: {
            userA: {
                tab1: { lastSeen: new Date(now - 2000).toISOString() },
                tab2: { lastSeen: new Date(now - 16000).toISOString() }
            }
        }
    });

    assert.equal(snapshot.activeUsers, 1);
    assert.equal(snapshot.activeTabs, 2);
    assert.equal(snapshot.sessionsOverSla, 1);
    assert.equal(snapshot.telemetryEventCount, 3);
    assert.equal(snapshot.telemetryConflictCount, 1);
    assert.equal(snapshot.telemetryFailureCount, 1);
    assert.equal(snapshot.conflictRate, 0.3333);
    assert.equal(snapshot.failureRate, 0.3333);
    assert.equal(snapshot.breakerState, 'CLOSED');
    assert.ok(snapshot.latency.p95Ms >= snapshot.latency.avgMs);
});

test('health monitor pseudo-random invariant check (seed 49)', () => {
    const monitor = new HealthMonitor({ heartbeatSlaMs: 12000, windowMs: 60000, maxEvents: 5000 });
    const rand = lcg(49);

    let expectedFailures = 0;
    let expectedConflicts = 0;
    const totalEvents = 250;

    for (let i = 0; i < totalEvents; i += 1) {
        const ok = rand() > 0.2;
        const conflict = rand() > 0.85;
        const latencyMs = Math.floor(rand() * 500);
        if (!ok) expectedFailures += 1;
        if (conflict) expectedConflicts += 1;
        monitor.recordTelemetryEvent({ ok, conflict, latencyMs, eventType: 'heartbeat' });
    }

    const snapshot = monitor.buildSnapshot({
        breakerState: 'HALF_OPEN',
        activeSessions: {
            userB: { tabX: { lastSeen: new Date().toISOString() } }
        }
    });

    assert.equal(snapshot.telemetryEventCount, totalEvents);
    assert.equal(snapshot.telemetryFailureCount, expectedFailures);
    assert.equal(snapshot.telemetryConflictCount, expectedConflicts);
    assert.equal(snapshot.breakerState, 'HALF_OPEN');
    assert.ok(snapshot.latency.p99Ms >= snapshot.latency.p95Ms);
    assert.ok(snapshot.failureRate >= 0 && snapshot.failureRate <= 1);
    assert.ok(snapshot.conflictRate >= 0 && snapshot.conflictRate <= 1);
});

test('health monitor should classify status by thresholds', () => {
    const monitor = new HealthMonitor({
        degradedP95Ms: 100,
        criticalP95Ms: 200,
        degradedFailureRate: 0.1,
        criticalFailureRate: 0.2,
        degradedConflictRate: 0.05,
        criticalConflictRate: 0.1,
        degradedSessionsOverSla: 1,
        criticalSessionsOverSla: 2
    });

    // Cenário saudável
    monitor.recordTelemetryEvent({ ok: true, conflict: false, latencyMs: 80 });
    let snapshot = monitor.buildSnapshot({
        breakerState: 'CLOSED',
        activeSessions: { u1: { t1: { lastSeen: new Date().toISOString() } } }
    });
    assert.equal(snapshot.healthStatus, 'saudavel');
    assert.ok(snapshot.recommendation.includes('Operação normal'));

    // Cenário degradado por breaker HALF_OPEN
    snapshot = monitor.buildSnapshot({
        breakerState: 'HALF_OPEN',
        activeSessions: { u1: { t1: { lastSeen: new Date().toISOString() } } }
    });
    assert.equal(snapshot.healthStatus, 'degradado');
    assert.ok(snapshot.recommendation.includes('Monitorar de perto'));

    // Cenário crítico por breaker OPEN
    snapshot = monitor.buildSnapshot({
        breakerState: 'OPEN',
        activeSessions: { u1: { t1: { lastSeen: new Date().toISOString() } } }
    });
    assert.equal(snapshot.healthStatus, 'critico');
    assert.ok(snapshot.recommendation.includes('Ação imediata'));
});
