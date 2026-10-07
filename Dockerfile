# ── Stage 1: Compilar el frontend Vue ────────────────────────────────────────
FROM node:22-alpine AS web-builder
WORKDIR /build/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
# Con comprobación de tipos (vue-tsc): un error de tipos no llega a producción
RUN npm run build

# ── Stage 2: Imagen de producción ────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /crm/server

# su-exec: el entrypoint lo usa para soltar los privilegios de root
RUN apk add --no-cache su-exec

# Solo dependencias de producción del servidor
COPY server/package*.json ./
RUN npm ci --omit=dev

# Código fuente del servidor (src/ + migrations/ + tsconfig.json). Node ejecuta el TypeScript
# directamente, igual que en desarrollo (`node src/index.ts`).
COPY server/ ./
RUN chmod +x docker-entrypoint.sh

# Frontend compilado en la ruta que espera index.ts (../../web/dist)
COPY --from=web-builder /build/web/dist /crm/web/dist

# Producción: el servidor exige SECRETS_KEY (cifrado de credenciales de terceros en la BD)
ENV NODE_ENV=production

EXPOSE 3100

# Ejecutar migraciones y luego arrancar, como usuario `node` (ver docker-entrypoint.sh)
ENTRYPOINT ["./docker-entrypoint.sh"]
