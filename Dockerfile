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
ENV TEAMSPACE_AUTHORITY_DIR=/authority
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY --chmod=755 docker-entrypoint.sh /app/docker-entrypoint.sh
# DOCKH-CMP-001 / DOCKHEAL-W58: loopback /health must use the same scheme this
# process listens on. In-process TLS (both TEAMSPACE_TLS_CERT_FILE and
# KEY_FILE) is HTTPS-only, so a hard-coded http.get marks a working wss
# container unhealthy. Exec-form HEALTHCHECK plus a .cjs probe (package.json
# is type:module) so /bin/sh cannot expand $ and require() stays CJS.
# Written before USER so a failed write fails the build, then chown'd with /app.
RUN cat > /app/healthcheck.cjs << 'ENDHEALTH'
'use strict';
const fs = require('fs');
const http = require('http');
const https = require('https');

const HEALTH_PLAIN = 'AItomation Team Space bridge';
const BODY_MAX = 4096;
const REQ_TIMEOUT_MS = 4000;
const PORT_FALLBACK = 8788;
const PATH_MAX = 4096;
const PORT_RAW_MAX = 16;
const HOST_RAW_MAX = 256;

function stripEnv(s) {
  let t = String(s == null ? '' : s);
  const nul = t.indexOf('\0');
  if (nul >= 0) t = t.slice(0, nul);
  return t.replace(/[\r\n]/g, '').trim();
}

function parseListenPort(raw) {
  const s = stripEnv(raw);
  if (s.length > PORT_RAW_MAX) return null;
  const n = Number(s || String(PORT_FALLBACK));
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

function tlsListenState(certRaw, keyRaw, existsFn) {
  const cert = stripEnv(certRaw);
  const key = stripEnv(keyRaw);
  if (!cert && !key) return { tls: false };
  if (!cert || !key) return { refuse: true };
  if (cert.length > PATH_MAX || key.length > PATH_MAX) return { refuse: true };
  if (typeof existsFn !== 'function') return { refuse: true };
  try {
    if (!existsFn(cert) || !existsFn(key)) return { refuse: true };
  } catch (e) {
    return { refuse: true };
  }
  return { tls: true };
}

function probeHost(raw) {
  const h = stripEnv(raw);
  if (h.length > HOST_RAW_MAX) return null;
  if (!h || h === '0.0.0.0' || h === '127.0.0.1' || h === 'localhost') return '127.0.0.1';
  if (h === '::' || h === '::1') return '::1';
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(h)) {
    const parts = h.split('.').map(function (p) { return Number(p); });
    if (parts.every(function (n) { return Number.isInteger(n) && n >= 0 && n <= 255; })) return h;
  }
  return null;
}

function healthyPlainBody(buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf == null ? '' : buf);
  return text.indexOf(HEALTH_PLAIN) === 0;
}

function runProbe() {
  try {
    runProbeInner();
  } catch (e) {
    process.exit(1);
  }
}

function runProbeInner() {
  const port = parseListenPort(process.env.TEAMSPACE_BRIDGE_PORT);
  if (port == null) process.exit(1);
  const tlsState = tlsListenState(
    process.env.TEAMSPACE_TLS_CERT_FILE,
    process.env.TEAMSPACE_TLS_KEY_FILE,
    function (p) {
      try { return fs.existsSync(p); } catch (e) { return false; }
    },
  );
  if (tlsState.refuse) process.exit(1);
  const host = probeHost(process.env.TEAMSPACE_BRIDGE_HOST);
  if (!host) process.exit(1);
  const tls = tlsState.tls === true;
  const opts = {
    host: host,
    port: port,
    path: '/health',
    method: 'GET',
    timeout: REQ_TIMEOUT_MS,
    headers: { Accept: 'text/plain' },
  };
  if (host.indexOf(':') !== -1) opts.family = 6;
  if (tls) opts.rejectUnauthorized = false;
  const req = (tls ? https : http).request(opts, function (res) {
    if (res.statusCode !== 200) {
      res.resume();
      process.exit(1);
    }
    const chunks = [];
    let n = 0;
    res.on('data', function (c) {
      n += c.length;
      if (n > BODY_MAX) {
        try { res.destroy(); } catch (e) {}
        process.exit(1);
      }
      chunks.push(c);
    });
    res.on('end', function () {
      process.exit(healthyPlainBody(Buffer.concat(chunks)) ? 0 : 1);
    });
    res.on('error', function () { process.exit(1); });
  });
  req.on('timeout', function () {
    try { req.destroy(); } catch (e) {}
    process.exit(1);
  });
  req.on('error', function () {
    try { req.destroy(); } catch (e) {}
    process.exit(1);
  });
  req.end();
}

module.exports = {
  stripEnv: stripEnv,
  parseListenPort: parseListenPort,
  tlsListenState: tlsListenState,
  probeHost: probeHost,
  healthyPlainBody: healthyPlainBody,
  HEALTH_PLAIN: HEALTH_PLAIN,
  BODY_MAX: BODY_MAX,
  PORT_FALLBACK: PORT_FALLBACK,
  REQ_TIMEOUT_MS: REQ_TIMEOUT_MS,
  PATH_MAX: PATH_MAX,
  PORT_RAW_MAX: PORT_RAW_MAX,
  HOST_RAW_MAX: HOST_RAW_MAX,
};

if (require.main === module) runProbe();
ENDHEALTH
# TS-BRG-032: non-root user + private data dir perms.
RUN addgroup -S bridge && adduser -S -G bridge bridge \
  && mkdir -p /data /authority \
  && chown -R bridge:bridge /app /data /authority \
  && chmod 700 /data /authority \
  && test -s /app/healthcheck.cjs
USER bridge
VOLUME ["/data", "/authority"]
EXPOSE 8788
# G15 / BRG-071 follow-up: TS-BRG-022 claimed this landed but the Dockerfile
# never had one - orchestrators (Swarm, `docker compose ps`, plain `docker
# inspect`) had no way to tell a wedged-but-listening process from a healthy
# one. /health is unauthenticated and excluded from the mutator rate bucket
# (server.ts), so this cannot itself become a load source. Uses node, not
# wget/curl, so no extra packages/attack surface land in the final image.
# Exec form (no shell). TLS uses https + rejectUnauthorized:false on loopback.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "/app/healthcheck.cjs"]
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
