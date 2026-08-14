FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm install && npx tsc -p tsconfig.json

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
CMD ["node", "dist/server.js"]
