FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci && npx tsc -p tsconfig.json

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# TS-BRG-051: 8788, not 8787 - the desktop app's own local API owns 8787.
ENV TEAMSPACE_BRIDGE_PORT=8788
# TS-BRG-048 / TS-SHOP-001: published -p ports only reach a non-loopback bind.
ENV TEAMSPACE_BRIDGE_HOST=0.0.0.0
ENV TEAMSPACE_DATA_DIR=/data
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# TS-BRG-032: non-root user + private data dir perms.
RUN addgroup -S bridge && adduser -S -G bridge bridge \
  && mkdir -p /data \
  && chown -R bridge:bridge /app /data \
  && chmod 700 /data
USER bridge
VOLUME ["/data"]
EXPOSE 8788
# G15 / BRG-071 follow-up: TS-BRG-022 claimed this landed but the Dockerfile
# never had one - orchestrators (Swarm, `docker compose ps`, plain `docker
# inspect`) had no way to tell a wedged-but-listening process from a healthy
# one. /health is unauthenticated and excluded from the mutator rate bucket
# (server.ts), so this cannot itself become a load source. Uses node, not
# wget/curl, so no extra packages/attack surface land in the final image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.TEAMSPACE_BRIDGE_PORT||8788,path:'/health',timeout:3000},(r)=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"
CMD ["node", "dist/server.js"]
