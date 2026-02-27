const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');
const { FLAGS } = require('./reliability/featureFlags');
const { LoggingManager } = require('./reliability/loggingManager');
const { ReliabilityManager } = require('./reliability/reliabilityManager');
const { IdempotencyStore } = require('./reliability/idempotencyStore');
const { TabLockManager } = require('./reliability/tabLockManager');
const { HealthMonitor } = require('./reliability/healthMonitor');
const { AdminSocketWatchdog } = require('./reliability/adminSocketWatchdog');

// Directus SDK
const { createDirectus, rest, staticToken, createItem, readItem, readItems, updateItem, deleteItem } = require('@directus/sdk');

// Variáveis de ambiente
const DIRECTUS_URL = process.env.DIRECTUS_URL || "http://91.99.137.101:8056/";
const DIRECTUS_TOKEN = process.env.DIRECTUS_TOKEN || "UuazE-Np-VrpGxmqe-bEpysiTSjV8_YR";

const directus = createDirectus(DIRECTUS_URL)
    .with(staticToken(DIRECTUS_TOKEN))
    .with(rest());

const logger = new LoggingManager({
    logsDir: path.join(__dirname, 'logs'),
    maxFileSizeBytes: Number(process.env.LOG_MAX_FILE_BYTES || 5 * 1024 * 1024),
    maxBackups: Number(process.env.LOG_MAX_BACKUPS || 5)
});
const reliability = new ReliabilityManager({
    maxRetries: Number(process.env.RETRY_MAX_ATTEMPTS || 3),
    baseDelayMs: Number(process.env.RETRY_BASE_DELAY_MS || 80),
    maxDelayMs: Number(process.env.RETRY_MAX_DELAY_MS || 1800),
    failureThreshold: Number(process.env.CB_FAILURE_THRESHOLD || 5),
    openDurationMs: Number(process.env.CB_OPEN_MS || 15000)
});
const idempotencyStore = new IdempotencyStore({
    ttlMs: Number(process.env.IDEMPOTENCY_TTL_MS || 2 * 60 * 1000),
    maxEntries: Number(process.env.IDEMPOTENCY_MAX_ENTRIES || 50000)
});
const tabLockManager = new TabLockManager();
const healthMonitor = new HealthMonitor({
    heartbeatSlaMs: Number(process.env.HEARTBEAT_SLA_MS || 12000),
    windowMs: Number(process.env.HEALTH_WINDOW_MS || 60000),
    maxEvents: Number(process.env.HEALTH_MAX_EVENTS || 5000),
    degradedP95Ms: Number(process.env.HEALTH_DEGRADED_P95_MS || 150),
    criticalP95Ms: Number(process.env.HEALTH_CRITICAL_P95_MS || 300),
    degradedFailureRate: Number(process.env.HEALTH_DEGRADED_FAILURE_RATE || 0.05),
    criticalFailureRate: Number(process.env.HEALTH_CRITICAL_FAILURE_RATE || 0.15),
    degradedConflictRate: Number(process.env.HEALTH_DEGRADED_CONFLICT_RATE || 0.02),
    criticalConflictRate: Number(process.env.HEALTH_CRITICAL_CONFLICT_RATE || 0.08),
    degradedSessionsOverSla: Number(process.env.HEALTH_DEGRADED_SESSIONS_OVER_SLA || 1),
    criticalSessionsOverSla: Number(process.env.HEALTH_CRITICAL_SESSIONS_OVER_SLA || 5)
});
const adminSocketWatchdog = new AdminSocketWatchdog({
    staleMs: Number(process.env.ADMIN_SOCKET_STALE_MS || 30000)
});

// --- APP SETUP ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: (origin, callback) => callback(null, true), // Allow ALL origins
        methods: ["GET", "POST"],
        credentials: true
    }
});

const PORT = process.env.PORT || 8090;
const ADMIN_NOTIFY_QUEUE_MAX = Number(process.env.ADMIN_NOTIFY_QUEUE_MAX || 5000);
const HEARTBEAT_COALESCE_WINDOW_MS = Number(process.env.HEARTBEAT_COALESCE_WINDOW_MS || 2500);
const HEARTBEAT_COALESCE_CACHE_MAX = Number(process.env.HEARTBEAT_COALESCE_CACHE_MAX || 20000);
const HOT_PATH_PERSIST_QUEUE_MAX = Number(process.env.HOT_PATH_PERSIST_QUEUE_MAX || 50000);
const HOT_PATH_DURABLE_LOG_PATH = path.join(__dirname, 'logs', 'hotpath-persist-queue.ndjson');
const HOT_PATH_DURABLE_COMPACT_INTERVAL = Number(process.env.HOT_PATH_DURABLE_COMPACT_INTERVAL || 2000);
const SESSION_STALE_MS = Number(process.env.SESSION_STALE_MS || Math.max(Number(process.env.HEARTBEAT_SLA_MS || 12000) + 4000, 15000));

const adminNotificationQueue = [];
let adminNotificationDrainActive = false;
const heartbeatCoalesceCache = new Map();

function buildRequestId() {
    return crypto.randomUUID();
}

function normalizeError(error) {
    if (!error) return { message: 'Unknown error' };
    return {
        message: error.message || 'Erro sem mensagem',
        code: error.code || null,
        details: error.errors || null
    };
}

function extractErrorText(error) {
    if (!error) return '';
    const base = [error.message];
    if (Array.isArray(error.errors)) {
        for (const item of error.errors) {
            if (item && item.message) base.push(item.message);
            if (item && item.extensions && item.extensions.code) base.push(String(item.extensions.code));
        }
    }
    return base.filter(Boolean).join(' | ').toLowerCase();
}

function isLikelyDuplicateError(error) {
    const text = extractErrorText(error);
    return text.includes('duplicate') || text.includes('unique') || text.includes('already exists');
}

function isLikelyMissingRecordError(error) {
    const text = extractErrorText(error);
    return text.includes('not found')
        || text.includes('record_not_found')
        || text.includes('no item')
        || text.includes('no data');
}

function buildOperationId(payload = {}) {
    if (payload.operationId) return String(payload.operationId);
    const base = `${payload.userId || 'unknown'}:${payload.tabId || 'unknown'}:${payload.type || 'unknown'}:${payload.timestamp || 'na'}`;
    return crypto.createHash('sha256').update(base).digest('hex');
}

function pruneHeartbeatCoalesceCache(now = Date.now()) {
    if (heartbeatCoalesceCache.size <= HEARTBEAT_COALESCE_CACHE_MAX) return;
    for (const [tabId, entry] of heartbeatCoalesceCache.entries()) {
        if ((now - entry.lastPersistedAt) > (HEARTBEAT_COALESCE_WINDOW_MS * 20)) {
            heartbeatCoalesceCache.delete(tabId);
        }
        if (heartbeatCoalesceCache.size <= HEARTBEAT_COALESCE_CACHE_MAX) break;
    }
}

function shouldCoalesceHeartbeat({ userId, tabId, type, state, ip }) {
    if (!FLAGS.ENABLE_HEARTBEAT_COALESCING) return false;
    if (type !== 'heartbeat') return false;
    const now = Date.now();
    const cached = heartbeatCoalesceCache.get(tabId);
    if (!cached) return false;

    const sameIdentity = cached.userId === userId && cached.state === state && cached.ip === (ip || null);
    const withinWindow = (now - cached.lastPersistedAt) < HEARTBEAT_COALESCE_WINDOW_MS;
    if (!(sameIdentity && withinWindow)) return false;

    cached.lastCoalescedAt = now;
    heartbeatCoalesceCache.set(tabId, cached);
    return true;
}

function markHeartbeatPersisted({ userId, tabId, state, ip }) {
    if (!FLAGS.ENABLE_HEARTBEAT_COALESCING || !tabId) return;
    const now = Date.now();
    heartbeatCoalesceCache.set(tabId, {
        userId,
        state,
        ip: ip || null,
        lastPersistedAt: now,
        lastCoalescedAt: now
    });
    pruneHeartbeatCoalesceCache(now);
}

async function runWithReliability(operationName, operation, context = {}) {
    if (!FLAGS.ENABLE_RELIABILITY_LAYER) {
        return operation();
    }

    return reliability.execute(operationName, operation, {
        onCircuitOpen: ({ state }) => {
            logger.warn('Circuit breaker aberto', { operationName, breakerState: state, ...context });
        },
        onRetry: ({ attempt, errorMessage, breakerState }) => {
            logger.warn('Retry em operacao externa', {
                operationName,
                attempt,
                breakerState,
                errorMessage,
                ...context
            });
        },
        onFailure: ({ attempt, errorMessage, breakerState }) => {
            logger.error('Falha definitiva em operacao externa', {
                operationName,
                attempt,
                breakerState,
                errorMessage,
                ...context
            });
        }
    });
}

// Debug Middleware
app.use((req, res, next) => {
    req.requestId = req.headers['x-request-id'] || buildRequestId();
    const startAt = Date.now();
    res.on('finish', () => {
        logger.info('HTTP request finalizada', {
            requestId: req.requestId,
            method: req.method,
            url: req.url,
            statusCode: res.statusCode,
            ip: req.ip,
            latencyMs: Date.now() - startAt
        });
    });
    next();
});

// CORS Middleware
app.use(cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ type: ['application/json', 'text/plain'] }));


const ADMIN_PASSWORD = "SuperAdminStrongPassword2026!";

// --- AUTH HELPERS ---
function hashPassword(password, salt) {
    return crypto.scryptSync(password, salt, 64).toString('hex');
}

async function initDB() {
    logger.info('Inicializando conexao com Directus', { action: 'initDB' });
    try {
        const admins = await runWithReliability('directus.readAdmins', () => directus.request(readItems('Telemetry_Users', {
            filter: { username: { _eq: 'admin' } }
        })), { action: 'initDB' });

        if (admins.length === 0) {
            const salt = crypto.randomBytes(16).toString('hex');
            const hash = hashPassword(ADMIN_PASSWORD, salt);
            const adminId = crypto.randomUUID();

            await runWithReliability('directus.createAdmin', () => directus.request(createItem('Telemetry_Users', {
                id: adminId,
                username: 'admin',
                password: hash,
                salt: salt,
                isAdmin: true
            })), { action: 'initDB' });
            logger.audit('admin_bootstrap_created', { userId: adminId, username: 'admin' });
        }
    } catch (e) {
        const error = normalizeError(e);
        logger.error('Erro ao verificar/criar admin inicial', { action: 'initDB', errorMessage: error.message, errorCode: error.code });
    }
}
initDB();

// --- SERVICE LAYER ---
class SessionStore {
    constructor() {
        this.userCache = new Map();
        this.userCacheTtlMs = Number(process.env.USER_CACHE_TTL_MS || 5 * 60 * 1000);
        this.userStatsCache = new Map();
        this.userStatsCacheTtlMs = Number(process.env.USER_STATS_CACHE_TTL_MS || 2000);
        this.sessionVersionCache = new Map();
        this.sessionVersionCacheTtlMs = Number(process.env.SESSION_VERSION_CACHE_TTL_MS || 30 * 60 * 1000);
        this.inMemorySessions = new Map();
        this.persistQueue = [];
        this.persistQueueInFlight = false;
        this.maxPersistQueue = HOT_PATH_PERSIST_QUEUE_MAX;
        this.enableDurableHotPathQueue = FLAGS.ENABLE_DURABLE_HOTPATH_QUEUE;
        this.persistQueueAckCount = 0;
        this.persistTaskSeq = 0;
        this.persistPendingMap = new Map();
        if (this.enableDurableHotPathQueue) {
            this.restoreDurablePersistQueue();
        }
    }

    getSessionStaleCutoffIso(nowMs = Date.now()) {
        return new Date(nowMs - SESSION_STALE_MS).toISOString();
    }

    isSessionStale(session, nowMs = Date.now()) {
        if (!session || !session.lastSeen) return true;
        const lastSeenMs = Date.parse(session.lastSeen);
        if (!Number.isFinite(lastSeenMs)) return true;
        return (nowMs - lastSeenMs) > SESSION_STALE_MS;
    }

    getCachedUsername(userId) {
        const cached = this.userCache.get(userId);
        if (!cached) return null;
        if (cached.expiresAt <= Date.now()) {
            this.userCache.delete(userId);
            return null;
        }
        return cached.username;
    }

    setCachedUsername(userId, username) {
        if (!username || username === 'Unknown') return;
        this.userCache.set(userId, {
            username,
            expiresAt: Date.now() + this.userCacheTtlMs
        });
    }

    getCachedUserStats(userId) {
        const cached = this.userStatsCache.get(userId);
        if (!cached) return null;
        if (cached.expiresAt <= Date.now()) {
            this.userStatsCache.delete(userId);
            return null;
        }
        return cached.stats;
    }

    setCachedUserStats(userId, stats) {
        this.userStatsCache.set(userId, {
            stats,
            expiresAt: Date.now() + this.userStatsCacheTtlMs
        });
    }

    invalidateUserStats(userId) {
        this.userStatsCache.delete(userId);
    }

    getCachedSessionVersion(tabId) {
        const cached = this.sessionVersionCache.get(tabId);
        if (!cached) return null;
        if (cached.expiresAt <= Date.now()) {
            this.sessionVersionCache.delete(tabId);
            return null;
        }
        return cached.version;
    }

    setCachedSessionVersion(tabId, version) {
        if (!Number.isFinite(Number(version))) return;
        this.sessionVersionCache.set(tabId, {
            version: Number(version),
            expiresAt: Date.now() + this.sessionVersionCacheTtlMs
        });
    }

    deleteCachedSessionVersion(tabId) {
        this.sessionVersionCache.delete(tabId);
    }

    shouldUseInMemoryHotPath() {
        return FLAGS.ENABLE_INMEMORY_HOT_PATH && !FLAGS.ENABLE_STRICT_VERSION_CHECK;
    }

    restoreDurablePersistQueue() {
        try {
            if (!fs.existsSync(HOT_PATH_DURABLE_LOG_PATH)) return;
            const raw = fs.readFileSync(HOT_PATH_DURABLE_LOG_PATH, 'utf8');
            if (!raw || !raw.trim()) return;
            const lines = raw.split('\n').filter(Boolean);
            for (const line of lines) {
                try {
                    const record = JSON.parse(line);
                    if (!record || !record.id) continue;
                    if (record.op === 'enqueue' && record.task) {
                        this.persistPendingMap.set(record.id, record.task);
                    } else if (record.op === 'ack') {
                        this.persistPendingMap.delete(record.id);
                    }
                } catch (_ignored) {
                    // Ignorar linhas corrompidas para manter robustez do startup.
                }
            }
            for (const [id, task] of this.persistPendingMap.entries()) {
                this.persistQueue.push({ id, ...task });
            }
            if (this.persistQueue.length > 0) {
                logger.warn('Fila duravel restaurada apos restart', {
                    action: 'hotpath.persist.restore',
                    pendingTasks: this.persistQueue.length
                });
            }
        } catch (error) {
            const normalized = normalizeError(error);
            logger.error('Falha ao restaurar fila duravel do hot-path', {
                action: 'hotpath.persist.restore',
                errorMessage: normalized.message
            });
        }
    }

    appendDurableRecord(record) {
        if (!this.enableDurableHotPathQueue) return true;
        try {
            fs.mkdirSync(path.dirname(HOT_PATH_DURABLE_LOG_PATH), { recursive: true });
            fs.appendFileSync(HOT_PATH_DURABLE_LOG_PATH, `${JSON.stringify(record)}\n`);
            return true;
        } catch (error) {
            const normalized = normalizeError(error);
            logger.error('Falha ao gravar record duravel do hot-path', {
                action: 'hotpath.persist.durable',
                errorMessage: normalized.message
            });
            return false;
        }
    }

    maybeCompactDurableLog() {
        if (!this.enableDurableHotPathQueue) return;
        if (this.persistQueueAckCount < HOT_PATH_DURABLE_COMPACT_INTERVAL) return;
        this.persistQueueAckCount = 0;
        try {
            const lines = [];
            for (const [id, task] of this.persistPendingMap.entries()) {
                lines.push(JSON.stringify({ op: 'enqueue', id, task }));
            }
            fs.writeFileSync(HOT_PATH_DURABLE_LOG_PATH, lines.join('\n') + (lines.length ? '\n' : ''));
        } catch (error) {
            const normalized = normalizeError(error);
            logger.warn('Falha ao compactar log duravel do hot-path', {
                action: 'hotpath.persist.compact',
                errorMessage: normalized.message
            });
        }
    }

    enqueuePersistTask(task) {
        if (!this.shouldUseInMemoryHotPath()) return false;
        if (this.persistQueue.length >= this.maxPersistQueue) {
            if (this.enableDurableHotPathQueue) {
                logger.error('Fila duravel de persistencia lotada: recusando novo evento para evitar perda silenciosa', {
                    action: 'hotpath.persist.queue',
                    maxQueue: this.maxPersistQueue
                });
                return false;
            }
            const dropped = this.persistQueue.shift();
            logger.warn('Fila de persistencia hot-path saturada: removendo item antigo', {
                action: 'hotpath.persist.queue',
                maxQueue: this.maxPersistQueue
            });
        }
        const taskId = `${Date.now()}-${++this.persistTaskSeq}-${crypto.randomUUID()}`;
        if (this.enableDurableHotPathQueue) {
            const durableOk = this.appendDurableRecord({ op: 'enqueue', id: taskId, task });
            if (!durableOk) {
                return false;
            }
            this.persistPendingMap.set(taskId, task);
        }
        this.persistQueue.push({ id: taskId, ...task });
        setImmediate(() => {
            this.drainPersistQueue().catch((error) => {
                const normalized = normalizeError(error);
                logger.error('Falha no drain da fila de persistencia hot-path', {
                    action: 'hotpath.persist.queue',
                    errorMessage: normalized.message
                });
            });
        });
        return true;
    }

    async drainPersistQueue() {
        if (this.persistQueueInFlight) return;
        this.persistQueueInFlight = true;
        try {
            while (this.persistQueue.length > 0) {
                const task = this.persistQueue.shift();
                if (!task) continue;
                const taskId = task.id;
                if (task.kind === 'upsert') {
                    await this.persistUpsertTask(task);
                } else if (task.kind === 'delete') {
                    await this.persistDeleteTask(task);
                } else if (task.kind === 'log') {
                    await this.persistLogTask(task);
                }
                if (this.enableDurableHotPathQueue && taskId) {
                    if (this.appendDurableRecord({ op: 'ack', id: taskId })) {
                        this.persistPendingMap.delete(taskId);
                        this.persistQueueAckCount += 1;
                        this.maybeCompactDurableLog();
                    }
                }
            }
        } finally {
            this.persistQueueInFlight = false;
        }
    }

    async persistUpsertTask(task) {
        const { sessionData, userId, tabId } = task;
        try {
            await runWithReliability('directus.hotpathUpdateSession', () => directus.request(updateItem('Telemetry_Sessions', tabId, sessionData)), {
                action: 'hotpath.persist.upsert',
                userId,
                tabId
            });
        } catch (updateError) {
            if (!isLikelyMissingRecordError(updateError)) {
                throw updateError;
            }
            try {
                await runWithReliability('directus.hotpathCreateSession', () => directus.request(createItem('Telemetry_Sessions', sessionData)), {
                    action: 'hotpath.persist.upsert',
                    userId,
                    tabId
                });
            } catch (createError) {
                if (!isLikelyDuplicateError(createError)) {
                    throw createError;
                }
                await runWithReliability('directus.hotpathUpdateAfterDuplicate', () => directus.request(updateItem('Telemetry_Sessions', tabId, sessionData)), {
                    action: 'hotpath.persist.upsert',
                    userId,
                    tabId
                });
            }
        }
    }

    async persistDeleteTask(task) {
        const { userId, tabId } = task;
        try {
            await runWithReliability('directus.hotpathDeleteSession', () => directus.request(deleteItem('Telemetry_Sessions', tabId)), {
                action: 'hotpath.persist.delete',
                userId,
                tabId
            });
        } catch (error) {
            if (!isLikelyMissingRecordError(error)) {
                throw error;
            }
        }
    }

    async persistLogTask(task) {
        const { userId, tabId, state, eventType, operationId, requestId } = task;
        await runWithReliability('directus.hotpathCreateTelemetryLog', () => directus.request(createItem('Telemetry_Logs', {
            userId,
            tabId,
            state,
            eventType,
            operationId: operationId || null,
            requestId: requestId || null
        })), {
            action: 'hotpath.persist.log',
            userId,
            tabId,
            eventType
        });
    }

    async readSessionByTabId(tabId, context = {}) {
        const sessions = await runWithReliability('directus.readSessionByTabId', () => directus.request(readItems('Telemetry_Sessions', {
            limit: 1,
            filter: { tabId: { _eq: tabId } }
        })), context);
        return sessions && sessions.length > 0 ? sessions[0] : null;
    }

    async upsertSession(userId, tabId, data) {
        if (this.shouldUseInMemoryHotPath()) {
            const hotPathOperation = async () => this._upsertSessionHotPath(userId, tabId, data);
            if (!FLAGS.ENABLE_TAB_MUTEX) {
                return hotPathOperation();
            }
            return tabLockManager.withLock(tabId, hotPathOperation);
        }

        const updateOperation = async () => {
            return this._upsertSessionUnlocked(userId, tabId, data);
        };

        if (!FLAGS.ENABLE_TAB_MUTEX) {
            return updateOperation();
        }
        return tabLockManager.withLock(tabId, updateOperation);
    }

    async _upsertSessionHotPath(userId, tabId, data) {
        let username = 'Unknown';
        const isHeartbeat = data.type === 'heartbeat';
        const inMemoryExisting = this.inMemorySessions.get(tabId) || null;

        try {
            const cachedUsername = this.getCachedUsername(userId);
            if (cachedUsername) {
                username = cachedUsername;
            } else if (!isHeartbeat) {
                const user = await runWithReliability('directus.readUserById.hotpath', () => directus.request(readItem('Telemetry_Users', userId)), {
                    action: 'upsertSession.hotpath',
                    userId,
                    tabId
                });
                if (user && user.username) {
                    username = user.username;
                    this.setCachedUsername(userId, user.username);
                }
            } else if (inMemoryExisting && inMemoryExisting.username) {
                username = inMemoryExisting.username;
            }
        } catch (e) {
            const error = normalizeError(e);
            logger.warn('Nao foi possivel carregar username para sessao no hot-path', {
                action: 'upsertSession.hotpath',
                userId,
                tabId,
                errorMessage: error.message
            });
        }

        const cachedVersion = this.getCachedSessionVersion(tabId);
        const nextVersion = inMemoryExisting && Number.isFinite(Number(inMemoryExisting.version))
            ? Number(inMemoryExisting.version) + 1
            : (Number.isFinite(Number(cachedVersion)) ? Number(cachedVersion) + 1 : 1);
        const nowIso = new Date().toISOString();

        const sessionData = {
            tabId,
            userId,
            username,
            ip: data.ip || null,
            state: data.state || null,
            lastSeen: nowIso,
            updatedAtServer: nowIso,
            version: nextVersion,
            lastOperationId: data.operationId || null
        };

        this.inMemorySessions.set(tabId, sessionData);
        this.setCachedSessionVersion(tabId, nextVersion);
        this.invalidateUserStats(userId);
        const upsertQueued = this.enqueuePersistTask({
            kind: 'upsert',
            userId,
            tabId,
            sessionData
        });
        if (!upsertQueued) {
            const durableQueueError = new Error('Fila duravel de persistencia indisponivel');
            durableQueueError.code = 'HOTPATH_DURABILITY_UNAVAILABLE';
            throw durableQueueError;
        }

        if (['state_change', 'init', 'shutdown', 'periodic_log', 'manual_disconnect'].includes(data.type)) {
            const logQueued = this.enqueuePersistTask({
                kind: 'log',
                userId,
                tabId,
                state: data.state,
                eventType: data.type,
                operationId: data.operationId || null,
                requestId: data.requestId || null
            });
            if (!logQueued) {
                const durableQueueError = new Error('Fila duravel de log indisponivel');
                durableQueueError.code = 'HOTPATH_DURABILITY_UNAVAILABLE';
                throw durableQueueError;
            }
        }

        return {
            sessionVersion: nextVersion,
            updatedAtServer: nowIso
        };
    }

    async _upsertSessionUnlocked(userId, tabId, data) {
        let username = 'Unknown';
        let existingSession = null;
        const isHeartbeat = data.type === 'heartbeat';
        try {
            const cachedUsername = this.getCachedUsername(userId);
            if (cachedUsername) {
                username = cachedUsername;
            } else if (!isHeartbeat) {
                const user = await runWithReliability('directus.readUserById', () => directus.request(readItem('Telemetry_Users', userId)), {
                    action: 'upsertSession',
                    userId,
                    tabId
                });
                if (user && user.username) {
                    username = user.username;
                    this.setCachedUsername(userId, user.username);
                }
            }
        } catch (e) {
            const error = normalizeError(e);
            logger.warn('Nao foi possivel carregar username para sessao', { action: 'upsertSession', userId, tabId, errorMessage: error.message });
        }

        if (FLAGS.ENABLE_STRICT_VERSION_CHECK) {
            try {
                existingSession = await this.readSessionByTabId(tabId, {
                    action: 'upsertSession',
                    userId,
                    tabId
                });
                if (existingSession && Number.isFinite(Number(existingSession.version))) {
                    this.setCachedSessionVersion(tabId, Number(existingSession.version));
                }
            } catch (e) {
                existingSession = null;
            }
        }

        const cachedVersion = this.getCachedSessionVersion(tabId);

        const sessionData = {
            tabId,
            userId,
            username,
            ip: data.ip || null,
            state: data.state || null,
            lastSeen: new Date().toISOString(),
            updatedAtServer: new Date().toISOString(),
            version: existingSession && Number.isFinite(Number(existingSession.version))
                ? Number(existingSession.version) + 1
                : (Number.isFinite(Number(cachedVersion)) ? Number(cachedVersion) + 1 : 1),
            lastOperationId: data.operationId || null
        };

        if (
            FLAGS.ENABLE_STRICT_VERSION_CHECK
            && existingSession
            && data.expectedVersion !== undefined
            && data.expectedVersion !== null
        ) {
            const expectedVersion = Number(data.expectedVersion);
            const currentVersion = Number(existingSession.version || 0);
            if (Number.isFinite(expectedVersion) && currentVersion !== expectedVersion) {
                const conflictError = new Error('Conflito de versao detectado');
                conflictError.code = 'VERSION_CONFLICT';
                conflictError.meta = {
                    currentVersion,
                    expectedVersion,
                    tabId,
                    userId
                };
                throw conflictError;
            }
        }

        let persistedSession = null;
        try {
            if (!FLAGS.ENABLE_STRICT_VERSION_CHECK) {
                if (Number.isFinite(Number(cachedVersion))) {
                    try {
                        await runWithReliability('directus.updateSessionFast', () => directus.request(updateItem('Telemetry_Sessions', tabId, sessionData)), {
                            action: 'upsertSession',
                            userId,
                            tabId
                        });
                    } catch (updateError) {
                        if (!isLikelyMissingRecordError(updateError)) {
                            throw updateError;
                        }
                        this.deleteCachedSessionVersion(tabId);
                        sessionData.version = 1;
                        await runWithReliability('directus.createSessionAfterMiss', () => directus.request(createItem('Telemetry_Sessions', sessionData)), {
                            action: 'upsertSession',
                            userId,
                            tabId
                        });
                    }
                } else {
                    try {
                        await runWithReliability('directus.createSessionFast', () => directus.request(createItem('Telemetry_Sessions', sessionData)), {
                            action: 'upsertSession',
                            userId,
                            tabId
                        });
                    } catch (createError) {
                        if (!isLikelyDuplicateError(createError)) {
                            throw createError;
                        }
                        const latest = await this.readSessionByTabId(tabId, {
                            action: 'upsertSession',
                            userId,
                            tabId
                        });
                        const latestVersion = latest && Number.isFinite(Number(latest.version))
                            ? Number(latest.version)
                            : 0;
                        sessionData.version = latestVersion + 1;
                        await runWithReliability('directus.updateSessionAfterDuplicate', () => directus.request(updateItem('Telemetry_Sessions', tabId, sessionData)), {
                            action: 'upsertSession',
                            userId,
                            tabId
                        });
                    }
                }
            } else if (existingSession) {
                await runWithReliability('directus.updateSession', () => directus.request(updateItem('Telemetry_Sessions', tabId, sessionData)), {
                    action: 'upsertSession',
                    userId,
                    tabId
                });
            } else {
                await runWithReliability('directus.createSession', () => directus.request(createItem('Telemetry_Sessions', sessionData)), {
                    action: 'upsertSession',
                    userId,
                    tabId
                });
            }

            persistedSession = { ...(existingSession || {}), ...sessionData };
            this.setCachedSessionVersion(tabId, persistedSession.version);
            if (data.operationId && persistedSession && persistedSession.lastOperationId && persistedSession.lastOperationId !== data.operationId) {
                logger.warn('Divergencia de operationId apos persistencia', {
                    action: 'upsertSession',
                    userId,
                    tabId,
                    expectedOperationId: data.operationId,
                    persistedOperationId: persistedSession.lastOperationId
                });
            }
        } catch (e) {
            if (e && e.code === 'VERSION_CONFLICT') {
                logger.audit('session_version_conflict', {
                    action: 'upsertSession',
                    userId,
                    tabId,
                    expectedVersion: e.meta && e.meta.expectedVersion,
                    currentVersion: e.meta && e.meta.currentVersion,
                    operationId: data.operationId || null,
                    requestId: data.requestId || null
                });
                throw e;
            }
            const error = normalizeError(e);
            logger.error('Erro em upsertSession', { action: 'upsertSession', userId, tabId, errorMessage: error.message, errorCode: error.code });
            throw e;
        }

        this.invalidateUserStats(userId);

        if (['state_change', 'init', 'shutdown', 'periodic_log', 'manual_disconnect'].includes(data.type)) {
            try {
                await runWithReliability('directus.createTelemetryLog', () => directus.request(createItem('Telemetry_Logs', {
                    userId,
                    tabId,
                    state: data.state,
                    eventType: data.type,
                    operationId: data.operationId || null,
                    requestId: data.requestId || null
                })), { action: 'upsertSession', userId, tabId, eventType: data.type });
            } catch (e) {
                const error = normalizeError(e);
                logger.error('Erro ao gravar log de telemetria', {
                    action: 'upsertSession',
                    userId,
                    tabId,
                    eventType: data.type,
                    errorMessage: error.message
                });
            }
        }

        return {
            sessionVersion: persistedSession && Number.isFinite(Number(persistedSession.version))
                ? Number(persistedSession.version)
                : Number(sessionData.version),
            updatedAtServer: (persistedSession && persistedSession.updatedAtServer) || sessionData.updatedAtServer
        };
    }

    async removeSession(userId, tabId) {
        if (this.shouldUseInMemoryHotPath()) {
            this.inMemorySessions.delete(tabId);
            this.deleteCachedSessionVersion(tabId);
            this.invalidateUserStats(userId);
            const queued = this.enqueuePersistTask({ kind: 'delete', userId, tabId });
            if (!queued) {
                logger.error('Falha ao enfileirar remocao em hot-path duravel', {
                    action: 'removeSession.hotpath',
                    userId,
                    tabId
                });
            }
            return;
        }
        try {
            await runWithReliability('directus.deleteSession', () => directus.request(deleteItem('Telemetry_Sessions', tabId)), {
                action: 'removeSession',
                userId,
                tabId
            });
            this.deleteCachedSessionVersion(tabId);
            this.invalidateUserStats(userId);
        } catch (e) {
            const error = normalizeError(e);
            logger.warn('Falha ao remover sessao', { action: 'removeSession', userId, tabId, errorMessage: error.message });
        }
    }

    async pruneDeadSessions() {
        const nowMs = Date.now();
        const cutoff = this.getSessionStaleCutoffIso(nowMs);
        if (this.shouldUseInMemoryHotPath()) {
            let pruned = 0;
            for (const [tabId, session] of this.inMemorySessions.entries()) {
                if (!this.isSessionStale(session, nowMs)) continue;
                this.inMemorySessions.delete(tabId);
                this.deleteCachedSessionVersion(tabId);
                this.invalidateUserStats(session.userId);
                const queued = this.enqueuePersistTask({
                    kind: 'delete',
                    userId: session.userId,
                    tabId
                });
                if (!queued) {
                    logger.error('Falha ao enfileirar prune em hot-path duravel', {
                        action: 'pruneDeadSessions.hotpath',
                        userId: session.userId,
                        tabId
                    });
                }
                pruned += 1;
            }
            if (pruned > 0) {
                logger.info('Prune em memoria concluido', { action: 'pruneDeadSessions.hotpath', deadSessions: pruned });
            }
            return;
        }
        try {
            const deadSessions = await runWithReliability('directus.readDeadSessions', () => directus.request(readItems('Telemetry_Sessions', {
                filter: { lastSeen: { _lt: cutoff } }
            })), { action: 'pruneDeadSessions', cutoff });

            if (deadSessions.length > 0) {
                for (let session of deadSessions) {
                    try {
                        const lockDelete = async () => {
                            const latest = await this.readSessionByTabId(session.tabId, {
                                action: 'pruneDeadSessions',
                                tabId: session.tabId,
                                userId: session.userId
                            });
                            if (!latest || !latest.lastSeen || latest.lastSeen >= cutoff) {
                                return false;
                            }
                            await runWithReliability('directus.deleteDeadSession', () => directus.request(deleteItem('Telemetry_Sessions', session.tabId)), {
                                action: 'pruneDeadSessions',
                                tabId: session.tabId,
                                userId: session.userId
                            });
                            this.deleteCachedSessionVersion(session.tabId);
                            this.invalidateUserStats(session.userId);
                            return true;
                        };

                        if (FLAGS.ENABLE_TAB_MUTEX) {
                            await tabLockManager.withLock(session.tabId, lockDelete);
                        } else {
                            await lockDelete();
                        }
                    } catch (ex) {
                        const error = normalizeError(ex);
                        logger.warn('Falha ao apagar sessao zumbi', {
                            action: 'pruneDeadSessions',
                            tabId: session.tabId,
                            userId: session.userId,
                            errorMessage: error.message
                        });
                    }
                }
                logger.info('Prune de sessoes concluido', { action: 'pruneDeadSessions', deadSessions: deadSessions.length });
            }
        } catch (e) {
            const error = normalizeError(e);
            logger.error('Falha no prune de sessoes', { action: 'pruneDeadSessions', errorMessage: error.message });
        }
    }

    async getAllSessions() {
        const nowMs = Date.now();
        if (this.shouldUseInMemoryHotPath()) {
            const result = {};
            for (const [tabId, session] of this.inMemorySessions.entries()) {
                if (this.isSessionStale(session, nowMs)) {
                    this.inMemorySessions.delete(tabId);
                    this.deleteCachedSessionVersion(tabId);
                    if (session && session.userId) this.invalidateUserStats(session.userId);
                    continue;
                }
                if (!result[session.userId]) result[session.userId] = {};
                result[session.userId][session.tabId] = session;
            }
            return result;
        }
        try {
            const sessions = await directus.request(readItems('Telemetry_Sessions', {
                limit: -1,
                filter: { lastSeen: { _gte: this.getSessionStaleCutoffIso(nowMs) } }
            }));
            const result = {};
            for (const s of sessions) {
                if (!result[s.userId]) result[s.userId] = {};
                result[s.userId][s.tabId] = s;
            }
            return result;
        } catch (e) {
            return {};
        }
    }

    async getUserStats(userId) {
        const cachedStats = this.getCachedUserStats(userId);
        if (cachedStats) {
            return cachedStats;
        }
        if (this.shouldUseInMemoryHotPath()) {
            const nowMs = Date.now();
            const tabs = Array.from(this.inMemorySessions.values()).filter((s) => s.userId === userId && !this.isSessionStale(s, nowMs));
            const ips = new Set(tabs.map((t) => t.ip).filter(Boolean));
            const username = (tabs[0] && tabs[0].username) || this.getCachedUsername(userId) || 'Unknown';
            const stats = {
                userId,
                username,
                tabCount: tabs.length,
                distinctIps: ips.size
            };
            this.setCachedUserStats(userId, stats);
            return stats;
        }
        try {
            const tabs = await runWithReliability('directus.readUserSessionsForStats', () => directus.request(readItems('Telemetry_Sessions', {
                filter: {
                    _and: [
                        { userId: { _eq: userId } },
                        { lastSeen: { _gte: this.getSessionStaleCutoffIso() } }
                    ]
                }
            })), { action: 'getUserStats', userId });
            const ips = new Set(tabs.map(t => t.ip).filter(Boolean));
            let username = 'Unknown';
            if (tabs.length > 0 && tabs[0].username) {
                username = tabs[0].username;
            } else {
                try {
                    const user = await runWithReliability('directus.readUserForStats', () => directus.request(readItem('Telemetry_Users', userId)), {
                        action: 'getUserStats',
                        userId
                    });
                    if (user) username = user.username;
                } catch (e) {
                    const error = normalizeError(e);
                    logger.warn('Falha ao carregar usuario para stats', {
                        action: 'getUserStats',
                        userId,
                        errorMessage: error.message
                    });
                }
            }

            const stats = {
                userId,
                username,
                tabCount: tabs.length,
                distinctIps: ips.size
            };
            this.setCachedUserStats(userId, stats);
            return stats;
        } catch (e) {
            const error = normalizeError(e);
            logger.warn('Falha ao montar stats de usuario', {
                action: 'getUserStats',
                userId,
                errorMessage: error.message
            });
            return { userId, username: 'Unknown', tabCount: 0, distinctIps: 0 };
        }
    }
}

const store = new SessionStore();
setInterval(() => store.pruneDeadSessions(), 15000);
setInterval(async () => {
    if (!FLAGS.ENABLE_HEALTH_WATCHDOG) return;
    try {
        const allSessions = await store.getAllSessions();
        const snapshot = healthMonitor.buildSnapshot({
            activeSessions: allSessions,
            breakerState: reliability.state
        });
        healthMonitor.recordWatchdogRun();
        if (snapshot.sessionsOverSla > 0) {
            healthMonitor.recordWatchdogAlert();
            logger.warn('Watchdog detectou sessoes acima do SLA de heartbeat', {
                action: 'watchdog.heartbeat',
                sessionsOverSla: snapshot.sessionsOverSla,
                heartbeatSlaMs: snapshot.heartbeatSlaMs
            });
        }
    } catch (error) {
        const normalized = normalizeError(error);
        logger.error('Falha no watchdog de heartbeat', {
            action: 'watchdog.heartbeat',
            errorMessage: normalized.message
        });
    }
}, 5000);

setInterval(() => {
    if (!FLAGS.ENABLE_ADMIN_SOCKET_WATCHDOG) return;
    adminSocketWatchdog.tick(io, logger, Date.now());
}, 10000);

setInterval(async () => {
    try {
        const allSessions = await store.getAllSessions();
        const healthSnapshot = healthMonitor.buildSnapshot({
            activeSessions: allSessions,
            breakerState: reliability.state
        });
        logger.updateSummary([
            `updatedAt=${new Date().toISOString()}`,
            `reliabilityLayer=${FLAGS.ENABLE_RELIABILITY_LAYER}`,
            `idempotencyGuard=${FLAGS.ENABLE_IDEMPOTENCY_GUARD}`,
            `diagnosticMode=${FLAGS.ENABLE_DIAGNOSTIC_MODE}`,
            `tabMutex=${FLAGS.ENABLE_TAB_MUTEX}`,
            `strictVersionCheck=${FLAGS.ENABLE_STRICT_VERSION_CHECK}`,
            `healthWatchdog=${FLAGS.ENABLE_HEALTH_WATCHDOG}`,
            `adminSocketWatchdog=${FLAGS.ENABLE_ADMIN_SOCKET_WATCHDOG}`,
            `asyncAdminNotify=${FLAGS.ENABLE_ASYNC_ADMIN_NOTIFY}`,
            `heartbeatCoalescing=${FLAGS.ENABLE_HEARTBEAT_COALESCING}`,
            `inMemoryHotPath=${FLAGS.ENABLE_INMEMORY_HOT_PATH}`,
            `durableHotPathQueue=${FLAGS.ENABLE_DURABLE_HOTPATH_QUEUE}`,
            `breakerState=${reliability.state}`,
            `activeUsers=${healthSnapshot.activeUsers}`,
            `activeTabs=${healthSnapshot.activeTabs}`,
            `healthStatus=${healthSnapshot.healthStatus}`,
            `healthRecommendation=${healthSnapshot.recommendation}`,
            `healthSignals=${(healthSnapshot.healthSignals || []).join(',') || 'none'}`,
            `sessionsOverSla=${healthSnapshot.sessionsOverSla}`,
            `telemetryFailureRate=${healthSnapshot.failureRate}`,
            `telemetryConflictRate=${healthSnapshot.conflictRate}`,
            `latencyAvgMs=${healthSnapshot.latency.avgMs}`,
            `latencyP95Ms=${healthSnapshot.latency.p95Ms}`,
            `latencyP99Ms=${healthSnapshot.latency.p99Ms}`
        ]);
    } catch (error) {
        const normalized = normalizeError(error);
        logger.warn('Falha ao atualizar summary operacional', { action: 'summary.update', errorMessage: normalized.message });
    }
}, 10000);

// --- SOCKET.IO BROADCAST ---
async function notifyAdmins(userId, eventType, data) {
    try {
        let extra = {};
        if (eventType === 'update') {
            extra.stats = await store.getUserStats(userId);
        }
        io.to('admin_room').emit('session_update', {
            userId,
            eventType,
            data,
            timestamp: Date.now(),
            ...extra
        });
    } catch (error) {
        const normalized = normalizeError(error);
        logger.error('Falha ao notificar admins via socket', {
            action: 'notifyAdmins',
            userId,
            eventType,
            errorMessage: normalized.message
        });
    }
}

async function drainAdminNotificationQueue() {
    if (adminNotificationDrainActive) return;
    adminNotificationDrainActive = true;
    try {
        while (adminNotificationQueue.length > 0) {
            const item = adminNotificationQueue.shift();
            await notifyAdmins(item.userId, item.eventType, item.data);
        }
    } finally {
        adminNotificationDrainActive = false;
    }
}

function enqueueAdminNotification(userId, eventType, data) {
    if (adminNotificationQueue.length >= ADMIN_NOTIFY_QUEUE_MAX) {
        adminNotificationQueue.shift();
        logger.warn('Fila de notificacao admin saturada: removendo item antigo', {
            action: 'notifyAdmins.queue',
            maxQueue: ADMIN_NOTIFY_QUEUE_MAX
        });
    }
    adminNotificationQueue.push({ userId, eventType, data });
    setImmediate(() => {
        drainAdminNotificationQueue().catch((error) => {
            const normalized = normalizeError(error);
            logger.error('Falha ao drenar fila de notificacao admin', {
                action: 'notifyAdmins.queue',
                errorMessage: normalized.message
            });
        });
    });
}

async function dispatchAdminNotification(userId, eventType, data) {
    if (!FLAGS.ENABLE_ASYNC_ADMIN_NOTIFY) {
        await notifyAdmins(userId, eventType, data);
        return;
    }
    enqueueAdminNotification(userId, eventType, data);
}

io.on('connection', (socket) => {
    socket.on('join_admin', async () => {
        try {
            logger.audit('admin_socket_join', { socketId: socket.id });
            socket.join('admin_room');
            adminSocketWatchdog.onJoin(socket.id, Date.now());
            socket.emit('full_snapshot', await store.getAllSessions());
        } catch (error) {
            const normalized = normalizeError(error);
            logger.error('Falha no join_admin', { action: 'socket.join_admin', socketId: socket.id, errorMessage: normalized.message });
        }
    });

    socket.on('admin_watchdog_pong', () => {
        adminSocketWatchdog.onPong(socket.id, Date.now());
    });

    socket.on('disconnect', () => {
        adminSocketWatchdog.onDisconnect(socket.id);
    });
});

// --- API ROUTES ---

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        const users = await runWithReliability('directus.readLoginUser', () => directus.request(readItems('Telemetry_Users', {
            filter: { username: { _eq: username } }
        })), { action: 'login', requestId: req.requestId, username });

        if (users.length === 0) {
            return res.status(401).json({ success: false, error: "Usuário não encontrado." });
        }
        const user = users[0];

        if (user.password) {
            if (!password) {
                return res.status(401).json({ success: false, error: "Senha necessária." });
            }
            const verifyHash = hashPassword(password, user.salt);
            if (verifyHash !== user.password) {
                return res.status(401).json({ success: false, error: "Senha incorreta." });
            }
        }

        await runWithReliability('directus.updateLastLogin', () => directus.request(updateItem('Telemetry_Users', user.id, {
            lastLogin: new Date().toISOString()
        })), { action: 'login', requestId: req.requestId, userId: user.id, username });

        logger.audit('auth_login_success', {
            action: 'login',
            requestId: req.requestId,
            userId: user.id,
            username
        });

        res.json({
            success: true,
            user: {
                id: user.id,
                username: user.username,
                role: user.isAdmin ? 'admin' : 'user'
            }
        });

    } catch (e) {
        const error = normalizeError(e);
        logger.error('Erro no login', {
            action: 'login',
            requestId: req.requestId,
            username,
            errorMessage: error.message,
            errorCode: error.code
        });
        res.status(500).json({ success: false, error: "Erro interno." });
    }
});

// --- ADMIN CREDENTIALS CRUD ---

app.get('/api/admin/credentials', async (req, res) => {
    try {
        const users = await directus.request(readItems('Telemetry_Users', {
            fields: ['id', 'username', 'isAdmin', 'lastLogin']
        }));

        // Simular o createdAt da versão sequelize lendo dados criados ou map (evitar quebrar front)
        const formatUsers = users.map(u => ({ ...u, createdAt: u.lastLogin || new Date().toISOString() }));
        res.json(formatUsers);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/credentials', async (req, res) => {
    const { username, password, isAdmin } = req.body;
    try {
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = hashPassword(password, salt);
        const id = crypto.randomUUID();

        const newUser = await directus.request(createItem('Telemetry_Users', {
            id,
            username,
            password: hash,
            salt,
            isAdmin: !!isAdmin
        }));

        res.json({ success: true, user: { id: newUser.id, username: newUser.username } });
    } catch (e) {
        res.status(500).json({ error: "Erro ao criar usuário. Nome duplicado ou banco indisponível." });
    }
});

app.put('/api/admin/credentials/:id', async (req, res) => {
    const { id } = req.params;
    const { password, isAdmin } = req.body;

    try {
        let updateData = {};
        if (password) {
            const salt = crypto.randomBytes(16).toString('hex');
            updateData.salt = salt;
            updateData.password = hashPassword(password, salt);
        }
        if (isAdmin !== undefined) {
            updateData.isAdmin = isAdmin;
        }

        await directus.request(updateItem('Telemetry_Users', id, updateData));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/admin/credentials/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const user = await directus.request(readItem('Telemetry_Users', id));
        if (user && user.username === 'admin') {
            return res.status(400).json({ error: "Não é possível apagar o super-admin." });
        }

        await directus.request(deleteItem('Telemetry_Users', id));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/telemetry', async (req, res) => {
    const telemetryStartedAt = Date.now();
    let payload = req.body;

    if (typeof payload === 'string') {
        try {
            payload = JSON.parse(payload);
        } catch (e) {
            logger.warn('Payload telemetry invalido em string', { action: 'telemetry.parse', requestId: req.requestId });
        }
    }

    const { userId, tabId, type, state, version } = payload;
    const ip = req.ip || req.socket.remoteAddress;
    const operationId = buildOperationId(payload);

    if (!userId || !tabId) {
        logger.warn('Telemetry sem identidade minima', { action: 'telemetry.validate', requestId: req.requestId, userId, tabId });
        return res.status(400).json({ error: "Missing identity" });
    }

    if (FLAGS.ENABLE_IDEMPOTENCY_GUARD) {
        const cached = idempotencyStore.get(operationId);
        if (cached) {
            healthMonitor.recordTelemetryEvent({
                ok: true,
                conflict: false,
                latencyMs: Date.now() - telemetryStartedAt,
                eventType: type || 'cached'
            });
            logger.info('Operacao idempotente reaproveitada', {
                action: 'telemetry.idempotency',
                requestId: req.requestId,
                operationId,
                userId,
                tabId,
                eventType: type
            });
            return res.json(cached);
        }
    }

    try {
        if (type === 'shutdown' || state === 'TAB_PROBABLY_CLOSED') {
            await store.removeSession(userId, tabId);
            heartbeatCoalesceCache.delete(tabId);
            await dispatchAdminNotification(userId, 'disconnected', { tabId });
            const response = { success: true, deduplicated: false };
            if (FLAGS.ENABLE_IDEMPOTENCY_GUARD) {
                idempotencyStore.set(operationId, response);
            }
            logger.audit('telemetry_shutdown_processed', {
                action: 'telemetry.shutdown',
                requestId: req.requestId,
                operationId,
                userId,
                tabId
            });
            healthMonitor.recordTelemetryEvent({
                ok: true,
                conflict: false,
                latencyMs: Date.now() - telemetryStartedAt,
                eventType: type || 'shutdown'
            });
            return res.json(response);
        }

        if (shouldCoalesceHeartbeat({ userId, tabId, type, state, ip })) {
            const response = { success: true, deduplicated: false, coalesced: true };
            if (FLAGS.ENABLE_IDEMPOTENCY_GUARD) {
                idempotencyStore.set(operationId, response);
            }
            healthMonitor.recordTelemetryEvent({
                ok: true,
                conflict: false,
                latencyMs: Date.now() - telemetryStartedAt,
                eventType: 'heartbeat_coalesced'
            });
            logger.info('Heartbeat coalescido para reduzir carga de escrita', {
                action: 'telemetry.coalesce',
                requestId: req.requestId,
                operationId,
                userId,
                tabId
            });
            return res.json(response);
        }

        const upsertResult = await store.upsertSession(userId, tabId, {
            ip,
            state,
            type,
            operationId,
            requestId: req.requestId,
            expectedVersion: version
        });
        markHeartbeatPersisted({ userId, tabId, state, ip });
        await dispatchAdminNotification(userId, 'update', { tabId, state, ip });

        const response = {
            success: true,
            deduplicated: false,
            sessionVersion: upsertResult && Number.isFinite(Number(upsertResult.sessionVersion))
                ? Number(upsertResult.sessionVersion)
                : null,
            updatedAtServer: upsertResult ? upsertResult.updatedAtServer : null
        };
        if (FLAGS.ENABLE_IDEMPOTENCY_GUARD) {
            idempotencyStore.set(operationId, response);
        }

        logger.audit('telemetry_update_processed', {
            action: 'telemetry.update',
            requestId: req.requestId,
            operationId,
            userId,
            tabId,
            eventType: type,
            state
        });
        healthMonitor.recordTelemetryEvent({
            ok: true,
            conflict: false,
            latencyMs: Date.now() - telemetryStartedAt,
            eventType: type || 'update'
        });
        return res.json(response);
    } catch (error) {
        const normalized = normalizeError(error);
        if (error && error.code === 'VERSION_CONFLICT') {
            healthMonitor.recordTelemetryEvent({
                ok: false,
                conflict: true,
                latencyMs: Date.now() - telemetryStartedAt,
                eventType: type || 'version_conflict'
            });
            logger.warn('Conflito de versao no telemetry', {
                action: 'telemetry',
                requestId: req.requestId,
                operationId,
                userId,
                tabId,
                expectedVersion: error.meta && error.meta.expectedVersion,
                currentVersion: error.meta && error.meta.currentVersion
            });
            return res.status(409).json({
                success: false,
                error: 'Conflito de versao',
                conflict: error.meta || null
            });
        }
        healthMonitor.recordTelemetryEvent({
            ok: false,
            conflict: false,
            latencyMs: Date.now() - telemetryStartedAt,
            eventType: type || 'error'
        });
        logger.error('Falha no processamento de telemetry', {
            action: 'telemetry',
            requestId: req.requestId,
            operationId,
            userId,
            tabId,
            eventType: type,
            state,
            errorMessage: normalized.message,
            errorCode: normalized.code
        });
        return res.status(500).json({ success: false, error: 'Falha ao processar telemetry.' });
    }
});

app.post('/api/auth/logout', async (req, res) => {
    const { userId, tabId } = req.body;
    try {
        await store.removeSession(userId, tabId);
        heartbeatCoalesceCache.delete(tabId);
        await dispatchAdminNotification(userId, 'disconnected', { tabId });
        logger.audit('auth_logout_success', { action: 'logout', requestId: req.requestId, userId, tabId });
        res.json({ success: true });
    } catch (error) {
        const normalized = normalizeError(error);
        logger.error('Falha no logout', { action: 'logout', requestId: req.requestId, userId, tabId, errorMessage: normalized.message });
        res.status(500).json({ success: false, error: 'Falha ao efetuar logout' });
    }
});

app.get('/api/admin/users', async (req, res) => {
    res.json(await store.getAllSessions());
});

app.get('/api/admin/history', async (req, res) => {
    try {
        const logs = await directus.request(readItems('Telemetry_Logs', {
            limit: 200,
            sort: ['-timestamp'],
            fields: ['*', 'userId.username']
        }));

        const formattedLogs = logs.map(l => ({
            ...l,
            User: l.userId ? { username: l.userId.username } : null
        }));

        res.json(formattedLogs);
    } catch (e) {
        const error = normalizeError(e);
        logger.error('Falha ao buscar historico admin', {
            action: 'admin.history',
            requestId: req.requestId,
            errorMessage: error.message,
            errorCode: error.code
        });
        res.status(500).json({ error: "Failed to fetch history" });
    }
});

app.get('/api/users/:userId/status', async (req, res) => {
    const { userId } = req.params;
    try {
        const cutoff = new Date(Date.now() - SESSION_STALE_MS).toISOString();
        const sessions = await directus.request(readItems('Telemetry_Sessions', {
            filter: {
                _and: [
                    { userId: { _eq: userId } },
                    { lastSeen: { _gte: cutoff } }
                ]
            }
        }));

        if (!sessions || sessions.length === 0) {
            return res.json({
                userId,
                status: 'offline',
                message: 'User is not currently connected.'
            });
        }

        const isFocused = sessions.some(
            (s) => s.state === 'FOCUSED' || s.state === 'TAB_ACTIVE_FOCUSED'
        );
        const status = isFocused ? 'active' : 'online';

        res.json({
            userId,
            status,
            activeTabs: sessions.length,
            details: sessions.map(s => ({
                tabId: s.tabId,
                state: s.state,
                lastSeen: s.lastSeen
            }))
        });
    } catch (e) {
        const error = normalizeError(e);
        logger.error('Falha ao consultar status de usuario', {
            action: 'users.status',
            requestId: req.requestId,
            userId,
            errorMessage: error.message,
            errorCode: error.code
        });
        res.status(500).json({ error: "Failed to check user status" });
    }
});

app.get('/api/admin/diagnostics/logs', (req, res) => {
    try {
        const fileType = req.query.type === 'audit' ? 'audit' : 'app';
        const lines = Number(req.query.lines || 200);
        const output = logger.readTail(fileType, lines);
        res.json({
            success: true,
            fileType,
            lines: output
        });
    } catch (error) {
        const normalized = normalizeError(error);
        logger.error('Falha ao consultar logs diagnosticos', {
            action: 'diagnostics.logs',
            requestId: req.requestId,
            errorMessage: normalized.message
        });
        res.status(500).json({ success: false, error: 'Falha ao ler logs persistentes.' });
    }
});

app.get('/api/admin/health', async (req, res) => {
    try {
        const activeSessions = await store.getAllSessions();
        const snapshot = healthMonitor.buildSnapshot({
            activeSessions,
            breakerState: reliability.state
        });
        res.json({
            success: true,
            generatedAt: new Date().toISOString(),
            health: snapshot
        });
    } catch (error) {
        const normalized = normalizeError(error);
        logger.error('Falha ao gerar health snapshot', {
            action: 'admin.health',
            requestId: req.requestId,
            errorMessage: normalized.message,
            errorCode: normalized.code
        });
        res.status(500).json({ success: false, error: 'Falha ao gerar métricas de saúde.' });
    }
});

app.post('/api/client/errors', (req, res) => {
    if (!FLAGS.ENABLE_CLIENT_ERROR_INGEST) {
        return res.status(404).json({ success: false, error: 'Client error ingest desabilitado.' });
    }

    try {
        const payload = req.body || {};
        const message = typeof payload.message === 'string' ? payload.message.slice(0, 1000) : 'Client error sem mensagem';
        const stack = typeof payload.stack === 'string' ? payload.stack.slice(0, 6000) : null;
        const context = payload.context && typeof payload.context === 'object' ? payload.context : {};
        const level = payload.level === 'warn' ? 'warn' : 'error';

        const event = {
            action: 'client.error.ingest',
            requestId: req.requestId,
            clientTimestamp: payload.clientTimestamp || null,
            url: payload.url || null,
            userAgent: req.headers['user-agent'] || null,
            userId: payload.userId || null,
            tabId: payload.tabId || null,
            eventType: payload.eventType || 'client_error',
            message,
            stack,
            context
        };

        if (level === 'warn') {
            logger.warn('Erro de cliente recebido', event);
        } else {
            logger.error('Erro de cliente recebido', event);
        }
        logger.audit('client_error_ingested', event);

        return res.json({ success: true });
    } catch (error) {
        const normalized = normalizeError(error);
        logger.error('Falha ao ingerir erro de cliente', {
            action: 'client.error.ingest',
            requestId: req.requestId,
            errorMessage: normalized.message,
            errorCode: normalized.code
        });
        return res.status(500).json({ success: false, error: 'Falha ao ingerir erro de cliente.' });
    }
});

// ---- Swagger Setup ----
const swaggerSpec = require('./swagger.json');
swaggerSpec.servers = [{ url: `http://localhost:${PORT}` }];

function docsAuth(req, res, next) {
    const token = req.query.token || process.env.DOC_TOKEN;
    if (token && token === 'public') return next();
    return res.status(403).send('Acesso negado à documentação');
}

app.use('/api-docs', swaggerUi.serve);
app.get('/api-docs', docsAuth, swaggerUi.setup(swaggerSpec));

// Serve React Frontend
app.use(express.static(path.join(__dirname, 'public')));

// Catch-all for SPA: must be the LAST route
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
    console.log(`🚀 Persistent Server (Directus backend + React Frontend) running on port ${PORT}`);
});
