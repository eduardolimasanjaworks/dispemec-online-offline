const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const path = require('path');
const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');

// Directus SDK
const { createDirectus, rest, staticToken, createItem, readItem, readItems, updateItem, deleteItem } = require('@directus/sdk');

// Variáveis de ambiente
const DIRECTUS_URL = process.env.DIRECTUS_URL || "http://91.99.137.101:8056/";
const DIRECTUS_TOKEN = process.env.DIRECTUS_TOKEN || "UuazE-Np-VrpGxmqe-bEpysiTSjV8_YR";

const directus = createDirectus(DIRECTUS_URL)
    .with(staticToken(DIRECTUS_TOKEN))
    .with(rest());

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

// Debug Middleware
app.use((req, res, next) => {
    console.log(`[REQUEST] ${req.method} ${req.url} from ${req.ip}`);
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
    console.log('📦 Conectado ao Directus SDK');
    try {
        const admins = await directus.request(readItems('Telemetry_Users', {
            filter: { username: { _eq: 'admin' } }
        }));

        if (admins.length === 0) {
            const salt = crypto.randomBytes(16).toString('hex');
            const hash = hashPassword(ADMIN_PASSWORD, salt);
            const adminId = crypto.randomUUID();

            await directus.request(createItem('Telemetry_Users', {
                id: adminId,
                username: 'admin',
                password: hash,
                salt: salt,
                isAdmin: true
            }));
            console.log(`🔐 Admin Account Created nas coleções do Directus.`);
            console.log(`👤 User: admin`);
            console.log(`🔑 Pass: ${ADMIN_PASSWORD}`);
        }
    } catch (e) {
        console.error("Erro ao verificar/criar Admin inicial no Directus:", e.errors || e.message);
    }
}
initDB();

// --- SERVICE LAYER ---
class SessionStore {
    async upsertSession(userId, tabId, data) {
        let username = 'Unknown';
        try {
            const user = await directus.request(readItem('Telemetry_Users', userId));
            if (user) username = user.username;
        } catch (e) { }

        const sessionData = {
            tabId,
            userId,
            username,
            ip: data.ip || null,
            state: data.state || null,
            lastSeen: new Date().toISOString()
        };

        try {
            try {
                // Tenta atualizar a sessão existente
                await directus.request(updateItem('Telemetry_Sessions', tabId, sessionData));
            } catch (e) {
                // Se falhar, ela não existe, logo, cria
                await directus.request(createItem('Telemetry_Sessions', sessionData));
            }
        } catch (e) {
            console.error("Erro upsertSession:", e.errors || e.message);
        }

        if (['state_change', 'init', 'shutdown', 'periodic_log', 'manual_disconnect'].includes(data.type)) {
            try {
                await directus.request(createItem('Telemetry_Logs', {
                    userId,
                    tabId,
                    state: data.state,
                    eventType: data.type
                }));
            } catch (e) {
                console.error("Erro ao gravar log:", e.errors || e.message);
            }
        }

        return this.getUserStats(userId);
    }

    async removeSession(userId, tabId) {
        try {
            await directus.request(deleteItem('Telemetry_Sessions', tabId));
        } catch (e) { }
    }

    async pruneDeadSessions() {
        const cutoff = new Date(Date.now() - 30000).toISOString();
        try {
            const deadSessions = await directus.request(readItems('Telemetry_Sessions', {
                filter: { lastSeen: { _lt: cutoff } }
            }));

            if (deadSessions.length > 0) {
                for (let session of deadSessions) {
                    try {
                        await directus.request(deleteItem('Telemetry_Sessions', session.tabId));
                    } catch (ex) { }
                }
                console.log(`🧹 Pruned ${deadSessions.length} zombie sessions do Directus`);
            }
        } catch (e) { }
    }

    async getAllSessions() {
        try {
            const sessions = await directus.request(readItems('Telemetry_Sessions', { limit: -1 }));
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
        try {
            const tabs = await directus.request(readItems('Telemetry_Sessions', {
                filter: { userId: { _eq: userId } }
            }));
            const ips = new Set(tabs.map(t => t.ip).filter(Boolean));
            let username = 'Unknown';
            if (tabs.length > 0 && tabs[0].username) {
                username = tabs[0].username;
            } else {
                try {
                    const user = await directus.request(readItem('Telemetry_Users', userId));
                    if (user) username = user.username;
                } catch (e) { }
            }

            return {
                userId,
                username,
                tabCount: tabs.length,
                distinctIps: ips.size
            };
        } catch (e) {
            return { userId, username: 'Unknown', tabCount: 0, distinctIps: 0 };
        }
    }
}

const store = new SessionStore();
setInterval(() => store.pruneDeadSessions(), 15000);

// --- SOCKET.IO BROADCAST ---
async function notifyAdmins(userId, eventType, data) {
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
}

io.on('connection', (socket) => {
    socket.on('join_admin', async () => {
        console.log('👑 Admin joined real-time feed');
        socket.join('admin_room');
        socket.emit('full_snapshot', await store.getAllSessions());
    });
});

// --- API ROUTES ---

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        const users = await directus.request(readItems('Telemetry_Users', {
            filter: { username: { _eq: username } }
        }));

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

        await directus.request(updateItem('Telemetry_Users', user.id, {
            lastLogin: new Date().toISOString()
        }));

        res.json({
            success: true,
            user: {
                id: user.id,
                username: user.username,
                role: user.isAdmin ? 'admin' : 'user'
            }
        });

    } catch (e) {
        console.error("Login Error:", e);
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
    let payload = req.body;

    if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch (e) { }
    }

    const { userId, tabId, type, state } = payload;
    const ip = req.ip || req.socket.remoteAddress;

    if (!userId || !tabId) {
        return res.status(400).json({ error: "Missing identity" });
    }

    if (type === 'shutdown' || state === 'TAB_PROBABLY_CLOSED') {
        await store.removeSession(userId, tabId);
        await notifyAdmins(userId, 'disconnected', { tabId });
        console.log(`👋 User ${userId} Disconnected (Shutdown)`);
        return res.json({ success: true });
    }

    const stats = await store.upsertSession(userId, tabId, { ip, state, type });
    console.log(`📡 Update: ${userId} [${state}]`);
    await notifyAdmins(userId, 'update', { tabId, state, ip });

    res.json({ success: true });
});

app.post('/api/auth/logout', async (req, res) => {
    const { userId, tabId } = req.body;
    await store.removeSession(userId, tabId);
    await notifyAdmins(userId, 'disconnected', { tabId });
    res.json({ success: true });
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
        console.error("History Error:", e);
        res.status(500).json({ error: "Failed to fetch history" });
    }
});

app.get('/api/users/:userId/status', async (req, res) => {
    const { userId } = req.params;
    try {
        const sessions = await directus.request(readItems('Telemetry_Sessions', {
            filter: { userId: { _eq: userId } }
        }));

        if (!sessions || sessions.length === 0) {
            return res.json({
                userId,
                status: 'offline',
                message: 'User is not currently connected.'
            });
        }

        const isFocused = sessions.some(s => s.state === 'FOCUSED');
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
        console.error("Status Check Error:", e);
        res.status(500).json({ error: "Failed to check user status" });
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
