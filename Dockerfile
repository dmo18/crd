# Card Vault container image, built by Coolify from this repository.
# Base image pinned by exact tag. Update the four FROM lines together.
#
# npm runs with --ignore-scripts: better-sqlite3 and sharp ship ready-made
# binaries for linux-x64 and linux-arm64, but without that flag npm tries to
# compile better-sqlite3, which needs compilers this slim image does not have.
# The only other install script is esbuild (build tool only). The runtime
# check below proves both native modules load.
#
# The free text reader is a Python worker (ocr/worker.py, RapidOCR on
# onnxruntime) that the app starts inside this same container. Its packages
# are exact versions checked by sha256 (ocr/requirements.txt), installed as
# ready-made wheels only (no compilers), and its three model files are
# fetched here and checked by sha256 (ocr/models.txt). Nothing is downloaded
# at run time.

# 1. Build: all dependencies, then the production build.
FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
# public/ is empty and not in git, so make sure it exists for the copy below.
RUN mkdir -p public && npm run build && rm -rf .next/cache

# 2. Production dependencies only (native better-sqlite3 and sharp included).
FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Then drop builds for other C libraries (this image uses glibc) and the
# SQLite sources (ready-made binaries are used), about 130 MB.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force \
 && rm -rf node_modules/@next/swc-*-musl node_modules/@img/*-linuxmusl-* node_modules/@img/sharp-wasm32 \
      node_modules/better-sqlite3/deps node_modules/better-sqlite3/src

# 3. Text reader: a Python venv with the pinned packages, and the models.
FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS ocr
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY ocr/requirements.txt ocr/models.txt ocr/fetch_models.py /build/ocr/
RUN python3 -m venv /opt/ocr/venv \
 && /opt/ocr/venv/bin/pip install --no-cache-dir --disable-pip-version-check --no-input \
      --require-hashes --only-binary=:all: -r /build/ocr/requirements.txt \
 && /opt/ocr/venv/bin/pip check \
 && /opt/ocr/venv/bin/pip uninstall -y --disable-pip-version-check setuptools pip \
 && python3 -I /build/ocr/fetch_models.py /opt/ocr/models

# 4. Runtime: no compilers, no dev tools, runs as uid 1001.
FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=512 \
    NEXT_TELEMETRY_DISABLED=1 \
    DATA_DIR=/data \
    OCR_PYTHON=/opt/ocr/venv/bin/python \
    OCR_WORKER=/app/ocr/worker.py \
    OCR_MODELS_DIR=/opt/ocr/models
# Python for the text reader (interpreter and standard library only).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 \
 && rm -rf /var/lib/apt/lists/*
RUN groupadd --gid 1001 cardvault \
 && useradd --uid 1001 --gid 1001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin cardvault \
 && mkdir -p /data/backups \
 && chown -R 1001:1001 /data \
 && chmod 700 /data
# App files belong to root, so the app cannot change its own code.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY package.json package-lock.json next.config.ts ./
COPY drizzle ./drizzle
COPY scripts ./scripts
COPY --from=ocr /opt/ocr /opt/ocr
COPY ocr/worker.py ocr/models.txt ocr/README.txt ./ocr/
# Next.js may write its own cache here at run time. Then fail the build early
# if a native module does not load on this platform.
RUN mkdir -p .next/cache && chown 1001:1001 .next/cache \
 && node -e "new (require('better-sqlite3'))(':memory:').prepare('select 1').get(); require('sharp')"
USER 1001:1001
# Fail the build if the text reader cannot read a small drawn picture, as the
# app's own user: models present and matching their sha256, packages load.
RUN CRD_OCR_MODELS_DIR=/opt/ocr/models /opt/ocr/venv/bin/python -I -B /app/ocr/worker.py --self-test
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3000", "-H", "0.0.0.0"]
