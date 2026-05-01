# ---- Build Stage ----
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- Production Stage ----
FROM node:20-alpine AS production
WORKDIR /app

# Install only production deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built output
COPY --from=builder /app/dist ./dist
# VERSION is read at runtime by the server to expose /api/version.
COPY --from=builder /app/VERSION ./VERSION

# Data directory for SQLite
RUN mkdir -p /data

EXPOSE 5000

ENV NODE_ENV=production
ENV DATA_DIR=/data

CMD ["node", "dist/index.cjs"]
