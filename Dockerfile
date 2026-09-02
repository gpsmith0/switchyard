# ─── Build stage ──────────────────────────────────────────────────────────────
FROM oven/bun:1 AS builder

WORKDIR /app

# Install dependencies first (layer cache)
COPY web/package.json web/bun.lock* ./web/
RUN cd web && bun install --frozen-lockfile

# Copy source and build
COPY web/ ./web/
RUN cd web && bun run build

# ─── Production stage ─────────────────────────────────────────────────────────
FROM oven/bun:1-slim

# Create non-root user
RUN groupadd -r switchyard && useradd -r -g switchyard -m -d /home/switchyard switchyard

WORKDIR /app

# Install production dependencies only
COPY web/package.json web/bun.lock* ./web/
RUN cd web && bun install --frozen-lockfile --production

# Copy server source (Bun runs TypeScript directly, no transpile needed)
COPY web/server/ ./web/server/
COPY web/bin/ ./web/bin/

# Copy built frontend from builder stage
COPY --from=builder /app/web/dist ./web/dist

# Create data directories
RUN mkdir -p /home/switchyard/.companion /tmp/vibe-sessions && \
    chown -R switchyard:switchyard /home/switchyard /tmp/vibe-sessions /app

USER switchyard

# Default environment
ENV NODE_ENV=production
ENV PORT=4567

EXPOSE 4567

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:4567/api/sessions || exit 1

CMD ["bun", "web/server/index.ts"]
