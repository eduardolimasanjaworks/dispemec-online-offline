// --- TELEMETRY UTILITY CLASS (Migrated) ---
class TabMonitor {
    constructor(config) {
        // Usa a mesma origem da página; em dev o Vite proxy redireciona /api para o backend.
        const backendOrigin = window.location.origin;

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
        this.sessionVersion = null;
        this.lastHeartbeat = Date.now();
        this.audioElement = null;
        this.socket = null;

        // Bindings
        this._handleVisibility = this._handleVisibility.bind(this);
        this._heartbeatTick = this._heartbeatTick.bind(this);
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

        this.interval = setInterval(this._heartbeatTick, this.config.heartbeatInterval);
        this.periodicInterval = setInterval(this._periodicTick, 60000); // 60s History Log

        // Initial Ping
        return this._sendBeacon({ type: 'init', state: this.state });
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
        this._sendBeacon({ type: 'heartbeat', state: this.state }).catch(() => {});
    }

    _periodicTick() {
        this._sendBeacon({ type: 'periodic_log', state: this.state }).catch(() => {});
    }

    _generateFallbackUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    _newOperationId() {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
            return crypto.randomUUID();
        }
        return this._generateFallbackUUID();
    }

    async _readResponseBody(response) {
        const raw = await response.text();
        if (!raw) return null;
        try {
            return JSON.parse(raw);
        } catch (_ignored) {
            return { rawText: raw };
        }
    }

    async _sendBeacon(data, options = {}) {
        const retryOnConflict = options.retryOnConflict !== false;
        const operationId = options.operationId || this._newOperationId();
        const payload = {
            ...data,
            tabId: this.config.tabId,
            userId: this.config.userId,
            timestamp: Date.now(),
            operationId
        };
        if (this.sessionVersion !== null && this.sessionVersion !== undefined) {
            payload.version = this.sessionVersion;
        }

        // Use FETCH with keepalive instead of sendBeacon for better reliability and debugging
        try {
            const response = await fetch(this.config.endpoint, {
                method: 'POST',
                body: JSON.stringify(payload),
                headers: { 'Content-Type': 'application/json' },
                keepalive: true
            });

            if (!response.ok) {
                const errorBody = await this._readResponseBody(response);

                if (response.status === 409 && retryOnConflict) {
                    const conflictVersion = errorBody && errorBody.conflict ? Number(errorBody.conflict.currentVersion) : null;
                    if (Number.isFinite(conflictVersion)) {
                        this.sessionVersion = conflictVersion;
                    }
                    return this._sendBeacon(data, { retryOnConflict: false, operationId });
                }

                if (typeof this.config.onConnectivityChange === 'function') {
                    this.config.onConnectivityChange('degraded', {
                        httpStatus: response.status,
                        eventType: data.type
                    });
                }

                console.error(`[TabMonitor] Server Error: ${response.status}`, errorBody);
                return false;
            }

            const body = await this._readResponseBody(response);
            if (body && Number.isFinite(Number(body.sessionVersion))) {
                this.sessionVersion = Number(body.sessionVersion);
            }
            if (typeof this.config.onConnectivityChange === 'function') {
                this.config.onConnectivityChange('online', { eventType: data.type });
            }
            return true;
        } catch (e) {
            if (typeof this.config.onConnectivityChange === 'function') {
                this.config.onConnectivityChange('offline-safe', {
                    eventType: data.type,
                    errorMessage: e && e.message ? e.message : String(e)
                });
            }
            if (typeof this.config.onCriticalError === 'function') {
                this.config.onCriticalError({
                    level: 'error',
                    eventType: 'tab_monitor_network_failure',
                    message: 'Falha de rede em envio de telemetria',
                    stack: e && e.stack ? e.stack : null,
                    context: {
                        eventType: data.type,
                        tabId: this.config.tabId,
                        userId: this.config.userId
                    }
                });
            }
            console.error('[TabMonitor] Network Failure:', e);
            return false;
        }
    }
}

export default TabMonitor;
