# Sistema de Monitoramento Online/Offline

Sistema de telemetria e monitoramento de atendentes em tempo real com autenticação segura e gestão de credenciais.

## 🚀 Funcionalidades

- **Monitoramento em Tempo Real**: Acompanhe o status de todos os atendentes (online, offline, ativo)
- **Autenticação Segura**: Sistema de login com senhas criptografadas (scrypt + salt)
- **Gestão de Credenciais**: CRUD completo para criar e gerenciar usuários
- **Histórico Detalhado**: Logs permanentes de todas as atividades
- **API Documentada**: Swagger UI em português para consulta de status
- **Dashboard Responsivo**: Interface moderna com Socket.IO para atualizações em tempo real

## 📋 Pré-requisitos

- Node.js v16+ 
- npm ou yarn

## 🔧 Instalação

### Backend (Servidor)

```bash
cd server
npm install
node index.js
```

### Docker (Produção)

Para subir o ambiente completo com auto-restart e persistência de dados:

```bash
docker-compose up -d --build
```

- Frontend: `http://localhost` (Porta 80)
- Backend: `http://localhost:3001`
- Swagger: `http://localhost:3001/api-docs?token=public`

O Docker Compose está configurado com `restart: always`, garantindo que se o sistema cair ou o servidor reiniciar, os containers subirão automaticamente.

## 🔐 Credenciais Padrão

**Administrador:**
- Usuário: `admin`
- Senha: `SuperAdminStrongPassword2026!`

## 📚 Documentação da API

Acesse a documentação Swagger em:
```
http://localhost:3001/api-docs?token=public
```

### Endpoints Principais

- `GET /api/admin/users` - Lista todos os atendentes e seus status
- `GET /api/users/:userId/status` - Consulta status de um atendente específico
- `POST /api/auth/login` - Autenticação de usuários
- `GET /api/admin/credentials` - Lista usuários cadastrados (admin)
- `POST /api/admin/credentials` - Cria novo usuário (admin)
- `DELETE /api/admin/credentials/:id` - Remove usuário (admin)

## 🏗️ Estrutura do Projeto

```
browser_telemetry/
├── client/              # Frontend React + Vite
│   ├── src/
│   │   ├── App.jsx     # Componente principal
│   │   ├── App.css     # Estilos
│   │   └── TabMonitor.js  # Monitoramento de abas
│   └── package.json
├── server/              # Backend Node.js + Express
│   ├── index.js        # Servidor principal
│   ├── swagger.json    # Documentação OpenAPI
│   └── package.json
└── README.md
```

## 💾 Banco de Dados

O sistema utiliza SQLite com Sequelize ORM. As tabelas principais são:

- **Users**: Credenciais e informações dos usuários
- **Sessions**: Sessões ativas dos atendentes
- **TelemetryLog**: Histórico permanente de eventos

## 🎯 Como Usar

1. **Login como Admin**: Use as credenciais padrão
2. **Criar Atendentes**: Na aba "Gestão de Credenciais" (ícone de cadeado)
3. **Monitorar**: Veja em tempo real quem está online na aba "Monitoramento Real"
4. **Histórico**: Consulte logs detalhados na aba "Histórico"

## 🔒 Segurança

- Senhas com hash scrypt (64 bytes) + salt aleatório (16 bytes)
- Proteção contra remoção do super-admin
- Sessões expiram após 30s de inatividade
- CORS configurado
- Soft delete para auditoria

## 🛠️ Tecnologias

**Backend:**
- Express.js
- Socket.IO
- Sequelize (SQLite)
- Swagger UI Express

**Frontend:**
- React 19
- Vite
- Socket.IO Client

## 📝 Licença

ISC

## 👥 Autores

Implementação TECHFALA
