/**
 * Context Header
 * Purpose: Consolidar métricas objetivas de saúde e watchdog de heartbeat.
 * Inputs/Outputs: Recebe eventos de telemetria e retorna snapshot agregada.
 * Invariants: Janela de métricas limitada em memória; sem crescimento infinito.
 * Failure Modes: Perda de histórico ao reiniciar processo.
 * Fallback: Sem eventos, retorna métricas zeradas e estado atual do serviço.
 */
class HealthMonitor {
    constructor(config = {}) {
        this.heartbeatSlaMs = config.heartbeatSlaMs || 12000;
        this.windowMs = config.windowMs || 60000;
        this.maxEvents = config.maxEvents || 5000;
        this.thresholds = {
            degradedP95Ms: Number.isFinite(Number(config.degradedP95Ms)) ? Number(config.degradedP95Ms) : 150,
            criticalP95Ms: Number.isFinite(Number(config.criticalP95Ms)) ? Number(config.criticalP95Ms) : 300,
            degradedFailureRate: Number.isFinite(Number(config.degradedFailureRate)) ? Number(config.degradedFailureRate) : 0.05,
            criticalFailureRate: Number.isFinite(Number(config.criticalFailureRate)) ? Number(config.criticalFailureRate) : 0.15,
            degradedConflictRate: Number.isFinite(Number(config.degradedConflictRate)) ? Number(config.degradedConflictRate) : 0.02,
            criticalConflictRate: Number.isFinite(Number(config.criticalConflictRate)) ? Number(config.criticalConflictRate) : 0.08,
            degradedSessionsOverSla: Number.isFinite(Number(config.degradedSessionsOverSla)) ? Number(config.degradedSessionsOverSla) : 1,
            criticalSessionsOverSla: Number.isFinite(Number(config.criticalSessionsOverSla)) ? Number(config.criticalSessionsOverSla) : 5
        };
        this.telemetryEvents = [];
        this.watchdogAlerts = 0;
        this.lastWatchdogRunAt = null;
    }

    prune(now = Date.now()) {
        const cutoff = now - this.windowMs;
        this.telemetryEvents = this.telemetryEvents.filter((item) => item.ts >= cutoff);
        if (this.telemetryEvents.length > this.maxEvents) {
            this.telemetryEvents = this.telemetryEvents.slice(this.telemetryEvents.length - this.maxEvents);
        }
    }

    recordTelemetryEvent(event = {}) {
        const entry = {
            ts: Date.now(),
            latencyMs: Number.isFinite(Number(event.latencyMs)) ? Number(event.latencyMs) : null,
            ok: event.ok !== false,
            conflict: !!event.conflict,
            eventType: event.eventType || 'unknown'
        };
        this.telemetryEvents.push(entry);
        this.prune();
    }

    recordWatchdogRun() {
        this.lastWatchdogRunAt = new Date().toISOString();
    }

    recordWatchdogAlert() {
        this.watchdogAlerts += 1;
    }

    computeLatencyStats() {
        const latencies = this.telemetryEvents
            .map((item) => item.latencyMs)
            .filter((value) => Number.isFinite(value))
            .sort((a, b) => a - b);

        if (latencies.length === 0) {
            return { avgMs: 0, p95Ms: 0, p99Ms: 0 };
        }

        const sum = latencies.reduce((acc, value) => acc + value, 0);
        const pick = (percent) => {
            const idx = Math.min(latencies.length - 1, Math.floor((percent / 100) * latencies.length));
            return latencies[idx];
        };

        return {
            avgMs: Math.round(sum / latencies.length),
            p95Ms: pick(95),
            p99Ms: pick(99)
        };
    }

    buildSnapshot(input = {}) {
        this.prune();
        const activeSessions = input.activeSessions || {};
        const breakerState = input.breakerState || 'UNKNOWN';
        const now = Date.now();

        let activeUsers = 0;
        let activeTabs = 0;
        let sessionsOverSla = 0;

        for (const tabs of Object.values(activeSessions)) {
            activeUsers += 1;
            for (const session of Object.values(tabs || {})) {
                activeTabs += 1;
                const lastSeenMs = Date.parse(session.lastSeen || 0);
                if (Number.isFinite(lastSeenMs) && now - lastSeenMs > this.heartbeatSlaMs) {
                    sessionsOverSla += 1;
                }
            }
        }

        const latency = this.computeLatencyStats();
        const total = this.telemetryEvents.length;
        const conflicts = this.telemetryEvents.filter((item) => item.conflict).length;
        const failures = this.telemetryEvents.filter((item) => !item.ok).length;

        const snapshot = {
            heartbeatSlaMs: this.heartbeatSlaMs,
            activeUsers,
            activeTabs,
            sessionsOverSla,
            breakerState,
            telemetryWindowMs: this.windowMs,
            telemetryEventCount: total,
            telemetryFailureCount: failures,
            telemetryConflictCount: conflicts,
            conflictRate: total > 0 ? Number((conflicts / total).toFixed(4)) : 0,
            failureRate: total > 0 ? Number((failures / total).toFixed(4)) : 0,
            latency,
            watchdogAlerts: this.watchdogAlerts,
            lastWatchdogRunAt: this.lastWatchdogRunAt,
            thresholds: this.thresholds
        };

        const statusInfo = this.classifyHealth(snapshot);
        return {
            ...snapshot,
            healthStatus: statusInfo.status,
            healthSignals: statusInfo.signals,
            recommendation: this.buildRecommendation(statusInfo.status, statusInfo.signals)
        };
    }

    classifyHealth(snapshot) {
        const signals = [];
        const t = this.thresholds;

        if (snapshot.breakerState === 'OPEN') {
            signals.push('circuit_breaker_open');
            return { status: 'critico', signals };
        }

        if (snapshot.latency.p95Ms >= t.criticalP95Ms) signals.push('latency_p95_critical');
        if (snapshot.failureRate >= t.criticalFailureRate) signals.push('failure_rate_critical');
        if (snapshot.conflictRate >= t.criticalConflictRate) signals.push('conflict_rate_critical');
        if (snapshot.sessionsOverSla >= t.criticalSessionsOverSla) signals.push('sessions_over_sla_critical');
        if (signals.length > 0) {
            return { status: 'critico', signals };
        }

        if (snapshot.breakerState === 'HALF_OPEN') signals.push('circuit_breaker_half_open');
        if (snapshot.latency.p95Ms >= t.degradedP95Ms) signals.push('latency_p95_degraded');
        if (snapshot.failureRate >= t.degradedFailureRate) signals.push('failure_rate_degraded');
        if (snapshot.conflictRate >= t.degradedConflictRate) signals.push('conflict_rate_degraded');
        if (snapshot.sessionsOverSla >= t.degradedSessionsOverSla) signals.push('sessions_over_sla_degraded');
        if (signals.length > 0) {
            return { status: 'degradado', signals };
        }

        return { status: 'saudavel', signals };
    }

    buildRecommendation(status, signals) {
        if (status === 'critico') {
            if (signals.includes('circuit_breaker_open')) {
                return 'Ação imediata: dependência crítica indisponível. Verifique conectividade com banco/Directus e reduza tráfego de escrita.';
            }
            return 'Ação imediata: sistema em estado crítico. Escale incidente, reduza carga e investigue sinais críticos.';
        }
        if (status === 'degradado') {
            return 'Monitorar de perto: sistema degradado. Ajuste limites, acompanhe latência/falhas e prepare mitigação.';
        }
        return 'Operação normal: sistema saudável. Manter monitoramento contínuo.';
    }
}

module.exports = {
    HealthMonitor
};
