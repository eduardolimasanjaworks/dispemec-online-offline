import React, { useMemo, useRef, useState, useEffect } from 'react';
import TabMonitor from './TabMonitor';
import { io } from "socket.io-client";
import { attachGlobalErrorHandlers, createClientErrorReporter } from './reliability/clientErrorReporter';
import {
  canStartDuty,
  CONNECTION_MODES,
  FAILURE_LOCK_THRESHOLD,
  isLockableMode,
  nextModeAfterConnectivity
} from './reliability/connectivityPolicy';
import './App.css';


// --- ICONS (SVGs) ---
const IconHome = () => <svg className="icon" viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>;
const IconLogout = () => <svg className="icon" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>;
const IconShield = () => <svg className="icon" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>;
const IconUsers = () => <svg className="icon" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>;
const IconZap = () => <svg className="icon" viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>;
const IconShape = () => <svg className="icon" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>;
const IconLock = () => <svg className="icon" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>;

// Determina o endpoint (Relativo para o build unificado no Docker)
const API_BASE = '/api';
const SOCKET_URL = '/';
const STORAGE_AUTH_KEY = 'telemetry.auth.user';
const STORAGE_DUTY_KEY = 'telemetry.duty.active';
const STORAGE_TAB_ID_KEY_PREFIX = 'telemetry.tab.id.';
const SOCKET_RECONNECT_OPTIONS = {
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 500,
  reconnectionDelayMax: 5000,
  randomizationFactor: 0.5,
  timeout: 10000
};

function App() {
  const [user, setUser] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_AUTH_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.id || !parsed.username || !parsed.role) return null;
      return parsed;
    } catch (_e) {
      return null;
    }
  }); // { id, username, role }
  const [isOnline, setIsOnline] = useState(false);
  const [monitor, setMonitor] = useState(null);
  const [connectionMode, setConnectionMode] = useState(
    nextModeAfterConnectivity(typeof navigator !== 'undefined' && navigator.onLine)
  ); // online | degraded | offline-safe | locked
  const [lockReason, setLockReason] = useState('');
  const consecutiveFailuresRef = useRef(0);
  const monitorRef = useRef(null);
  const startInProgressRef = useRef(false);
  const resumeAttemptedRef = useRef(false);

  // Admin State
  const [adminData, setAdminData] = useState({});
  const [healthData, setHealthData] = useState(null);
  const [healthGeneratedAt, setHealthGeneratedAt] = useState(null);
  const [historyData, setHistoryData] = useState([]);
  const [activeTab, setActiveTab] = useState('realtime'); // 'realtime' | 'history' | 'credentials'
  const [socket, setSocket] = useState(null);
  const [usersData, setUsersData] = useState([]);
  const usersById = useMemo(() => {
    const map = {};
    for (const u of usersData) {
      if (u?.id) map[u.id] = u;
    }
    return map;
  }, [usersData]);

  const reportClientError = useMemo(() => createClientErrorReporter({
    apiBase: API_BASE,
    getUserId: () => user?.id || null
  }), [user?.id]);

  const applyConnectivityMode = (mode, reason = '') => {
    if (mode === CONNECTION_MODES.ONLINE) {
      consecutiveFailuresRef.current = 0;
      setConnectionMode(CONNECTION_MODES.ONLINE);
      setLockReason('');
      return;
    }

    if (isLockableMode(mode)) {
      consecutiveFailuresRef.current += 1;
      if (consecutiveFailuresRef.current >= FAILURE_LOCK_THRESHOLD) {
        setConnectionMode(CONNECTION_MODES.LOCKED);
        setLockReason(reason || `Lock automático após ${FAILURE_LOCK_THRESHOLD} falhas consecutivas.`);
        return;
      }
      setConnectionMode((prev) => (prev === CONNECTION_MODES.LOCKED ? prev : mode));
      if (reason) setLockReason(reason);
      return;
    }

    setConnectionMode(mode);
    if (reason) setLockReason(reason);
  };

  const getTabStorageKey = (userId) => `${STORAGE_TAB_ID_KEY_PREFIX}${userId}`;
  const getOrCreateStableTabId = (userId) => {
    const key = getTabStorageKey(userId);
    try {
      const existing = sessionStorage.getItem(key);
      if (existing) return existing;
      const generated = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `tab-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      sessionStorage.setItem(key, generated);
      return generated;
    } catch (_e) {
      return (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `tab-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
  };

  useEffect(() => {
    const onOnline = () => {
      applyConnectivityMode(CONNECTION_MODES.ONLINE);
    };
    const onOffline = () => {
      applyConnectivityMode(CONNECTION_MODES.OFFLINE_SAFE, 'Sem conectividade de rede no navegador.');
    };

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  useEffect(() => {
    return attachGlobalErrorHandlers(reportClientError);
  }, [reportClientError]);

  useEffect(() => {
    try {
      if (user) {
        localStorage.setItem(STORAGE_AUTH_KEY, JSON.stringify(user));
        return;
      }
      localStorage.removeItem(STORAGE_AUTH_KEY);
    } catch (_e) {
      // Falha de storage não pode bloquear o uso da aplicação.
    }
  }, [user]);

  // --- LOGIN ---
  const handleLogin = async (e) => {
    e.preventDefault();
    const username = e.target.username.value;
    const password = e.target.password.value;
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const rawBody = await res.text();
      let data = {};
      try {
        data = rawBody ? JSON.parse(rawBody) : {};
      } catch (_parseError) {
        data = {};
      }
      if (data.success) {
        setUser(data.user);
      } else {
        alert(data.error || (res.ok ? 'Erro ao fazer login' : `Falha no login (${res.status})`));
      }
    } catch (err) {
      console.error("Login Error:", err);
      alert(`Erro ao conectar com o servidor: ${err.message || err.toString()}`);
    }
  };

  const fetchHistory = async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/history`);
      const data = await res.json();
      setHistoryData(data);
    } catch (e) {
      console.error("Erro ao carregar historico", e);
    }
  };

  useEffect(() => {
    if (activeTab === 'history' && user?.role === 'admin') {
      fetchHistory();
      const interval = setInterval(fetchHistory, 30000); // Atualiza a cada 30s
      return () => clearInterval(interval);
    }
  }, [activeTab, user]);

  const fetchUsers = async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/credentials`);
      if (res.ok) setUsersData(await res.json());
    } catch (e) {
      console.error("Erro ao carregar usuários", e);
    }
  };

  const fetchAdminSessions = async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/users`);
      if (!res.ok) return;
      const data = await res.json();
      setAdminData(data || {});
    } catch (e) {
      reportClientError({
        level: 'warn',
        eventType: 'admin_sessions_fetch_error',
        message: 'Falha ao sincronizar sessões ativas por API'
      });
    }
  };

  const fetchHealth = async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/health`);
      if (!res.ok) return;
      const data = await res.json();
      if (data?.success && data?.health) {
        setHealthData(data.health);
        setHealthGeneratedAt(data.generatedAt || null);
      }
    } catch (e) {
      reportClientError({
        level: 'warn',
        eventType: 'admin_health_fetch_error',
        message: 'Falha ao consultar métricas de saúde'
      });
    }
  };

  const createUser = async (e) => {
    e.preventDefault();
    const form = e.target;
    const body = {
      username: form.username.value,
      password: form.password.value,
      isAdmin: form.isAdmin.checked
    };

    try {
      const res = await fetch(`${API_BASE}/admin/credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (res.ok) {
        form.reset();
        fetchUsers();
        alert("Usuário criado com sucesso!");
      } else {
        const err = await res.json();
        alert(err.error || "Erro ao criar usuário.");
      }
    } catch (e) {
      alert("Erro ao criar usuário.");
    }
  };

  const deleteUser = async (id) => {
    if (!confirm("Tem certeza que deseja apagar este usuário?")) return;
    try {
      const res = await fetch(`${API_BASE}/admin/credentials/${id}`, { method: 'DELETE' });
      if (res.ok) {
        fetchUsers();
        alert("Usuário removido.");
      } else {
        const err = await res.json();
        alert(err.error || "Erro ao remover usuário.");
      }
    } catch (e) {
      alert("Erro ao remover usuário.");
    }
  };

  useEffect(() => {
    if (activeTab === 'credentials' && user?.role === 'admin') {
      fetchUsers();
    }
  }, [activeTab, user]);

  useEffect(() => {
    if (user?.role === 'admin') {
      fetchUsers();
    }
  }, [user]);

  // --- LOGOUT ---
  const handleLogout = async () => {
    if (monitor) {
      stopDuty();
    }
    if (socket) {
      socket.disconnect();
    }
    setUser(null);
    setAdminData({});
    try {
      localStorage.removeItem(STORAGE_AUTH_KEY);
      localStorage.removeItem(STORAGE_DUTY_KEY);
    } catch (_e) {
      // noop
    }
  };

  // --- DUTY TOGGLE ---
  const startDuty = async () => {
    if (!user?.id) return;
    if (startInProgressRef.current) return;
    if (monitorRef.current) return;

    if (connectionMode === CONNECTION_MODES.LOCKED) {
      alert('Não foi possível iniciar agora. Aguarde alguns segundos e tente novamente.');
      return;
    }
    if (!canStartDuty(connectionMode, navigator.onLine)) {
      alert('Sem conexão no momento. Verifique sua internet e tente novamente.');
      return;
    }

    startInProgressRef.current = true;
    try {
      const stableTabId = getOrCreateStableTabId(user.id);
      // 1. Criar Monitor
      const m = new TabMonitor({
        userId: user.id,
        tabId: stableTabId,
        onConnectivityChange: (mode, context) => {
          const reason = mode === CONNECTION_MODES.OFFLINE_SAFE
            ? 'Telemetria sem confirmação do servidor.'
            : '';
          applyConnectivityMode(mode, reason);
          if (mode === CONNECTION_MODES.DEGRADED) {
            reportClientError({
              level: 'warn',
              eventType: 'telemetry_degraded',
              message: 'Canal de telemetria degradado',
              context
            });
          }
        },
        onCriticalError: (errorPayload) => {
          applyConnectivityMode(CONNECTION_MODES.OFFLINE_SAFE, 'Falha crítica na telemetria cliente-servidor.');
          reportClientError(errorPayload);
        }
      });

      // 2. Ativar Proteção de Áudio (Hack)
      m.enableKeepAlive();

      // 3. Iniciar Rastreamento
      const started = await m.start();
      if (!started) {
        m.stop();
        applyConnectivityMode(CONNECTION_MODES.OFFLINE_SAFE, 'Não foi possível confirmar o início no servidor.');
        alert('Não foi possível iniciar agora. O servidor não confirmou sua sessão.');
        try {
          localStorage.removeItem(STORAGE_DUTY_KEY);
        } catch (_e) {
          // noop
        }
        return;
      }

      monitorRef.current = m;
      setMonitor(m);
      setIsOnline(true);
      applyConnectivityMode(CONNECTION_MODES.ONLINE);
      try {
        localStorage.setItem(STORAGE_DUTY_KEY, '1');
      } catch (_e) {
        // noop
      }
    } finally {
      startInProgressRef.current = false;
    }
  };

  const stopDuty = () => {
    const activeMonitor = monitorRef.current || monitor;
    if (activeMonitor) {
      activeMonitor.stop();
      // Enviar evento final manual
      activeMonitor._sendBeacon({ type: 'shutdown', state: 'USER_STOPPED_TRACKING' }).catch(() => {});
    }
    monitorRef.current = null;
    setMonitor(null);
    setIsOnline(false);
    try {
      localStorage.removeItem(STORAGE_DUTY_KEY);
      if (user?.id) {
        sessionStorage.removeItem(getTabStorageKey(user.id));
      }
    } catch (_e) {
      // noop
    }
  };

  useEffect(() => {
    if (!user) {
      resumeAttemptedRef.current = false;
      return;
    }
    if (resumeAttemptedRef.current || monitor || isOnline || startInProgressRef.current) return;
    resumeAttemptedRef.current = true;
    let mustResumeDuty = false;
    try {
      mustResumeDuty = localStorage.getItem(STORAGE_DUTY_KEY) === '1';
    } catch (_e) {
      mustResumeDuty = false;
    }
    if (mustResumeDuty) {
      startDuty();
    }
  }, [user, monitor, isOnline]);

  useEffect(() => {
    return () => {
      if (monitorRef.current) {
        // Cleanup defensivo para evitar monitores duplicados (ex.: StrictMode em dev).
        monitorRef.current.stop();
        monitorRef.current = null;
      }
      startInProgressRef.current = false;
    };
  }, []);

  const healthStatusLabel = (status) => {
    if (status === 'critico') return 'Crítico';
    if (status === 'degradado') return 'Degradado';
    return 'Saudável';
  };

  // --- ADMIN SOCKET ---
  useEffect(() => {
    if (user?.role === 'admin') {
      console.log("👑 Iniciando conexão Admin...");
      const s = io(SOCKET_URL, SOCKET_RECONNECT_OPTIONS);

      s.on('connect', () => {
        console.log("✅ Socket Conectado! ID:", s.id);
        s.emit('join_admin');
        fetchAdminSessions();
      });

      s.on('disconnect', (reason) => {
        console.warn("⚠️ Socket desconectado:", reason);
        applyConnectivityMode(CONNECTION_MODES.DEGRADED, 'Canal de atualização em tempo real desconectado.');
      });

      s.io.on('reconnect_attempt', (attempt) => {
        console.warn(`🔁 Tentando reconectar socket (tentativa ${attempt})`);
      });

      s.io.on('reconnect', () => {
        console.log("♻️ Socket reconectado, requisitando snapshot");
        s.emit('join_admin');
        applyConnectivityMode(CONNECTION_MODES.ONLINE);
        fetchAdminSessions();
      });

      s.io.on('reconnect_error', (err) => {
        console.error("❌ Erro de reconexão socket:", err?.message || err);
        applyConnectivityMode(CONNECTION_MODES.DEGRADED, 'Falha de reconexão do canal em tempo real.');
        reportClientError({
          level: 'warn',
          eventType: 'socket_reconnect_error',
          message: err?.message || 'Falha na reconexão do canal em tempo real'
        });
      });

      s.on('full_snapshot', (data) => {
        console.log("📥 Recebido Snapshot Completo:", data);
        setAdminData(data);
      });

      s.on('admin_watchdog_ping', ({ serverTs }) => {
        s.emit('admin_watchdog_pong', { serverTs, clientTs: Date.now() });
      });

      s.on('session_update', ({ userId, eventType, data, timestamp }) => {
        setAdminData(prev => {
          const next = { ...prev };

          if (eventType === 'disconnected') {
            if (next[userId]) {
              delete next[userId][data.tabId];
              if (Object.keys(next[userId]).length === 0) {
                delete next[userId];
              }
            }
            return next;
          }

          if (!next[userId]) next[userId] = {};
          next[userId][data.tabId] = {
            ...(next[userId][data.tabId] || {}),
            state: data.state,
            lastSeen: timestamp,
            ip: data.ip
          };

          return next;
        });
      });

      setSocket(s);

      return () => {
        console.log("🔌 Desconectando Admin...");
        s.disconnect();
      };
    }
  }, [user]);

  useEffect(() => {
    if (user?.role === 'admin' && activeTab === 'realtime') {
      fetchHealth();
      const interval = setInterval(fetchHealth, 10000);
      return () => clearInterval(interval);
    }
  }, [user, activeTab]);

  useEffect(() => {
    if (user?.role === 'admin' && activeTab === 'realtime') {
      fetchAdminSessions();
      const interval = setInterval(fetchAdminSessions, 5000);
      return () => clearInterval(interval);
    }
  }, [user, activeTab]);

  if (!user) {
    return (
      <div className="login-container">
        <div className="card" style={{ width: '400px', alignItems: 'center', textAlign: 'center', border: '1px solid #333' }}>
          <div style={{ color: '#F5008D', marginBottom: '20px' }}>
            <IconShield style={{ width: 48, height: 48 }} />
          </div>
          <h1 style={{ fontSize: '24px', marginBottom: '10px' }}>Login Restrito</h1>
          <p style={{ color: '#888', marginBottom: '30px' }}>Acesse o painel com suas credenciais.</p>

          <form onSubmit={handleLogin} style={{ width: '100%' }}>
            <input name="username" placeholder="Usuário" required autoFocus />
            <input name="password" type="password" placeholder="Senha" required />
            <button type="submit" className="btn btn-primary btn-full">
              ACESSAR SISTEMA
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="app-layout">
      {/* SIDEBAR */}
      <div className="sidebar">
        <div className={`sidebar-icon ${activeTab === 'realtime' ? 'active' : ''}`} onClick={() => setActiveTab('realtime')}>
          <IconHome />
        </div>
        {user.role === 'admin' && (
          <>
            <div className={`sidebar-icon ${activeTab === 'history' ? 'active' : ''}`} onClick={() => setActiveTab('history')}>
              <IconUsers />
            </div>
            <div className={`sidebar-icon ${activeTab === 'credentials' ? 'active' : ''}`} onClick={() => setActiveTab('credentials')}>
              <IconLock />
            </div>
          </>
        )}
        <div style={{ flex: 1 }}></div>
        <div className="sidebar-icon" onClick={handleLogout} title="Sair">
          <IconLogout />
        </div>
      </div>

      {/* MAIN */}
      <div className="main-content">
        <header>
          <div className="page-title">
            {user.role === 'admin' ? (
              activeTab === 'realtime' ? 'Monitoramento Real' :
                activeTab === 'history' ? 'Histórico Detalhado' :
                  'Gestão de Credenciais'
            ) : 'Minha Estação'}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '15px', color: 'white' }}>
            <span style={{ fontWeight: '600' }}>{user.username}</span>
            <div style={{ width: 32, height: 32, background: '#F5008D', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 'bold' }}>
              {user.username.charAt(0).toUpperCase()}
            </div>
          </div>
        </header>

        {/* DASHBOARD WORKER */}
        {user.role !== 'admin' && (
          <div className="grid-container">
            <div className="hero-status">
              <div>
                <h2 style={{ margin: '0 0 10px 0', fontSize: '28px' }}>
                  {isOnline ? 'Sessão Ativa' : 'Sessão Inativa'}
                </h2>
                <p style={{ margin: 0, opacity: 0.7, maxWidth: '400px' }}>
                  {isOnline
                    ? "Tudo certo. Pode trabalhar normalmente nesta aba."
                    : "Clique no botão abaixo para informar que você está trabalhando."}
                </p>
              </div>
              <div className={`status-dot ${isOnline ? 'online' : 'offline'}`} style={{ width: 20, height: 20 }}></div>
            </div>

            <div className="card-grid">
              <div className="card">
                <h3><IconZap /> Meu Trabalho</h3>
                <p>Use apenas este botão para iniciar ou encerrar sua sessão.</p>
                <button
                  className={`btn btn-full ${isOnline ? 'btn-secondary' : 'btn-primary'}`}
                  onClick={isOnline ? stopDuty : startDuty}
                >
                  {isOnline ? 'PARAR DE TRABALHAR' : 'ESTOU TRABALHANDO'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* DASHBOARD ADMIN */}
        {user.role === 'admin' && activeTab === 'realtime' && (
          <div>
            <div className="card-grid" style={{ marginBottom: '30px' }}>
              <div className="card">
                <h3><IconShape /> Sessões Ativas</h3>
                <div style={{ fontSize: '36px', fontWeight: '700' }}>{Object.keys(adminData).length}</div>
              </div>
              <div className="card">
                <h3><IconShield /> Saúde do Sistema</h3>
                <p>Status geral: <strong>{healthStatusLabel(healthData?.healthStatus)}</strong></p>
                <p>Recomendação: <strong>{healthData?.recommendation || 'Aguardando dados de saúde.'}</strong></p>
                <p>Latência média: <strong>{healthData?.latency?.avgMs ?? 0} ms</strong></p>
                <p>Latência p95: <strong>{healthData?.latency?.p95Ms ?? 0} ms</strong></p>
                <p>Conflitos (janela): <strong>{healthData?.telemetryConflictCount ?? 0}</strong></p>
                <p>Sessões acima do SLA: <strong>{healthData?.sessionsOverSla ?? 0}</strong></p>
                <p style={{ fontSize: '12px', color: '#777' }}>
                  Atualizado em: {healthGeneratedAt ? new Date(healthGeneratedAt).toLocaleTimeString() : '--:--:--'}
                </p>
              </div>
            </div>

            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>E-mail/Usuário</th>
                    <th>Status</th>
                    <th>Última Atividade</th>
                    <th>IP</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(adminData).map(([uid, tabs]) => (
                    Object.entries(tabs).map(([tid, info]) => (
                      <tr key={tid}>
                        <td style={{ fontWeight: 'bold' }}>
                          {((info.username && info.username !== 'Unknown') ? info.username : usersById[uid]?.username) || uid}
                        </td>
                        <td>
                          {info.state === 'TAB_ACTIVE_FOCUSED' && <span style={{ color: '#00E676', fontWeight: 'bold' }}>Em Foco</span>}
                          {info.state === 'TAB_ACTIVE_HIDDEN' && <span style={{ color: '#FF1744', fontWeight: 'bold' }}>Oculto</span>}
                          {info.state === 'TAB_ACTIVE_VISIBLE_UNFOCUSED' && <span style={{ color: '#FFAB00', fontWeight: 'bold' }}>Visível (Sem Foco)</span>}
                          {!['TAB_ACTIVE_FOCUSED', 'TAB_ACTIVE_HIDDEN', 'TAB_ACTIVE_VISIBLE_UNFOCUSED'].includes(info.state) && <span>{info.state}</span>}
                        </td>
                        <td>{new Date(info.lastSeen).toLocaleTimeString()}</td>
                        <td>{info.ip}</td>
                      </tr>
                    ))
                  ))}
                  {Object.keys(adminData).length === 0 && (
                    <tr><td colSpan="4" style={{ textAlign: 'center', padding: '40px', color: '#999' }}>Nenhuma sessão encontrada.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* HISTÓRICO ADMIN */}
        {user.role === 'admin' && activeTab === 'history' && (
          <div>
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Data/Hora</th>
                    <th>Colaborador</th>
                    <th>Evento</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {historyData.map((log) => (
                    <tr key={log.id}>
                      <td style={{ color: '#666', fontSize: '12px' }}>
                        {new Date(log.timestamp).toLocaleString()}
                      </td>
                      <td style={{ fontWeight: 'bold' }}>
                        {(log.User && log.User.username) || usersById[log.userId]?.username || log.userId.substring(0, 8)}
                      </td>
                      <td>
                        {log.eventType === 'periodic_log' && <span style={{ color: '#aaa', fontSize: '12px' }}>Minuto a Minuto</span>}
                        {log.eventType === 'state_change' && <span style={{ color: '#007bff' }}>Mudança de Estado</span>}
                        {log.eventType === 'init' && <span style={{ color: '#00E676' }}>Login / Início</span>}
                        {log.eventType === 'shutdown' && <span style={{ color: '#FF1744' }}>Desconexão</span>}
                      </td>
                      <td>
                        {log.state === 'TAB_ACTIVE_FOCUSED' ? <span style={{ color: '#00E676' }}>Focado</span> :
                          log.state === 'TAB_ACTIVE_HIDDEN' ? <span style={{ color: '#FF1744' }}>Oculto</span> :
                            log.state === 'TAB_ACTIVE_VISIBLE_UNFOCUSED' ? <span style={{ color: '#FFAB00' }}>Visível (Sem Foco)</span> :
                              log.state}
                      </td>
                    </tr>
                  ))}
                  {historyData.length === 0 && (
                    <tr><td colSpan="4" style={{ textAlign: 'center', padding: '30px' }}>Nenhum histórico registrado.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* CREDENCIAIS ADMIN */}
        {user.role === 'admin' && activeTab === 'credentials' && (
          <div>
            <div className="card" style={{ marginBottom: '30px' }}>
              <h3><IconLock /> Criar Novo Usuário</h3>
              <form onSubmit={createUser} style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div style={{ flex: '1 1 200px' }}>
                  <label style={{ display: 'block', marginBottom: '5px', fontSize: '12px', color: '#999' }}>Usuário</label>
                  <input name="username" placeholder="Nome de usuário" required style={{ width: '100%' }} />
                </div>
                <div style={{ flex: '1 1 200px' }}>
                  <label style={{ display: 'block', marginBottom: '5px', fontSize: '12px', color: '#999' }}>Senha</label>
                  <input name="password" type="password" placeholder="Senha" required style={{ width: '100%' }} />
                </div>
                <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer' }}>
                    <input name="isAdmin" type="checkbox" />
                    <span style={{ fontSize: '14px' }}>Admin</span>
                  </label>
                  <button type="submit" className="btn btn-primary">Criar Usuário</button>
                </div>
              </form>
            </div>

            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Usuário</th>
                    <th>Tipo</th>
                    <th>Criado em</th>
                    <th>Último Login</th>
                    <th>Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {usersData.map((u) => (
                    <tr key={u.id}>
                      <td style={{ fontWeight: 'bold' }}>{u.username}</td>
                      <td>
                        {u.isAdmin ? (
                          <span style={{ color: '#F5008D', fontWeight: 'bold' }}>Admin</span>
                        ) : (
                          <span style={{ color: '#00E676' }}>Atendente</span>
                        )}
                      </td>
                      <td style={{ fontSize: '12px', color: '#666' }}>
                        {new Date(u.createdAt).toLocaleString()}
                      </td>
                      <td style={{ fontSize: '12px', color: '#666' }}>
                        {u.lastLogin ? new Date(u.lastLogin).toLocaleString() : 'Nunca'}
                      </td>
                      <td>
                        <button
                          onClick={() => deleteUser(u.id)}
                          className="btn btn-secondary"
                          style={{ padding: '5px 10px', fontSize: '12px' }}
                        >
                          Remover
                        </button>
                      </td>
                    </tr>
                  ))}
                  {usersData.length === 0 && (
                    <tr><td colSpan="5" style={{ textAlign: 'center', padding: '30px' }}>Nenhum usuário cadastrado.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

export default App;
