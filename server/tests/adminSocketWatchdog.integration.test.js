const test = require('node:test');
const assert = require('node:assert/strict');
const { AdminSocketWatchdog } = require('../reliability/adminSocketWatchdog');

function createFakeSocket() {
    return {
        emitted: [],
        emit(event, payload) {
            this.emitted.push({ event, payload });
        }
    };
}

function createFakeIo(socketMap) {
    return {
        sockets: {
            sockets: socketMap
        }
    };
}

test('integration: admin socket watchdog should ping active socket and warn on stale pong', () => {
    const watchdog = new AdminSocketWatchdog({ staleMs: 1000 });
    const socket = createFakeSocket();
    const sockets = new Map([['socket-1', socket]]);
    const io = createFakeIo(sockets);
    const warnings = [];
    const logger = {
        warn(msg, ctx) {
            warnings.push({ msg, ctx });
        }
    };

    const joinedAt = 1000;
    watchdog.onJoin('socket-1', joinedAt);

    // Primeira rodada: deve pingar sem warning (não está stale ainda).
    watchdog.tick(io, logger, 1500);
    assert.equal(socket.emitted.length, 1);
    assert.equal(socket.emitted[0].event, 'admin_watchdog_ping');
    assert.equal(warnings.length, 0);

    // Segunda rodada: stale, deve pingar e avisar.
    watchdog.tick(io, logger, 2605);
    assert.equal(socket.emitted.length, 2);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].ctx.socketId, 'socket-1');
    assert.ok(warnings[0].ctx.staleForMs > 1000);

    // Recebe pong e volta ao normal.
    watchdog.onPong('socket-1', 3000);
    watchdog.tick(io, logger, 3500);
    assert.equal(warnings.length, 1);

    // Disconnect deve limpar estado interno.
    watchdog.onDisconnect('socket-1');
    watchdog.tick(io, logger, 4500);
    assert.equal(socket.emitted.length, 3);
});
