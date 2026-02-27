const test = require('node:test');
const assert = require('node:assert/strict');
const { IdempotencyStore } = require('../reliability/idempotencyStore');

test('idempotency store should return saved payload by key', () => {
    const store = new IdempotencyStore({ ttlMs: 1000, maxEntries: 10 });
    store.set('op-1', { ok: true, value: 10 });
    assert.deepEqual(store.get('op-1'), { ok: true, value: 10 });
});

test('idempotency store should expire entries by ttl', async () => {
    const store = new IdempotencyStore({ ttlMs: 20, maxEntries: 10 });
    store.set('op-expire', { ok: true });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(store.get('op-expire'), null);
});

test('idempotency store should trim old entries when exceeding max', () => {
    const store = new IdempotencyStore({ ttlMs: 1000, maxEntries: 2 });
    store.set('op-1', { v: 1 });
    store.set('op-2', { v: 2 });
    store.set('op-3', { v: 3 });
    const nonNull = ['op-1', 'op-2', 'op-3'].map((k) => store.get(k)).filter(Boolean);
    assert.equal(nonNull.length, 2);
});
