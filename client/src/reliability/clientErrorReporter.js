/**
 * Purpose: Reportar erros críticos do cliente para o backend de forma padronizada.
 */
function truncate(text, maxLength) {
  if (typeof text !== 'string') return null;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

export function createClientErrorReporter({ apiBase, getUserId }) {
  return async function reportClientError(payload) {
    try {
      await fetch(`${apiBase}/client/errors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          ...payload,
          message: truncate(payload?.message || 'client error', 1000),
          stack: truncate(payload?.stack || '', 6000),
          clientTimestamp: Date.now(),
          url: window.location.href,
          userId: typeof getUserId === 'function' ? getUserId() : null
        })
      });
    } catch (_ignored) {
      // Não propaga erro para evitar loop de falha na própria telemetria de erro.
    }
  };
}

export function attachGlobalErrorHandlers(reportClientError) {
  const onError = (event) => {
    reportClientError({
      level: 'error',
      eventType: 'window_error',
      message: event.message || 'window error',
      stack: event.error?.stack || null,
      context: {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno
      }
    });
  };

  const onUnhandled = (event) => {
    reportClientError({
      level: 'error',
      eventType: 'unhandled_rejection',
      message: event.reason?.message || String(event.reason || 'unhandled rejection'),
      stack: event.reason?.stack || null
    });
  };

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onUnhandled);

  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onUnhandled);
  };
}
