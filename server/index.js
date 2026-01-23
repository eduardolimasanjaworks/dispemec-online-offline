const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { Sequelize, DataTypes, Op } = require('sequelize');

const path = require('path');
const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');
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

const PORT = 3001; // Port 3001 for API

// Debug Middleware
app.use((req, res, next) => {
    console.log(`[REQUEST] ${req.method} ${req.url} from ${req.ip}`);
    next();
});

// CORS Middleware for Express Routes
// CORS Middleware for Express Routes
app.use(cors({
    origin: true, // Allow any origin that sends the request
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ type: ['application/json', 'text/plain'] }));

// --- DATABASE SETUP (SQLite Persistent) ---
const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: './telemetry.sqlite',
    logging: false
});

// Models
// Models
const User = sequelize.define('User', {
    id: { type: DataTypes.STRING, primaryKey: true }, // generated UUID or hash
    username: { type: DataTypes.STRING, unique: true },
    password: { type: DataTypes.STRING }, // Hash
    salt: { type: DataTypes.STRING },
    isAdmin: { type: DataTypes.BOOLEAN, defaultValue: false },
    lastLogin: { type: DataTypes.DATE }
}, {
    timestamps: true,
    paranoid: true // soft delete (deletedAt)
});

const Session = sequelize.define('Session', {
    tabId: { type: DataTypes.UUID, primaryKey: true },
    userId: { type: DataTypes.STRING, allowNull: false },
    // We add username snapshot here just in case, or link to User.
    // Ideally we link to User.
    username: { type: DataTypes.STRING }, // Snapshot for quick access
    ip: { type: DataTypes.STRING },
    state: { type: DataTypes.STRING }, // FOCUSED, HIDDEN, etc
    lastSeen: { type: DataTypes.DATE },
    deviceType: { type: DataTypes.STRING },
    userAgent: { type: DataTypes.STRING },
    startedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
});

const TelemetryLog = sequelize.define('TelemetryLog', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    userId: { type: DataTypes.STRING },
    tabId: { type: DataTypes.UUID },
    state: { type: DataTypes.STRING },
    eventType: { type: DataTypes.STRING },
    timestamp: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
});

// Associations
TelemetryLog.belongsTo(User, { foreignKey: 'userId' });
User.hasMany(TelemetryLog, { foreignKey: 'userId' });
Session.belongsTo(User, { foreignKey: 'userId' });
User.hasMany(Session, { foreignKey: 'userId' });

// Sync DB
const ADMIN_PASSWORD = "SuperAdminStrongPassword2026!"; // Hardcoded strong password as requested

async function initDB() {
    await sequelize.sync({ alter: true }); // Update tables
    console.log('📦 Database Connected & Synced (SQLite)');

    // Init Admin
    const adminExists = await User.findOne({ where: { username: 'admin' } });
    if (!adminExists) {
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.scryptSync(ADMIN_PASSWORD, salt, 64).toString('hex');
        const adminId = crypto.randomUUID();

        await User.create({
            id: adminId,
            username: 'admin',
            password: hash,
            salt: salt,
            isAdmin: true
        });
        console.log(`🔐 Admin Account Created.`);
        console.log(`👤 User: admin`);
        console.log(`🔑 Pass: ${ADMIN_PASSWORD}`);
    }
}
initDB();

// --- AUTH HELPERS ---
function hashPassword(password, salt) {
    return crypto.scryptSync(password, salt, 64).toString('hex');
}

// --- SERVICE LAYER ---
class SessionStore {
    async upsertSession(userId, tabId, data) {

        // 1. Upsert Current Session
        // Fetch User to get Username
        const user = await User.findByPk(userId);
        const username = user ? user.username : 'Unknown';

        await Session.upsert({
            tabId,
            userId,
            username, // Save snapshot
            ...data,
            lastSeen: new Date()
        });

        // 2. Gravando Histórico (Apenas mudanças relevantes ou init/shutdown ou periodic_log)
        // Para não flodar o banco, vamos gravar apenas se o tipo for state_change, init/shutdown ou periodic_log
        if (['state_change', 'init', 'shutdown', 'periodic_log', 'manual_disconnect'].includes(data.type)) {
            await TelemetryLog.create({
                userId,
                tabId,
                state: data.state,
                eventType: data.type
            });
        }

        return this.getUserStats(userId);
    }

    async removeSession(userId, tabId) {
        await Session.destroy({ where: { userId, tabId } });
    }

    async pruneDeadSessions() {
        const cutoff = new Date(Date.now() - 30000); // 30s timeout
        const deleted = await Session.destroy({
            where: { lastSeen: { [Op.lt]: cutoff } }
        });
        if (deleted > 0) console.log(`🧹 Pruned ${deleted} zombie sessions`);
    }

    async getAllSessions() {
        const sessions = await Session.findAll();
        const result = {};
        for (const s of sessions) {
            if (!result[s.userId]) result[s.userId] = {};
            result[s.userId][s.tabId] = s.toJSON();
        }
        return result;
    }

    async getUserStats(userId) {
        const tabs = await Session.findAll({ where: { userId } });
        const ips = new Set(tabs.map(t => t.ip));
        const username = tabs.length > 0 ? tabs[0].username : (await User.findByPk(userId))?.username || 'Unknown';

        return {
            userId,
            username,
            tabCount: tabs.length,
            distinctIps: ips.size
        };
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

// Login
// Login
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        const user = await User.findOne({ where: { username } });

        if (!user) {
            return res.status(401).json({ success: false, error: "Usuário não encontrado." });
        }

        // Verify Password if set
        if (user.password) {
            if (!password) {
                return res.status(401).json({ success: false, error: "Senha necessária." });
            }
            const verifyHash = hashPassword(password, user.salt);
            if (verifyHash !== user.password) {
                return res.status(401).json({ success: false, error: "Senha incorreta." });
            }
        }

        // Update Last Login
        user.lastLogin = new Date();
        await user.save();

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

// List Users
app.get('/api/admin/credentials', async (req, res) => {
    try {
        const users = await User.findAll({
            attributes: ['id', 'username', 'isAdmin', 'lastLogin', 'createdAt']
        });
        res.json(users);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Create User
app.post('/api/admin/credentials', async (req, res) => {
    const { username, password, isAdmin } = req.body;
    try {
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = hashPassword(password, salt);
        const id = crypto.randomUUID();

        const newUser = await User.create({
            id,
            username,
            password: hash,
            salt,
            isAdmin: !!isAdmin
        });

        res.json({ success: true, user: { id: newUser.id, username: newUser.username } });
    } catch (e) {
        res.status(500).json({ error: "Erro ao criar usuário. Nome duplicado?" });
    }
});

// Reset Password / Update
app.put('/api/admin/credentials/:id', async (req, res) => {
    const { id } = req.params;
    const { password, isAdmin } = req.body;

    try {
        const user = await User.findByPk(id);
        if (!user) return res.status(404).json({ error: "Usuário não encontrado" });

        if (password) {
            user.salt = crypto.randomBytes(16).toString('hex');
            user.password = hashPassword(password, user.salt);
        }
        if (isAdmin !== undefined) {
            user.isAdmin = isAdmin;
        }
        await user.save();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Delete User
app.delete('/api/admin/credentials/:id', async (req, res) => {
    const { id } = req.params;
    try {
        // Prevent deleting last admin?
        const toDelete = await User.findByPk(id);
        if (toDelete && toDelete.username === 'admin') {
            return res.status(400).json({ error: "Não é possível apagar o super-admin." });
        }

        await User.destroy({ where: { id } });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Telemetry Logic
// Telemetry Logic
app.post('/api/telemetry', async (req, res) => {
    let payload = req.body;

    // Debug Log
    // console.log('📥 INCOMING TELEMETRY:', typeof payload, payload);

    if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch (e) {
            console.error("❌ JSON Parse Failed:", e);
        }
    }

    const { userId, tabId, type, state } = payload;
    const ip = req.ip || req.socket.remoteAddress;

    if (!userId || !tabId) {
        console.warn("⚠️ Rejected: Missing userId or tabId", payload);
        return res.status(400).json({ error: "Missing identity" });
    }

    // Handle Graceful Shutdown
    if (type === 'shutdown' || state === 'TAB_PROBABLY_CLOSED') {
        await store.removeSession(userId, tabId);
        await notifyAdmins(userId, 'disconnected', { tabId });
        console.log(`👋 User ${userId} Disconnected (Shutdown)`);
        return res.json({ success: true });
    }

    // Update Session
    const stats = await store.upsertSession(userId, tabId, { ip, state, type });
    console.log(`📡 Update: ${userId} [${state}]`);

    await notifyAdmins(userId, 'update', { tabId, state, ip });

    res.json({ success: true });
});

// Logout
app.post('/api/auth/logout', async (req, res) => {
    const { userId, tabId } = req.body;
    await store.removeSession(userId, tabId);
    await notifyAdmins(userId, 'disconnected', { tabId });
    res.json({ success: true });
});

// Admin Poller
app.get('/api/admin/users', async (req, res) => {
    res.json(await store.getAllSessions());
});

app.get('/api/admin/history', async (req, res) => {
    try {
        const logs = await TelemetryLog.findAll({
            limit: 200,
            order: [['timestamp', 'DESC']],
            include: [{ model: User, attributes: ['username'] }]
        });
        res.json(logs);
    } catch (e) {
        console.error("History Error:", e);
        res.status(500).json({ error: "Failed to fetch history" });
    }
});

// Check User Status
app.get('/api/users/:userId/status', async (req, res) => {
    const { userId } = req.params;
    try {
        const sessions = await Session.findAll({ where: { userId } });

        if (!sessions || sessions.length === 0) {
            return res.json({
                userId,
                status: 'offline',
                message: 'User is not currently connected.'
            });
        }

        const isFocused = sessions.some(s => s.state === 'FOCUSED');
        const status = isFocused ? 'active' : 'online'; // active = focused tab, online = background/hidden

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
// ---- Swagger Setup ----
// Load swagger.json directly
const swaggerSpec = require('./swagger.json');
// Ensure server URL is dynamic based on port
swaggerSpec.servers = [{ url: `http://localhost:${PORT}` }];

// Optional token protection middleware
function docsAuth(req, res, next) {
    const token = req.query.token || process.env.DOC_TOKEN;
    if (token && token === 'public') return next(); // simple public token
    return res.status(403).send('Acesso negado à documentação');
}

// Serve swagger static assets (no auth)
app.use('/api-docs', swaggerUi.serve);
// Protect the swagger UI HTML page
app.get('/api-docs', docsAuth, swaggerUi.setup(swaggerSpec));

// Start server
server.listen(PORT, () => {
    console.log(`🚀 Persistent Server (SQLite) running on port ${PORT}`);
});
