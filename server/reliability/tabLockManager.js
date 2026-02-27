/**
 * Context Header
 * Purpose: Garantir atualização atômica por chave (tabId) no processo Node.
 * Inputs/Outputs: Recebe chave e callback assíncrono; executa callback em exclusão mútua por chave.
 * Invariants: Apenas um callback por chave é executado por vez.
 * Failure Modes: Callback falha e propaga erro ao chamador.
 * Fallback: Chamador pode bypassar lock via feature flag.
 */
class TabLockManager {
    constructor() {
        this.locks = new Map();
    }

    async withLock(key, callback) {
        const queue = this.locks.get(key) || Promise.resolve();
        let release;
        const current = new Promise((resolve) => {
            release = resolve;
        });

        const pending = queue.then(() => current);
        this.locks.set(key, pending);
        await queue;

        try {
            return await callback();
        } finally {
            release();
            if (this.locks.get(key) === pending) {
                this.locks.delete(key);
            }
        }
    }
}

module.exports = {
    TabLockManager
};
