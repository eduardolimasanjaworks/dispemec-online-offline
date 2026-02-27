/**
 * Purpose: Centralizar regras de conectividade/lock para manter UI previsível.
 */
export const CONNECTION_MODES = Object.freeze({
  ONLINE: 'online',
  DEGRADED: 'degraded',
  OFFLINE_SAFE: 'offline-safe',
  LOCKED: 'locked'
});

export const FAILURE_LOCK_THRESHOLD = 3;

export function isLockableMode(mode) {
  return mode === CONNECTION_MODES.DEGRADED || mode === CONNECTION_MODES.OFFLINE_SAFE;
}

export function canStartDuty(mode, isNavigatorOnline) {
  if (!isNavigatorOnline) return false;
  return mode === CONNECTION_MODES.ONLINE || mode === CONNECTION_MODES.DEGRADED;
}

export function nextModeAfterConnectivity(isOnline) {
  return isOnline ? CONNECTION_MODES.ONLINE : CONNECTION_MODES.OFFLINE_SAFE;
}
