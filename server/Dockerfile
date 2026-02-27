# Backend Dockerfile
FROM node:18-alpine

# Nenhuma dependência nativa a mais necessária para o Directus SDK

# Criar diretório de trabalho
WORKDIR /app

# Copiar package.json e instalar dependências
COPY package*.json ./
RUN npm ci --only=production

# Copiar código fonte
COPY . .



# Expor porta
EXPOSE 8090

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8090/api/admin/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Comando de inicialização
CMD ["node", "index.js"]
