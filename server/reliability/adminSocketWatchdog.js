/**
 * Context Header
 * Purpose: Coordenar watchdog de sockets admin (ping/pong + stale detection).
 * Inputs/Outputs: Recebe eventos de socket e emite pings periódicos via io.
 * Invariants: Estado por socketId é limpo em disconnect ou ausência de socket.
 * Failure Modes: Perda de estado após restart do processo.
 * Fallback: Sem sockets ativos, tick não executa nenhuma ação.
 */
class AdminSocketWatchdog {
    constructor(config = {}) {
        this.staleMs = config.staleMs || 30000;
        this.healthBySocket = new Map();
    }

    onJoin(socketId, now = Date.now()) {
        this.healthBySocket.set(socketId, { lastPongAt: now });
    }

    onPong(socketId, now = Date.now()) {
        this.healthBySocket.set(socketId, { lastPongAt: now });
    }

    onDisconnect(socketId) {
        this.healthBySocket.delete(socketId);
    }

    tick(io, logger, now = Date.now()) {
        for (const [socketId, info] of this.healthBySocket.entries()) {
            const socket = io.sockets.sockets.get(socketId);
            if (!socket) {
                this.healthBySocket.delete(socketId);
                continue;
            }

            socket.emit('admin_watchdog_ping', { serverTs: now });
            if (now - info.lastPongAt > this.staleMs) {
                logger.warn('Watchdog de socket admin sem resposta', {
                    action: 'watchdog.adminSocket',
                    socketId,
                    staleForMs: now - info.lastPongAt
                });
            }
        }
    }
}

module.exports = {
    AdminSocketWatchdog
};
