/**
 * Context Header
 * Purpose: Centralizar feature flags de confiabilidade sem quebrar comportamento legado.
 * Inputs/Outputs: Lê process.env e expõe objeto FLAGS imutável.
 * Invariants: Flags têm defaults seguros; parsing boolean consistente.
 * Failure Modes: Valor inválido de env -> usa default.
 * Fallback: Quando desabilitado, fluxo legado deve continuar operacional.
 */

function parseBoolean(value, defaultValue) {
    if (value === undefined || value === null || value === '') return defaultValue;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return defaultValue;
}

const FLAGS = Object.freeze({
    ENABLE_RELIABILITY_LAYER: parseBoolean(process.env.ENABLE_RELIABILITY_LAYER, true),
    ENABLE_IDEMPOTENCY_GUARD: parseBoolean(process.env.ENABLE_IDEMPOTENCY_GUARD, true),
    ENABLE_PERSISTENT_LOGGING: parseBoolean(process.env.ENABLE_PERSISTENT_LOGGING, true),
    ENABLE_DIAGNOSTIC_MODE: parseBoolean(process.env.ENABLE_DIAGNOSTIC_MODE, false),
    ENABLE_TAB_MUTEX: parseBoolean(process.env.ENABLE_TAB_MUTEX, true),
    ENABLE_STRICT_VERSION_CHECK: parseBoolean(process.env.ENABLE_STRICT_VERSION_CHECK, false),
    ENABLE_CLIENT_ERROR_INGEST: parseBoolean(process.env.ENABLE_CLIENT_ERROR_INGEST, true),
    ENABLE_HEALTH_WATCHDOG: parseBoolean(process.env.ENABLE_HEALTH_WATCHDOG, true),
    ENABLE_ADMIN_SOCKET_WATCHDOG: parseBoolean(process.env.ENABLE_ADMIN_SOCKET_WATCHDOG, true),
    ENABLE_ASYNC_ADMIN_NOTIFY: parseBoolean(process.env.ENABLE_ASYNC_ADMIN_NOTIFY, true),
    ENABLE_HEARTBEAT_COALESCING: parseBoolean(process.env.ENABLE_HEARTBEAT_COALESCING, true),
    ENABLE_INMEMORY_HOT_PATH: parseBoolean(process.env.ENABLE_INMEMORY_HOT_PATH, true),
    ENABLE_DURABLE_HOTPATH_QUEUE: parseBoolean(process.env.ENABLE_DURABLE_HOTPATH_QUEUE, true)
});

module.exports = {
    FLAGS
};
