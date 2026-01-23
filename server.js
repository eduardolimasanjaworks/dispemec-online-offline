const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json({ type: ['application/json', 'text/plain'] }));
app.use(bodyParser.text());
app.use(express.static(path.join(__dirname)));

// --- IN-MEMORY SESSION STORE ---
// { 'userId': { 'tabId': { ip: '::1', lastSeen: 123456789 } } }
const activeSessions = {};

// Helper: Prune dead sessions
function pruneSessions(userId) {
    if (!activeSessions[userId]) return;
    const now = Date.now();
    for (const tId in activeSessions[userId]) {
        // Tolarance: 15s without heartbeat = dead
        if (now - activeSessions[userId][tId].lastSeen > 15000) {
            delete activeSessions[userId][tId];
        }
    }
}

// Helper: Get Session Stats
function getSessionStats(userId) {
    pruneSessions(userId);
    if (!activeSessions[userId]) return { tabCount: 0, distinctIps: 0 };

    const tabs = Object.values(activeSessions[userId]);
    const ips = new Set(tabs.map(t => t.ip));

    return {
        tabCount: tabs.length,
        distinctIps: ips.size,
        details: tabs
    };
}

// LOGIN ENDPOINT
app.post('/api/login', (req, res) => {
    const { username } = req.body;
    // Mock User ID generation - In prod, fetch from DB
    const userId = crypto.createHash('md5').update(username).digest("hex");

    console.log(`👤 LOGIN: ${username} (${userId})`);

    res.json({
        success: true,
        userId: userId,
        username: username
    });
});

// LOGOUT ENDPOINT
app.post('/api/logout', (req, res) => {
    const { userId, tabId } = req.body;
    console.log(`👋 LOGOUT: ${userId} (Tab: ${tabId})`);

    if (activeSessions[userId]) {
        // Remove specific tab session
        if (tabId && activeSessions[userId][tabId]) {
            delete activeSessions[userId][tabId];
        }
        // Optional: specific logic to clear all user sessions could go here
    }

    res.json({ success: true });
});

// TELEMETRY ENDPOINT
app.post('/api/telemetry', (req, res) => {
    let payload = req.body;
    if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch (e) { }
    }

    const { tabId, userId, type } = payload;
    const ip = req.ip || req.socket.remoteAddress;

    // 1. Register/Update Session Activity
    if (userId && tabId) {
        if (!activeSessions[userId]) activeSessions[userId] = {};

        // If this is a cleanup/disconnect event, remove the tab
        if (type === 'shutdown' || payload.state === 'TAB_PROBABLY_CLOSED') {
            delete activeSessions[userId][tabId];
        } else {
            activeSessions[userId][tabId] = {
                ip: ip,
                lastSeen: Date.now(),
                state: payload.state
            };
        }
    }

    // 2. Analyze for Duplicates
    let securityAlert = null;
    if (userId) {
        const stats = getSessionStats(userId);
        if (stats.tabCount > 1) {
            securityAlert = `⚠️ MULTIPLE TABS DETECTED (MÚLTIPLAS ABAS DETECTADAS): User has ${stats.tabCount} active tabs.`;
        }
        if (stats.distinctIps > 1) {
            securityAlert = `🚨 MULTIPLE IPS DETECTED (MÚLTIPLOS IPS DETECTADOS): User logged in from ${stats.distinctIps} locations!`;
        }

        // Log to server console
        if (type === 'heartbeat' || type === 'state_change') {
            const time = new Date().toISOString().split('T')[1].slice(0, -1);
            console.log(`[${time}] ${userId.slice(0, 6)}.. | Tabs: ${stats.tabCount} | IPs: ${stats.distinctIps} | ${payload.state}`);
            if (securityAlert) console.log(`      ↳ ${securityAlert}`);
        }
    }

    // 3. Response (Piggyback alerts to frontend if needed)
    res.json({
        received: true,
        serverTime: Date.now(),
        securityAlert // Send back to UI to show "You are open elsewhere!"
    });
});

app.listen(PORT, () => {
    console.log(`
    🚀 Server running on http://localhost:${PORT}
       - Login system active
       - Multitenancy detection active
        `);
});

