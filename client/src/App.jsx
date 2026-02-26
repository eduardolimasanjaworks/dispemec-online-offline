import React, { useState, useEffect } from 'react';
import TabMonitor from './TabMonitor';
import { io } from "socket.io-client";
import './App.css';


// --- ICONS (SVGs) ---
const IconHome = () => <svg className="icon" viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>;
const IconLogout = () => <svg className="icon" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>;
const IconShield = () => <svg className="icon" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>;
const IconUsers = () => <svg className="icon" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>;
const IconZap = () => <svg className="icon" viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>;
const IconShape = () => <svg className="icon" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>;
const IconLock = () => <svg className="icon" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>;

// Determina o endpoint dinamicamente (Vite Localhost vs NGINX Docker)
const IS_DEV = window.location.hostname === 'localhost';
const API_BASE = IS_DEV ? 'http://localhost:3001/api' : '/api';
const SOCKET_URL = IS_DEV ? 'http://localhost:3001' : '/';

function App() {
  const [user, setUser] = useState(null); // { id, username, role }
  const [isOnline, setIsOnline] = useState(false);
  const [monitor, setMonitor] = useState(null);

  // Admin State
  const [adminData, setAdminData] = useState({});
  const [historyData, setHistoryData] = useState([]);
  const [activeTab, setActiveTab] = useState('realtime'); // 'realtime' | 'history' | 'credentials'
  const [socket, setSocket] = useState(null);
  const [usersData, setUsersData] = useState([]);

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
      const data = await res.json();
      if (data.success) {
        setUser(data.user);
      } else {
        alert(data.error || 'Erro ao fazer login');
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
  };

  // --- DUTY TOGGLE ---
  const startDuty = () => {
    // 1. Criar Monitor
    const m = new TabMonitor({
      userId: user.id
    });

    // 2. Ativar Proteção de Áudio (Hack)
    m.enableKeepAlive();

    // 3. Iniciar Rastreamento
    m.start();

    setMonitor(m);
    setIsOnline(true);
  };

  const stopDuty = () => {
    if (monitor) {
      monitor.stop();
      // Enviar evento final manual
      monitor._sendBeacon({ type: 'shutdown', state: 'USER_STOPPED_TRACKING' });
    }
    setMonitor(null);
    setIsOnline(false);
  };

  // --- ADMIN SOCKET ---
  useEffect(() => {
    if (user?.role === 'admin') {
      console.log("👑 Iniciando conexão Admin...");
      const s = io(SOCKET_URL);

      s.on('connect', () => {
        console.log("✅ Socket Conectado! ID:", s.id);
        s.emit('join_admin');
      });

      s.on('full_snapshot', (data) => {
        console.log("📥 Recebido Snapshot Completo:", data);
        setAdminData(data);
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
                    ? "O monitoramento está ativo. O sistema de áudio está prevenindo a suspensão da aba."
                    : "Inicie o plantão para habilitar as ferramentas de produtividade."}
                </p>
              </div>
              <div className={`status-dot ${isOnline ? 'online' : 'offline'}`} style={{ width: 20, height: 20 }}></div>
            </div>

            <div className="card-grid">
              <div className="card">
                <h3><IconZap /> Ações Rápidas</h3>
                <p>Controle o estado da sua sessão.</p>

                {!isOnline ? (
                  <button className="btn btn-primary btn-full" onClick={startDuty}>
                    INICIAR PLANTÃO
                  </button>
                ) : (
                  <button className="btn btn-secondary btn-full" onClick={stopDuty}>
                    ENCERRAR PLANTÃO
                  </button>
                )}
              </div>

              <div className="card">
                <h3><IconShield /> Diagnóstico</h3>
                <p>Status da Conexão: <strong>Conectado</strong></p>
                <p>Keep-Alive de Áudio: <strong>{isOnline ? 'Ativo' : 'Desligado'}</strong></p>
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
            </div>

            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Colaborador</th>
                    <th>Status</th>
                    <th>Última Atividade</th>
                    <th>IP</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(adminData).map(([uid, tabs]) => (
                    Object.entries(tabs).map(([tid, info]) => (
                      <tr key={tid}>
                        <td style={{ fontWeight: 'bold' }}>{info.username || uid}</td>
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
                        {log.User ? log.User.username : log.userId.substring(0, 8)}
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
