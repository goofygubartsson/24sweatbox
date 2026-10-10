# ATC24Academy Sweatbox: one container serving the API, the WebSocket and the web app.
#   docker build -t sweatbox .
#   docker run -p 3000:3000 --env-file .env -v sweatbox-var:/app/var sweatbox
# Put Caddy (or another TLS proxy) in front of it for https://sb.atc24academy.com.

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
# better-sqlite3 falls back to compiling when no prebuilt binary matches
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/* \
  && corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config/package.json packages/config/
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
# keep only what the server needs at runtime
RUN pnpm install --prod --frozen-lockfile

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production SERVE_WEB=1 BIND_HOST=0.0.0.0
COPY --from=build /app /app
RUN mkdir -p /app/var && chown -R node:node /app/var
USER node
EXPOSE 3000
VOLUME ["/app/var"]
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "apps/server/dist/index.js"]
