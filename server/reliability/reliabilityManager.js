/**
 * Context Header
 * Purpose: Encapsular retry com backoff exponencial e circuit breaker.
 * Inputs/Outputs: Executa operações assíncronas com política resiliente.
 * Invariants: Não executa chamada quando circuito está aberto.
 * Failure Modes: Operação continua falhando após retries.
 * Fallback: Chamador pode usar caminho legado quando policy desabilitada.
 */
class ReliabilityManager {
    constructor(config = {}) {
        this.maxRetries = config.maxRetries || 3;
        this.baseDelayMs = config.baseDelayMs || 100;
        this.maxDelayMs = config.maxDelayMs || 2000;
        this.failureThreshold = config.failureThreshold || 5;
        this.openDurationMs = config.openDurationMs || 15000;

        this.state = 'CLOSED';
        this.failureCount = 0;
        this.openedAt = 0;
    }

    isOpen() {
        if (this.state !== 'OPEN') return false;
        const elapsed = Date.now() - this.openedAt;
        if (elapsed >= this.openDurationMs) {
            this.state = 'HALF_OPEN';
            return false;
        }
        return true;
    }

    onSuccess() {
        this.failureCount = 0;
        this.state = 'CLOSED';
    }

    onFailure() {
        this.failureCount += 1;
        if (this.failureCount >= this.failureThreshold) {
            this.state = 'OPEN';
            this.openedAt = Date.now();
        }
    }

    computeDelay(attempt) {
        const exp = Math.min(this.maxDelayMs, this.baseDelayMs * (2 ** attempt));
        const jitter = Math.floor(Math.random() * Math.max(10, exp * 0.2));
        return exp + jitter;
    }

    async sleep(ms) {
        await new Promise((resolve) => setTimeout(resolve, ms));
    }

    async execute(operationName, operation, hooks = {}) {
        if (this.isOpen()) {
            const error = new Error(`Circuito aberto: ${operationName}`);
            error.code = 'CIRCUIT_OPEN';
            if (hooks.onCircuitOpen) hooks.onCircuitOpen({ operationName, state: this.state });
            throw error;
        }

        for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
            try {
                const result = await operation();
                this.onSuccess();
                if (hooks.onSuccess) hooks.onSuccess({ operationName, attempt, state: this.state });
                return result;
            } catch (error) {
                this.onFailure();
                if (hooks.onRetry) {
                    hooks.onRetry({
                        operationName,
                        attempt,
                        errorMessage: error.message,
                        breakerState: this.state
                    });
                }

                if (attempt >= this.maxRetries) {
                    if (hooks.onFailure) {
                        hooks.onFailure({
                            operationName,
                            attempt,
                            errorMessage: error.message,
                            breakerState: this.state
                        });
                    }
                    throw error;
                }
                await this.sleep(this.computeDelay(attempt));
            }
        }

        throw new Error(`Execução interrompida: ${operationName}`);
    }
}

module.exports = {
    ReliabilityManager
};
