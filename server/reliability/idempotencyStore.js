/**
 * Context Header
 * Purpose: Evitar efeitos colaterais duplicados em retries da mesma operação.
 * Inputs/Outputs: operationId -> resultado previamente confirmado.
 * Invariants: Chaves expiram por TTL para não crescer indefinidamente.
 * Failure Modes: Store em memória perde estado após restart.
 * Fallback: Sem chave válida, segue fluxo normal.
 */
class IdempotencyStore {
    constructor(config = {}) {
        this.ttlMs = config.ttlMs || 2 * 60 * 1000;
        this.maxEntries = config.maxEntries || 50000;
        this.cache = new Map();
    }

    cleanup() {
        const now = Date.now();
        for (const [key, value] of this.cache.entries()) {
            if (value.expiresAt <= now) this.cache.delete(key);
        }
        if (this.cache.size > this.maxEntries) {
            const removeCount = this.cache.size - this.maxEntries;
            const keys = this.cache.keys();
            for (let idx = 0; idx < removeCount; idx += 1) {
                const key = keys.next().value;
                if (!key) break;
                this.cache.delete(key);
            }
        }
    }

    get(operationId) {
        if (!operationId) return null;
        this.cleanup();
        const value = this.cache.get(operationId);
        if (!value) return null;
        if (value.expiresAt <= Date.now()) {
            this.cache.delete(operationId);
            return null;
        }
        return value.payload;
    }

    set(operationId, payload) {
        if (!operationId) return;
        this.cleanup();
        this.cache.set(operationId, {
            payload,
            expiresAt: Date.now() + this.ttlMs
        });
    }
}

module.exports = {
    IdempotencyStore
};
