import { io } from "socket.io-client";

// --- TELEMETRY UTILITY CLASS (Migrated) ---
class TabMonitor {
    constructor(config) {
        // Encontra a origem real ou cai pro padrão se tiver rodando fora do servidor Web
        const backendOrigin = window.location.hostname === 'localhost'
            ? 'http://localhost:3001'
            : window.location.origin;

        this.config = {
            endpoint: `${backendOrigin}/api/telemetry`,
            heartbeatInterval: 5000,
            ...config
        };

        if (!this.config.tabId) {
            this.config.tabId = (typeof crypto !== 'undefined' && crypto.randomUUID)
                ? crypto.randomUUID()
                : this._generateFallbackUUID();
        }

        this.state = this._determineState();
        this.lastHeartbeat = Date.now();
        this.audioElement = null;
        this.socket = null;

        // Bindings
        this._handleVisibility = this._handleVisibility.bind(this);
        this._heartbeatTick = this._heartbeatTick.bind(this);
        this._handleUnload = this._handleUnload.bind(this);
        this._periodicTick = this._periodicTick.bind(this);
    }

    _determineState() {
        if (document.visibilityState === 'hidden') return 'TAB_ACTIVE_HIDDEN';
        if (document.hasFocus()) return 'TAB_ACTIVE_FOCUSED';
        return 'TAB_ACTIVE_VISIBLE_UNFOCUSED';
    }

    start() {
        console.log('[TabMonitor] Starting...');
        document.addEventListener('visibilitychange', this._handleVisibility);
        window.addEventListener('focus', this._handleVisibility);
        window.addEventListener('blur', this._handleVisibility);
        window.addEventListener('beforeunload', this._handleUnload);

        this.interval = setInterval(this._heartbeatTick, this.config.heartbeatInterval);
        this.periodicInterval = setInterval(this._periodicTick, 60000); // 60s History Log

        // Initial Ping
        this._sendBeacon({ type: 'init', state: this.state });
    }

    stop() {
        clearInterval(this.interval);
        clearInterval(this.periodicInterval);
        document.removeEventListener('visibilitychange', this._handleVisibility);
        window.removeEventListener('focus', this._handleVisibility);
        window.removeEventListener('blur', this._handleVisibility);
        this.disableKeepAlive();
    }

    enableKeepAlive() {
        if (this.audioContext) return;

        try {
            // Use Web Audio API instead of HTML5 Audio Element for better stability without loading files
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) return;

            this.audioContext = new AudioContext();

            // Create an oscillator (sound generator)
            const oscillator = this.audioContext.createOscillator();
            const gainNode = this.audioContext.createGain();

            // Set extremely low frequency and zero volume (silent but active)
            oscillator.type = 'sine';
            oscillator.frequency.value = 1; // 1Hz (inaudible)

            // Connect to gain (volume control)
            gainNode.gain.value = 0.0001; // Not 0, but almost 0, to force processing

            oscillator.connect(gainNode);
            gainNode.connect(this.audioContext.destination);

            oscillator.start();
            this.oscillator = oscillator;

            console.log('[TabMonitor] 🔊 Web Audio API Keep-Alive Started');
        } catch (e) {
            console.warn("[TabMonitor] Failed to start audio context:", e);
        }
    }

    disableKeepAlive() {
        try {
            if (this.oscillator) {
                this.oscillator.stop();
                this.oscillator.disconnect();
                this.oscillator = null;
            }
            if (this.audioContext) {
                this.audioContext.close();
                this.audioContext = null;
            }
            console.log('[TabMonitor] 🔇 Audio Keep-Alive Stopped');
        } catch (e) {
            console.error("Error stopping audio:", e);
        }
    }

    _handleVisibility() {
        // Small delay to let focus settle
        setTimeout(() => {
            const newState = this._determineState();
            if (newState !== this.state) {
                this.state = newState;
                this._sendBeacon({ type: 'state_change', state: newState });
            }
        }, 50);
    }

    _heartbeatTick() {
        this._sendBeacon({ type: 'heartbeat', state: this.state });
    }

    _periodicTick() {
        this._sendBeacon({ type: 'periodic_log', state: this.state });
    }

    _handleUnload() {
        this._sendBeacon({ type: 'shutdown', state: 'TAB_PROBABLY_CLOSED' });
    }

    _generateFallbackUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    async _sendBeacon(data) {
        const payload = {
            ...data,
            tabId: this.config.tabId,
            userId: this.config.userId,
            timestamp: Date.now()
        };

        // Use FETCH with keepalive instead of sendBeacon for better reliability and debugging
        try {
            const response = await fetch(this.config.endpoint, {
                method: 'POST',
                body: JSON.stringify(payload),
                headers: { 'Content-Type': 'application/json' },
                keepalive: true
            });

            if (!response.ok) {
                console.error(`[TabMonitor] Server Error: ${response.status}`, await response.text());
            } else {
                // console.log('[TabMonitor] Beat sent', payload.state);
            }
        } catch (e) {
            console.error('[TabMonitor] Network Failure:', e);
        }
    }
}

export default TabMonitor;
