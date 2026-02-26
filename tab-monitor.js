/**
 * Browser Telemetry Script - Tab State Monitor
 * 
 * Purpose: Robust detection of browser tab states for high-scale automation/telemetry.
 * 
 * states:
 * - TAB_ACTIVE_FOCUSED: User is interacting with the page.
 * - TAB_ACTIVE_VISIBLE_UNFOCUSED: Page is visible (e.g. side-by-side) but not focused.
 * - TAB_ACTIVE_HIDDEN: Tab is backgrounded or minimized.
 * - TAB_POSSIBLY_SUSPENDED: Inferred state when script wakes up from a long pause.
 * 
 * Usage:
 *   const monitor = new TabMonitor({
 *     endpoint: 'https://api.example.com/telemetry',
 *     tabId: 'custom-uuid-or-generated',
 *     heartbeatInterval: 5000
 *   });
 *   monitor.start();
 */

(function (global) {
    // --- Configuration & Constants ---
    const STATES = {
        FOCUSED: 'TAB_ACTIVE_FOCUSED',
        VISIBLE_UNFOCUSED: 'TAB_ACTIVE_VISIBLE_UNFOCUSED',
        HIDDEN: 'TAB_ACTIVE_HIDDEN',
        SUSPENDED: 'TAB_POSSIBLY_SUSPENDED' // Used for reporting wake-ups
    };

    const DEFAULTS = {
        endpoint: null, // REQUIRED
        heartbeatInterval: 5000,
        tabId: null, // If null, generated
        debug: false
    };

    class TabMonitor {
        constructor(config) {
            this.config = { ...DEFAULTS, ...config };

            if (!this.config.tabId) {
                this.config.tabId = (typeof crypto !== 'undefined' && crypto.randomUUID)
                    ? crypto.randomUUID()
                    : this._generateFallbackUUID();
            }

            this.state = this._determineState();
            this.lastHeartbeat = Date.now();
            this.heartbeatTimer = null;
            this.isSuspended = false;

            // Bind methods to keep 'this' context
            this._handleVisibilityChange = this._handleVisibilityChange.bind(this);
            this._handleFocusParams = this._handleFocusParams.bind(this);
            this._handleUnload = this._handleUnload.bind(this);
            this._heartbeatTick = this._heartbeatTick.bind(this);
        }

        /**
         * Core logic to determine current technical state.
         * Adheres strictly to document properties.
         */
        _determineState() {
            if (document.visibilityState === 'hidden') {
                return STATES.HIDDEN;
            }
            if (document.hasFocus()) {
                return STATES.FOCUSED;
            }
            return STATES.VISIBLE_UNFOCUSED;
        }

        /**
         * Starts the monitor: listeners and heartbeat.
         */
        start() {
            this._log('Starting TabMonitor...');

            // Initial State Report
            this._reportEvent('init', this.state);

            // DOM Events
            document.addEventListener('visibilitychange', this._handleVisibilityChange);
            window.addEventListener('focus', this._handleFocusParams);
            window.addEventListener('blur', this._handleFocusParams);
            window.addEventListener('beforeunload', this._handleUnload);

            // Network Events (Store & Forward)
            window.addEventListener('online', () => this._onNetworkRecovery());
            window.addEventListener('offline', () => this._log('Network lost. Queueing events...'));

            // Heartbeat
            this.heartbeatTimer = setInterval(this._heartbeatTick, this.config.heartbeatInterval);
        }

        stop() {
            document.removeEventListener('visibilitychange', this._handleVisibilityChange);
            window.removeEventListener('focus', this._handleFocusParams);
            window.removeEventListener('blur', this._handleFocusParams);
            window.removeEventListener('beforeunload', this._handleUnload);
            if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        }

        // --- Event Handlers ---

        _handleVisibilityChange() {
            this._checkAndReportChange();
        }

        _onNetworkRecovery() {
            this._log('Network recovered! Flushing queue...');
            this._flushQueue();
        }

        _handleFocusParams() {
            // Small timeout to allow activeElement/document.hasFocus to settle
            setTimeout(() => this._checkAndReportChange(), 0);
        }

        _handleUnload() {
            // Attempt to send final "closing" state
            // Note: unreliable in some modern browsers, but sendBeacon usually works
            this._sendBeacon({
                type: 'shutdown',
                state: 'TAB_PROBABLY_CLOSED',
                timestamp: Date.now()
            });
        }

        _heartbeatTick() {
            const now = Date.now();
            const timeDelta = now - this.lastHeartbeat;
            const threshold = this.config.heartbeatInterval * 1.5;

            // Suspension Detection check (Wake up logic)
            if (timeDelta > threshold) {
                this._log(`Suspension detected! Time jump: ${timeDelta}ms`);
                this._reportEvent('wakeup', STATES.SUSPENDED, { suspensionDuration: timeDelta });
                // We don't change this.state to SUSPENDED permanently, as we are technically awake now.
                // We just report that we WERE suspended.
            }

            this.lastHeartbeat = now;

            // Standard Heartbeat
            // We re-evaluate state just in case an event was missed (rare but possible)
            const currentState = this._determineState();
            if (currentState !== this.state) {
                this._checkAndReportChange(); // Recover consistency
            }

            this._sendBeacon({
                type: 'heartbeat',
                state: this.state,
                timestamp: now
            });
        }

        // --- Helpers ---

        _checkAndReportChange() {
            const newState = this._determineState();
            if (newState !== this.state) {
                this._log(`State Change: ${this.state} -> ${newState}`);
                this.state = newState;
                this._reportEvent('state_change', newState);
            }
        }

        _generateFallbackUUID() {
            return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
                const r = Math.random() * 16 | 0;
                const v = c === 'x' ? r : (r & 0x3 | 0x8);
                return v.toString(16);
            });
        }

        _reportEvent(type, state, extraData = {}) {
            const payload = {
                type,
                state,
                timestamp: Date.now(),
                ...extraData
            };
            this._sendBeacon(payload);
        }

        /**
         * Transmit data.
         * Uses sendBeacon if available and suitable, falls back to fetch with keepalive.
         * Now includes OFFLINE QUEUEING (Store & Forward).
         */
        _sendBeacon(data) {
            const payload = {
                tabId: this.config.tabId,
                ...data
            };

            // 1. Queue if Offline
            if (!navigator.onLine) {
                this._addToQueue(payload);
                return;
            }

            const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });

            if (!this.config.endpoint) {
                this._log('Telemetry emitted (No Endpoint):', payload);
                return;
            }

            // 2. Attempt sendBeacon
            if (navigator.sendBeacon) {
                const success = navigator.sendBeacon(this.config.endpoint, blob);
                if (!success) {
                    // Start Queueing if API returns false (full buffer, etc)
                    this._addToQueue(payload);
                }
                return;
            }

            // 3. Fallback to fetch
            fetch(this.config.endpoint, {
                method: 'POST',
                body: JSON.stringify(payload),
                headers: { 'Content-Type': 'application/json' },
                keepalive: true
            }).catch(err => {
                console.error('Telemetry Error -> Queuing:', err);
                this._addToQueue(payload);
            });
        }

        // --- Queue System ---

        _addToQueue(payload) {
            let queue = JSON.parse(localStorage.getItem('telemetry_queue') || '[]');
            queue.push(payload);

            // Cap queue size to prevent memory explosion
            if (queue.length > 500) queue.shift();

            localStorage.setItem('telemetry_queue', JSON.stringify(queue));
            this._log(`Event queued. Total backlog: ${queue.length}`);

            // Fire event for UI
            window.dispatchEvent(new CustomEvent('telemetry-queue-updated', { detail: queue.length }));
        }

        _flushQueue() {
            let queue = JSON.parse(localStorage.getItem('telemetry_queue') || '[]');
            if (queue.length === 0) return;

            this._log(`Flushing ${queue.length} events...`);

            const backupQueue = [...queue];
            localStorage.setItem('telemetry_queue', '[]');
            window.dispatchEvent(new CustomEvent('telemetry-queue-updated', { detail: 0 }));

            backupQueue.forEach(payload => {
                this._sendBeacon(payload);
            });
        }

        _log(...args) {
            if (this.config.debug) {
                console.log('[TabMonitor]', ...args);
            }
        }
        // --- Keep-Alive Hack (Audio) ---
        enableKeepAlive() {
            if (this.audioElement) return; // Already running

            this._log('🔇 Enabling Audio Keep-Alive to prevent suspension...');

            // Create audio context or element loop
            // We use a base64 tiny silent mp3 to avoid external requests
            const SILENT_MP3 = 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4LjIwLjEwMAAAAAAAAAAAAAAA//OEAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAEAAABIADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMD//////////////////////////////////////////////////////////////////8AAAA9TGF2YzU4LjEzAAAAAAAAAAAAAAAAJAAAAAAAAAAAASAAAAAAASAA//OUAAAAAAAAAAAAAAAAAAAAAAAABYaJngAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//OEAAAAAAAAAAAAAAAAAAAAAAAABYaJngAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//OEAAAAAAAAAAAAAAAAAAAAAAAABYaJngAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//OEAAAAAAAAAAAAAAAAAAAAAAAABYaJngAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

            this.audioElement = new Audio(SILENT_MP3);
            this.audioElement.loop = true;
            this.audioElement.volume = 0.01; // Not perfectly 0 to ensure priority, but inaudible

            // User interaction required to play
            this.audioElement.play().then(() => {
                this._log('🔊 Keep-Alive Active: Browser will not suspend this tab.');
                this._reportEvent('keep_alive_status', 'ACTIVE');
            }).catch(e => {
                console.warn("Autoplay blocked. User interaction needed.", e);
                this._reportEvent('keep_alive_status', 'BLOCKED_BY_BROWSER');
            });
        }

        disableKeepAlive() {
            if (this.audioElement) {
                this.audioElement.pause();
                this.audioElement = null;
                this._log('🔇 Keep-Alive Disabled.');
            }
        }
    }

    // Expose to global scope
    global.TabMonitor = TabMonitor;

})(window);
