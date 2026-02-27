const test = require('node:test');
const assert = require('node:assert/strict');
const { HealthMonitor } = require('../reliability/healthMonitor');

test('integration: watchdog + telemetry pipeline should produce consistent health snapshot', () => {
    const monitor = new HealthMonitor({
        heartbeatSlaMs: 10000,
        windowMs: 60000,
        maxEvents: 1000
    });

    // Simula pipeline do servidor: eventos de telemetria recebidos ao longo da janela.
    monitor.recordTelemetryEvent({ ok: true, conflict: false, latencyMs: 40, eventType: 'heartbeat' });
    monitor.recordTelemetryEvent({ ok: true, conflict: true, latencyMs: 95, eventType: 'state_change' });
    monitor.recordTelemetryEvent({ ok: false, conflict: false, latencyMs: 180, eventType: 'heartbeat' });

    // Simula execução do watchdog periódico no backend.
    monitor.recordWatchdogRun();
    monitor.recordWatchdogAlert();

    const now = Date.now();
    const activeSessions = {
        user1: {
            tabA: { lastSeen: new Date(now - 2000).toISOString() },
            tabB: { lastSeen: new Date(now - 16000).toISOString() }
        },
        user2: {
            tabC: { lastSeen: new Date(now - 1000).toISOString() }
        }
    };

    const snapshot = monitor.buildSnapshot({
        activeSessions,
        breakerState: 'CLOSED'
    });

    assert.equal(snapshot.activeUsers, 2);
    assert.equal(snapshot.activeTabs, 3);
    assert.equal(snapshot.sessionsOverSla, 1);
    assert.equal(snapshot.telemetryEventCount, 3);
    assert.equal(snapshot.telemetryConflictCount, 1);
    assert.equal(snapshot.telemetryFailureCount, 1);
    assert.equal(snapshot.watchdogAlerts, 1);
    assert.equal(snapshot.breakerState, 'CLOSED');
    assert.ok(typeof snapshot.lastWatchdogRunAt === 'string' && snapshot.lastWatchdogRunAt.length > 0);
    assert.ok(snapshot.latency.p99Ms >= snapshot.latency.p95Ms);
});
