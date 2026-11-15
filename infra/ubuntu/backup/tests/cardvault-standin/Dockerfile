# Test stand-in for the Card Vault container: same paths, user and backup
# script as the real image, with a tiny app that writes to SQLite all the time.
FROM node:22.23.5-bookworm-slim
WORKDIR /app
ENV DATA_DIR=/data NODE_NO_WARNINGS=1
RUN mkdir -p /data/backups && chown -R 1000:1000 /data && chmod 700 /data
COPY scripts ./scripts
COPY app.mjs ./
USER 1000:1000
CMD ["node", "app.mjs"]
