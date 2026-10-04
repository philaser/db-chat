FROM node:22-bookworm-slim AS build

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY scripts/prepare-sqlite.mjs ./scripts/prepare-sqlite.mjs
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
COPY . .
RUN npm run build
RUN npm prune --omit=dev --ignore-scripts && npm cache clean --force

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    DBCHAT_WEB_AUTH_MODE=app \
    DBCHAT_STORAGE_MODE=supabase \
    DBCHAT_WEB_HOST=0.0.0.0 \
    DBCHAT_WEB_DATA_DIR=/data \
    PORT=8787

WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist-web ./dist-web
COPY --from=build /app/dist-web-server ./dist-web-server
RUN mkdir -p /data && chown -R node:node /app /data

USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT || '8787')+'/api/v1/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist-web-server/server/server.js"]
