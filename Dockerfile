# Etapa 1: Build do Frontend (React/Vite)
FROM node:18-alpine AS frontend-builder
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ .
RUN npm run build

# Etapa 2: Build do Backend e Consolidação
FROM node:18-alpine
WORKDIR /app

# Copia dependências e código do backend
COPY server/package*.json ./
RUN npm ci --only=production
COPY server/ .

# Copia o build final do frontend para a pasta 'public' do backend
COPY --from=frontend-builder /app/client/dist ./public

# Expõe a porta que o Node roda
EXPOSE 8090

# Inicia o servidor Node
CMD ["node", "index.js"]
