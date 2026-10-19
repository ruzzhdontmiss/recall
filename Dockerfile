# Recall — minimal production image.
#
#   docker build -t recall:0.1.0 .
#   docker run --rm -p 127.0.0.1:6767:6767 \
#     -e AUTH_MODE=required \
#     -v recall-data:/app/data \
#     -v recall-cache:/app/.cache/transformers \
#     recall:0.1.0
#
# Design notes:
#  * Node 22 (the package "engines" floor is >=22) on Debian slim, built in two
#    stages so the compiler toolchain used for native modules never ships.
#  * Runs as the unprivileged `node` user (uid 1000).
#  * Only runtime files are copied — no tests, no data, no .git, no secrets.
#  * State (database + uploads) and the model cache live on volumes.
#  * Secrets are supplied at run time (env/secret manager), never baked in.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
# Toolchain for any native module without a matching prebuild. better-sqlite3,
# onnxruntime-node and sharp normally download prebuilt binaries, so this is a
# fallback rather than the common path.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json .npmrc ./
# Reproducible, lockfile-exact install of production dependencies only.
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=6767 \
    DATA_DIR=/app/data \
    UPLOAD_DIR=/app/data/uploads \
    EMBEDDINGS_CACHE_DIR=/app/.cache/transformers
WORKDIR /app
# libgomp1   — OpenMP runtime linked by onnxruntime-node
# ca-certificates — outbound TLS (first-run model download)
# tini       — forward signals to Node and reap zombies as PID 1
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts
# Persistent, writable state owned by the unprivileged user.
RUN mkdir -p /app/data /app/.cache/transformers \
 && chown -R node:node /app
USER node
EXPOSE 6767
# Readiness-aware probe; /readyz returns 503 while draining or unusable.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "scripts/healthcheck.js"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
