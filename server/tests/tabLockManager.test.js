const test = require('node:test');
const assert = require('node:assert/strict');
const { TabLockManager } = require('../reliability/tabLockManager');

test('tab lock manager should serialize same key', async () => {
    const manager = new TabLockManager();
    const execution = [];

    const run = (id, delay) => manager.withLock('same-tab', async () => {
        execution.push(`start-${id}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        execution.push(`end-${id}`);
    });

    await Promise.all([run(1, 30), run(2, 5), run(3, 1)]);

    assert.deepEqual(execution, [
        'start-1', 'end-1',
        'start-2', 'end-2',
        'start-3', 'end-3'
    ]);
});

test('tab lock manager should not block different keys', async () => {
    const manager = new TabLockManager();
    const timestamps = {};

    await Promise.all([
        manager.withLock('tab-a', async () => {
            timestamps.aStart = Date.now();
            await new Promise((resolve) => setTimeout(resolve, 25));
            timestamps.aEnd = Date.now();
        }),
        manager.withLock('tab-b', async () => {
            timestamps.bStart = Date.now();
            await new Promise((resolve) => setTimeout(resolve, 25));
            timestamps.bEnd = Date.now();
        })
    ]);

    assert.ok(Math.abs(timestamps.aStart - timestamps.bStart) < 20);
    assert.ok(timestamps.aEnd >= timestamps.aStart);
    assert.ok(timestamps.bEnd >= timestamps.bStart);
});
