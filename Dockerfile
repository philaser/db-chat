FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    DBCHAT_WEB_AUTH_MODE=app \
    DBCHAT_STORAGE_MODE=supabase \
    DBCHAT_WEB_HOST=0.0.0.0 \
    DBCHAT_WEB_DATA_DIR=/data \
    PORT=8787

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist-web ./dist-web
COPY --from=build /app/dist-web-server ./dist-web-server
RUN mkdir -p /data && chown -R node:node /app /data

USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/v1/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npm", "start"]
