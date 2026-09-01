# Team Space bridge (self-hosted)

Run this package on a machine your team can reach. The desktop app connects with the bridge address from Settings - Team Space (Pro).

## Where data lives (hard rule)

Team Space CRM sync is **never** stored in Directus, Postgres on v-aid.ai, or any v-aid cloud database.

| What | Where it lives |
|---|---|
| Shared Modules rows, op log, blobs, members, invite tokens, sessions | **This bridge** (`TEAMSPACE_DATA_DIR`, default `./data`) |
| Public share registry, scrubbed payloads, Form intake queue | **This bridge** (`public-shares.json`, `public-share-payloads/`, `public-share-submissions/`) |
| Local Modules copies, outbox, Sync Issues, keychain session | **Each teammate's computer** (project SQLite + OS keychain) |
| Public share mint metadata (token hash, ACL snapshot, revoke) | **Host project SQLite** (`modules_public_shares`) - guest content still on this bridge |
| Pro entitlement check only | v-aid.ai account /me (subscription) - no CRM or public-share payload |
| Invite **landing page** HTML + UI string translations | Stateless `https://v-aid.ai/team-invite` (opens the app; does not store tokens or Modules) |
| Temporary chat (never-persisted 1:1 and group DMs) | **Nowhere.** In-memory on this bridge process only, gone on room close, member disconnect, or process restart - see [Temporary chat](#temporary-chat-never-persisted) |

If someone leaves the team, their local Modules copies remain on their disk until they delete them. Knowledge, Accounts, Agents, and Tasks never sync through the bridge.

**Public share:** Guest links are `https://<this-bridge-origin>/share/<token>` (same host as Team Space). Mint and revoke from the Pro desktop app when connected. Form submissions queue here until the host app drains them into local SQLite. Do **not** put public share rows or Form bodies in Directus.

### Sudden power loss

If the computer that runs the team server loses power suddenly, the last few changes the app already accepted may not be on disk yet. A normal restart or a crashed process does not do this. Team chat lives only on that server, so those last messages can be gone. Shared Module rows still sit on each computer and can sync again. Keep a recent team-server backup, or run the server on a machine that does not lose power without warning.

The server does not wait for the disk after each save, so a busy team stays fast.

## Quick start (Docker - preferred)

Pull the official image first. Do not `cd packages/bridge` and do not create
that folder inside a desktop project. It is not a customer install path and
it is not a working server.

A desktop app update does not update this server. A `v*` desktop tag does not
publish GHCR and does not sync the public team-server repo (BRG-056). After
each team-server release, pull the image again yourself.

Every flag below is load-bearing - the named volume most of all. Without
`-v name:/data` Docker gives you an anonymous volume that a later `docker rm`
silently orphans:

```bash
docker pull ghcr.io/stanislavmandrik621/aitomation-teamspace-bridge:latest
docker run -d --restart unless-stopped -p 8788:8788 \
  -e TEAMSPACE_BRIDGE_HOST=0.0.0.0 \
  -e TEAMSPACE_BRIDGE_PORT=8788 \
  -e TEAMSPACE_AT_REST_KEY=<64-hex-or-passphrase> \
  -e TEAMSPACE_DATA_DIR=/data \
  -v teamspace-data:/data \
  ghcr.io/stanislavmandrik621/aitomation-teamspace-bridge:latest
```

Then connect from the AItomation desktop app: Settings - Team Space - paste `ws://127.0.0.1:8788` (or your `wss://` address).

The first lines of the log tell you which team the server is holding. After an
upgrade or a restart you want to see the SAME team id you saw before:

```
[bridge] data dir: /data (configured)
[bridge] team: team_7a498b62... "Team Space" (created 2026-01-14T09:12:03.221Z, loaded from /data)
```

A `created a NEW team` line, or `no team yet`, on a server that already had one
means the process is not reading the folder you think it is - stop and fix the
volume before anyone connects, because a new team id shows up in your
teammates' rosters as a second, empty team at the same address.

Never run `docker compose down -v`. The `-v` deletes the volume, which is the
only copy of the team.

### Compose (optional)

The compose file that ships with the **public** team-server repo names the
data volume for you. Clone that repo (never a `packages/bridge` folder in a
project), set `TEAMSPACE_AT_REST_KEY` in a `.env` file beside
`docker-compose.yml`, then:

```bash
git clone https://github.com/stanislavmandrik621/aitomation-teamspace-bridge.git
cd aitomation-teamspace-bridge
docker compose up -d
docker compose logs -f
```

That compose file pulls the same official GHCR image. Upgrade with
`docker compose pull && docker compose up -d`. A desktop app update still
does not do this (BRG-056).

## Quick start (clone + pnpm)

```bash
git clone https://github.com/stanislavmandrik621/aitomation-teamspace-bridge.git
cd aitomation-teamspace-bridge
pnpm install
pnpm start
```

Default listen: `ws://127.0.0.1:8788` (port via `TEAMSPACE_BRIDGE_PORT`; host via `TEAMSPACE_BRIDGE_HOST`, default loopback only).

> Why 8788 and not 8787: the AItomation desktop app runs its own local API on 127.0.0.1:8787. Running this server on 8787 on the same computer means whichever one starts second cannot open the port, and pointing the app at `ws://127.0.0.1:8787` makes it dial itself instead of your team server. Keep 8788, or set `TEAMSPACE_BRIDGE_PORT` to any other free port and use the same port in the app.

Data directory: `./data` (override with `TEAMSPACE_DATA_DIR`).

> Never create or `cd` into `packages/bridge` inside a desktop project folder. That path is not a customer install. Prefer the official GHCR image above, or this public repo checkout.

> `pnpm clean` runs `rm -rf dist data` - it deletes the default data folder along with the build output. Keep your real data folder **outside** the checkout (`TEAMSPACE_DATA_DIR=/var/lib/teamspace-bridge`) and this can never take your team with it.

## Running on a VPS (systemd, pm2, reverse proxy)

Everything below assumes Node 20 or newer and a checkout at `/srv/teamspace-bridge`.

### Set the data folder explicitly. Always.

`TEAMSPACE_DATA_DIR` has a default (`./data`, relative to the folder the process happens to be started in), and on a server that default is a trap:

- a service started without a working folder set runs in `/`, so the data folder becomes `/data`;
- deploy schemes that unpack each release into a new timestamped folder and flip a `current` symlink give a **different** folder on every upgrade.

Either way the server starts on an empty folder, creates a **brand-new empty team**, and leaves the real one behind untouched. The first symptom is a duplicate team appearing in someone's app hours later. Boot tells you when this happened:

```
[bridge] data dir: /srv/teamspace-bridge/data (DEFAULTED from the current folder)
[bridge] the data folder was not configured, so it was guessed from the folder this process happens to be running in. ...
```

A healthy start names the folder and the team it found there:

```
[bridge] data dir: /var/lib/teamspace-bridge (configured)
[bridge] team: team_7a498b62f5f8edc30913d557 "Team Space" (created 2026-01-14T09:12:03.418Z, loaded from /var/lib/teamspace-bridge)
```

If you see `no team yet` or `created a NEW team` on a server that should already have one, stop it before anyone connects - it is not reading the folder you think it is.

### Build and run

```bash
sudo useradd --system --home /var/lib/teamspace-bridge --create-home teamspace
sudo chown -R teamspace:teamspace /var/lib/teamspace-bridge
sudo chmod 700 /var/lib/teamspace-bridge

sudo git clone https://github.com/stanislavmandrik621/aitomation-teamspace-bridge.git /srv/teamspace-bridge
cd /srv/teamspace-bridge
sudo pnpm install          # dev dependencies included - the build needs them
sudo pnpm build            # compiles to dist/
```

`pnpm start` runs the server straight from source and is meant for development. For a service, run the build output with plain Node - no build tooling in the runtime path:

```bash
node /srv/teamspace-bridge/dist/server.js
```

### Secrets file

Keep keys out of the unit file and out of your shell history:

```bash
sudo install -o root -g teamspace -m 640 /dev/null /etc/teamspace-bridge.env
sudo tee /etc/teamspace-bridge.env >/dev/null <<'EOF'
TEAMSPACE_AT_REST_KEY=<64-hex-or-passphrase>
TEAMSPACE_ADMIN_RECOVERY_KEY=<at-least-24-characters>
# Native TLS instead of a reverse proxy - leave unset if a proxy terminates TLS:
# TEAMSPACE_TLS_CERT_FILE=/etc/letsencrypt/live/team.example.com/fullchain.pem
# TEAMSPACE_TLS_KEY_FILE=/etc/letsencrypt/live/team.example.com/privkey.pem
EOF
```

`TEAMSPACE_ADMIN_RECOVERY_KEY` is optional - leave it out and the server generates one for you (see [Admin recovery](#admin-recovery-locked-out-of-your-own-server)).

### systemd unit

`/etc/systemd/system/teamspace-bridge.service`:

```ini
[Unit]
Description=Team Space bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=teamspace
Group=teamspace
WorkingDirectory=/srv/teamspace-bridge
ExecStart=/usr/bin/node /srv/teamspace-bridge/dist/server.js
EnvironmentFile=/etc/teamspace-bridge.env

# Absolute path - never rely on the working directory for this one.
Environment=TEAMSPACE_DATA_DIR=/var/lib/teamspace-bridge
# Loopback only, because nginx/Caddy below is what faces the internet.
# Set 0.0.0.0 instead only if teammates connect to this machine directly.
Environment=TEAMSPACE_BRIDGE_HOST=127.0.0.1
Environment=TEAMSPACE_BRIDGE_PORT=8788
# One reverse proxy in front of us - see "Reverse proxy" below.
Environment=TEAMSPACE_TRUSTED_PROXY_HOPS=1

Restart=always
RestartSec=5

# The process needs its data folder and nothing else on the filesystem.
ReadWritePaths=/var/lib/teamspace-bridge
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now teamspace-bridge
sudo systemctl status teamspace-bridge
journalctl -u teamspace-bridge -n 40    # read the boot lines above here
```

Those hardening directives are the ones that actually apply: the server writes only to its data folder (`ReadWritePaths` plus `ProtectSystem=strict` makes the rest of the disk read-only), never needs a home directory, and never needs to gain privileges. If you use `TEAMSPACE_TLS_CERT_FILE`, the certificate directory must be readable by the service user, so add it: `ReadOnlyPaths=/etc/letsencrypt`.

### pm2 alternative

```bash
sudo -u teamspace pm2 start /srv/teamspace-bridge/dist/server.js \
  --name teamspace-bridge \
  --cwd /srv/teamspace-bridge
sudo -u teamspace pm2 save
sudo -u teamspace pm2 startup     # prints the command to run for boot persistence
```

pm2 does not read an environment file, so put the variables in an ecosystem file instead of on the command line - and set `TEAMSPACE_DATA_DIR` there too, since pm2 restarts inherit whatever directory it was started from:

```js
// /srv/teamspace-bridge/ecosystem.config.cjs
module.exports = {
  apps: [{
    name: 'teamspace-bridge',
    script: '/srv/teamspace-bridge/dist/server.js',
    cwd: '/srv/teamspace-bridge',
    env: {
      TEAMSPACE_DATA_DIR: '/var/lib/teamspace-bridge',
      TEAMSPACE_BRIDGE_HOST: '127.0.0.1',
      TEAMSPACE_BRIDGE_PORT: '8788',
      TEAMSPACE_TRUSTED_PROXY_HOPS: '1',
      TEAMSPACE_AT_REST_KEY: '<64-hex-or-passphrase>',
    },
  }],
}
```

```bash
sudo -u teamspace pm2 start /srv/teamspace-bridge/ecosystem.config.cjs
```

### Reverse proxy (`wss://`)

The proxy terminates TLS and forwards to loopback. WebSocket upgrades are accepted on any path, and the guest share pages are plain HTTP on the same host, so one `location /` block covers everything.

**Why the forwarding header matters.** Rate limits (Admin recovery attempts, sign-in code requests, guest downloads) are counted per caller address. Behind a proxy every request arrives from loopback, so without a forwarding header every caller in the world shares one bucket. With one, the server needs to know how many entries at the **end** of the chain came from your own infrastructure - that is `TEAMSPACE_TRUSTED_PROXY_HOPS`, and it is `1` for a single proxy like the ones below. Anything earlier in the chain was supplied by the caller and is ignored. Set the hop count to match your real topology: too high and honest callers get lumped together, too low and a caller could pick its own bucket and dodge the limits.

**nginx** - `/etc/nginx/sites-available/teamspace`:

```nginx
server {
  listen 443 ssl http2;
  server_name team.example.com;

  ssl_certificate     /etc/letsencrypt/live/team.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/team.example.com/privkey.pem;

  # Guest share pages can carry file uploads - keep this above your largest.
  client_max_body_size 64m;

  location / {
    proxy_pass http://127.0.0.1:8788;
    proxy_http_version 1.1;

    # WebSocket upgrade.
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    proxy_set_header Host $host;
    # Appends the address nginx actually saw to whatever the caller sent.
    # The server reads it from the right, so a caller cannot forge its way in.
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Live sync connections are long-lived - do not time them out.
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }
}
```

If you put a CDN or load balancer in front of nginx as well, that is two hops: set `TEAMSPACE_TRUSTED_PROXY_HOPS=2`.

**Caddy** - `/etc/caddy/Caddyfile`:

```caddyfile
team.example.com {
  reverse_proxy 127.0.0.1:8788 {
    # Caddy appends the observed address to X-Forwarded-For by default and
    # upgrades WebSockets without extra configuration.
    transport http {
      read_timeout 3600s
    }
  }
}
```

Caddy gets a certificate automatically. Connect the app to `wss://team.example.com`.

Check the proxy is really in front:

```bash
curl -fsS https://team.example.com/health && echo OK
```

A browser opening that URL shows a short status page. `curl` (and Check connection in the app) still get the one-line text `AItomation Team Space bridge`.

### Upgrades

The data folder is separate from the checkout, so an upgrade never touches your team:

```bash
cd /srv/teamspace-bridge
sudo git pull
sudo pnpm install
sudo pnpm build
sudo systemctl restart teamspace-bridge      # or: pm2 restart teamspace-bridge

journalctl -u teamspace-bridge -n 20
```

Confirm the restart found your team - the boot line must name the same team id as before, and the data dir must say `configured`:

```
[bridge] data dir: /var/lib/teamspace-bridge (configured)
[bridge] team: team_7a498b62f5f8edc30913d557 "Team Space" (created ...)
```

`created a NEW team` or `no team yet` after an upgrade means the new release is pointed somewhere else. Stop the service and fix `TEAMSPACE_DATA_DIR` before anyone connects.

If you run the official image instead of this checkout, upgrade with
`docker pull ghcr.io/stanislavmandrik621/aitomation-teamspace-bridge:latest`
and recreate the container (or `docker compose pull && docker compose up -d`
from a public-repo checkout). A desktop app update does not pull that image
(BRG-056).

## Team identity (name vs member display name)

Each bridge process is **one team**. Bootstrap assigns a stable opaque `teamId`.
Admin can rename the canonical **team name** (`set_team_name` / Settings >
Private team server name). That name is returned on `hello_ok` and invite redeem
as `teamName` so desktop "Your teams" can label the server.

A member's **display name** (hello `displayName`) is separate - it is only that
person's label on the server, not the team name. Desktop local nicknames on
"Your teams" never change the bridge canonical name.

One desktop **project** may bind only **one** active team at a time (roster
switch disconnects the prior session first). Joining many teams does not merge
their Modules into one project.

## Several teams on one machine

One process is one team. There is no way to host two teams inside one running
server, and that server cannot share CPU or disk fairly between two teams.
Fairness between teams is the host's job, not the application's. Extra
processor cores do not give you a second team. This server runs as one
process, so a second core on the same container sits idle.

Several teams on one machine means several containers.
You can also run several systemd or pm2 units. Each team needs its own data
folder, its own named volume, its own host port, and its own address in the
app. Copy `docker-compose.multi-team.example.yml` from the public team-server
repo next to the usual compose file when you want two teams on one host. Do
not add a second service to the default `docker-compose.yml` - that file stays
the one-team start path. Never copy those files into a desktop project
`packages/bridge` folder.

The server already refuses two processes on the same folder. It writes
`.bridge.lock` in `TEAMSPACE_DATA_DIR` before it opens any files. A second
start on that folder exits with:

```
Another Team Space server is already using this data folder (pid N). Stop it first or pick a different TEAMSPACE_DATA_DIR.
```

Do not share one named volume across two containers. If you do, the second
start fails (or, after a crash, can look like the first process is still
alive). Never run `--scale` or more than one replica against the same data
folder. Never run `docker compose down -v` - the `-v` deletes the volume,
which is the only copy of that team.

After each start, the log must name a different team id for each container,
and `loaded from` must point at that team's own folder. A `created a NEW team`
or `no team yet` line on a folder that already had a team means stop and fix
the volume before anyone connects.

### Limits per container

These numbers match the live defaults (256 MiB in-flight HTTP body budget,
200 sockets, one Node process). They are a starting point, not a promise for
every org size. If you raise `TEAMSPACE_MAX_INFLIGHT_HTTP_BODY_BYTES` or
`TEAMSPACE_MAX_WS_CONNECTIONS`, raise container memory by the same amount.
Do not set memory below 512m: the HTTP body budget alone is 256 MiB.

| Team size | CPU | Memory | Processes |
|---|---|---|---|
| Small (about 20 people) | 0.50 | 1g | 1 Node (`replicas: 1`, `pids_limit: 64`) |
| Default (up to about 100 people / 200 sockets) | 1.00 | 1g | same |
| Busy (catch-up storms, many rooms) | 1.00 (the host may reserve 2.00 so neighbors cannot steal the one core) | 2g, raise if you raise the HTTP or socket settings | same |

Disk lives on the volume, not in RAM. Chat seeds 10 GiB of history files and
20 GiB of attachments. Full-app backups can be up to 8 GiB each. Give each
team its own volume.

The one-team compose file and the example compose file both set
`cpus: 1.0`, `mem_limit: 1g`, `mem_reservation: 512m`, and `pids_limit: 64`
on each service. Host ports in the example are 8788 and 8789 (container
port stays 8788). Each team has its own `TEAMSPACE_AT_REST_KEY`. Keep 8788
for the first team. Never put a second team on 8787 - that port is the
desktop app's own local API.

### Coolify, systemd, and a reverse proxy

On Coolify, one application per team: its own persistent volume at `/data`,
its own hostname or published port, replicas = 1, CPU 1, memory 1 GB. Match
the Resources tab to the table above. Do not deploy these onto the v-aid
account host. That host is for the account site only. Team Space data never
goes there.

On systemd or pm2, run one unit per team, each with its own absolute
`TEAMSPACE_DATA_DIR`, its own port, `MemoryMax=1G`, `CPUQuota=100%`, and
`TasksMax=64`. The same `.bridge.lock` still applies.

If you put a reverse proxy in front, give each team its own hostname (or its
own host port). Do not path-prefix two teams on one origin. Guest share pages
live at `/share/<token>` on `/`, so two teams behind one hostname would
collide.

Connect each team from the app at its own `ws://` or `wss://` address. One
desktop project still binds only one active team at a time.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `TEAMSPACE_BRIDGE_PORT` | `8788` | HTTP + WS port |
| `TEAMSPACE_BRIDGE_HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` (or a LAN IPv4) only when teammates must reach this machine over the network. **Docker images set `0.0.0.0` so published `-p` ports work** |
| `TEAMSPACE_TRUSTED_PROXIES` | (unset) | Comma-separated peer IPs allowed to supply `X-Forwarded-For` (plus loopback, which is always allowed). Without this, rate limits use `socket.remoteAddress` only |
| `TEAMSPACE_TRUSTED_PROXY_HOPS` | `1` | How many entries at the **end** of a trusted `X-Forwarded-For` chain came from your own proxies. `1` for a single reverse proxy (the usual setup), `2` if a CDN or load balancer sits in front of that one. Entries earlier in the chain are supplied by the caller and ignored. Set `0` when nothing proxies this server, so the connection address is always used. Range `0`-`8` |
| `TEAMSPACE_DATA_DIR` | `./data` | Members, invites, op log, blobs, **backups/**, **chat/**, public-share registry/payloads/submissions. **Set an absolute path on a server** - the default is relative to the folder the process was started in, and boot warns when it was not set (see [Running on a VPS](#running-on-a-vps-systemd-pm2-reverse-proxy)) |
| `TEAMSPACE_SHUTDOWN_TIMEOUT_MS` | `5000` | How long a graceful shutdown (SIGTERM/SIGINT) waits for in-flight work to finish before forcing exit. Clamped to `1000`-`60000` |
| `TEAMSPACE_OP_RETENTION_DAYS` | `21` | Catch-up window before prune. Range `1`-`365` (no "keep forever" option here, unlike the chat retention settings below) |
| `TEAMSPACE_OPS_LOG_MAX_BYTES` | `512 MiB` | Hard ceiling on `ops.jsonl` so a never-acked or all-stale log cannot grow without bound. Range `64 KiB`-`8 GiB` |
| `TEAMSPACE_OPS_PENDING_APPEND_MAX` | `50000` | Max ops held in the in-memory mirror of appends still pending while a prune rewrite holds the log open. Range `100`-`500000` |
| `TEAMSPACE_OPS_PENDING_APPEND_MAX_BYTES` | `134217728` (128 MiB) | Byte ceiling for that same in-memory mirror, independent of the count cap above (large frames can hit the byte ceiling before the count ceiling). Range `1 MiB`-`2 GiB` |
| `TEAMSPACE_DEVICE_STALE_DAYS` | `90` | Days without a last-seen stamp (or an inferred ack) before a registered device stops blocking op-log prune. Floor is the 21-day catch-up window, ceiling `3650` days. The hourly prune log names the device still holding the log open |
| `TEAMSPACE_CHAT_RETENTION_DAYS` | `90` | Seed for team chat prune window (Admin can override live via Settings; stored in `chat/_meta.json`). `0` means keep forever. Range `0`-`3650` |
| `TEAMSPACE_CHAT_TOMBSTONE_DAYS` | `365` | How long a deleted/unsent chat message keeps its tombstone (so a late-arriving edit or reaction from a slow device is refused instead of reviving it) before the tombstone itself is pruned. `0` means keep tombstones forever. Range `0`-`3650` |
| `TEAMSPACE_CHAT_DISK_QUOTA_FILES` | `10 GiB` | Seed for chat history file quota (Admin override in Settings) |
| `TEAMSPACE_CHAT_DISK_QUOTA_BLOBS` | `20 GiB` | Seed for chat attachment blob quota (Admin override in Settings) |
| `TEAMSPACE_CRM_BLOBS_DISK_MAX_BYTES` | `8 GiB` | Team-wide ceiling on CRM media blob bytes on disk under `blobs/`. Separate from the chat attachment quota above. Range `64 MiB`-`512 GiB` |
| `TEAMSPACE_MAX_OPS_PER_FRAME` | `500` | Ops accepted in one WS frame (remainder stays on the device outbox). Range `50`-`5000` |
| `TEAMSPACE_WS_MAX_PAYLOAD_BYTES` | `8000000` | Incoming WS frame ceiling (bytes). Lockstep with `maxPayload` |
| `TEAMSPACE_OPS_FRAME_MAX_BYTES` | `6000000` | JSON budget for the `ops` array in one frame (headroom under the 8 MiB ceiling) |
| `TEAMSPACE_JSON_FINITE_WALK_MAX_DEPTH` | `64` | Max nesting depth allowed when validating a frame is JSON-serializable before send, so a hostile or accidentally cyclic deep nest cannot stall the server. Raise it if your CRM records legitimately nest deeper than 64 levels. Range `8`-`2048` |
| `TEAMSPACE_OPS_FRAME_TOKENS` | `120` | Frames one device may send per refill window. Range `10`-`2000` |
| `TEAMSPACE_OPS_FRAME_WINDOW_MS` | `10000` | Token-bucket refill window (ms). Range `1000`-`60000` |
| `TEAMSPACE_RECENT_OPS_LIMIT` | `5000` | Op-log tail replayed on a reconnect that already has acks. Range `100`-`50000` |
| `TEAMSPACE_FULL_OPS_CATCHUP_LIMIT` | `200000` | Progress-log interval while streaming the durable log (not a send stop). Range `5000`-`1000000` |
| `TEAMSPACE_ACK_IDS_PER_CALL` | `2000` | Ack ids stamped per `ack_ops` frame (desktop chunks at the same size). Range `100`-`20000` |
| `TEAMSPACE_ACK_OPS_TOKENS` | `60` | `ack_ops` frames one device may send per refill window (separate ceiling from the `ops` frame budget it shares the window with) |
| `TEAMSPACE_CATCHUP_REQUEST_TOKENS` | `8` | On-demand `catchup_request` actions per window - kept low because each one is a full durable-log scan |
| `TEAMSPACE_HELLO_TOKENS` | `30` | Hello attempts per IP per refill window |
| `TEAMSPACE_PRE_AUTH_WS_TOKENS` | `30` | Messages one not-yet-authenticated (pre-hello) socket may send per IP per window |
| `TEAMSPACE_PRE_AUTH_WS_MAX_FRAME_BYTES` | `64 KiB` | Max size of a WS frame before hello completes (hello payloads are small; this blocks a pre-auth socket from sending a huge frame). Range `4 KiB`-`512 KiB` |
| `TEAMSPACE_PRE_AUTH_HELLO_DEADLINE_MS` | `30000` | A socket that never sends hello within this deadline is reaped. Range `5000`-`300000` |
| `TEAMSPACE_INVITE_TOKENS` | `20` | Invite create/list/revoke actions per member key per window |
| `TEAMSPACE_ROSTER_TOKENS` | `60` | Roster/member-list reads per member key per window (separate from invite mutators) |
| `TEAMSPACE_ADMIN_MUTATE_TOKENS` | `30` | Admin kick / leave / revoke / `set_role` / `set_team_name` actions per window |
| `TEAMSPACE_ADMIN_HTTP_MUTATE_TOKENS` | `20` | Admin HTTP mutators (public-share / portal / Compose-share register, revoke) per window |
| `TEAMSPACE_PROFILE_UPDATE_TOKENS_PER_MIN` | `30` | `profile_update` (display name / avatar) fanout actions per member per minute |
| `TEAMSPACE_BLOB_TOKENS` | `60` | Blob upload/download actions per session per window |
| `TEAMSPACE_BACKUP_TOKENS` | `20` | Backup list/upload/download/delete actions per session per window |
| `TEAMSPACE_BACKUP_EXPORT_PROCESS_LEASES` | `1` | Concurrent process-wide `backups/export.zip` exports. Raising this raises peak memory/CPU during export. Range `1`-`2` |
| `TEAMSPACE_CHAT_EXPORT_PROCESS_LEASES` | `1` | Concurrent process-wide `chat_export` (Admin chat zip export) runs. Range `1`-`4` |
| `TEAMSPACE_CHAT_AVATAR_PUT_TOKENS_PER_MIN` | `20` | Chat room/member avatar uploads per member per minute |
| `TEAMSPACE_CHAT_ROOMS_LIST_TOKENS_PER_MIN` | `30` | `chat_rooms_list` calls one member may make per minute |
| `TEAMSPACE_CHAT_ROOMS_LIST_PROCESS_CONCURRENCY` | `16` | Process-wide cap on concurrent room-file scans across every socket's `chat_rooms_list` call (a per-request pool alone still multiplies to member-count x 8). Range `1`-`128` |
| `TEAMSPACE_GUEST_AUTH_FAIL_MAX` | `8` | Wrong guest password/PIN attempts allowed per share token (plus optional IP) before lockout. Range `3`-`40` |
| `TEAMSPACE_GUEST_AUTH_FAIL_WINDOW_MS` | `900000` (15 min) | Lockout window for guest password/PIN attempts. Range `60000`-`3600000` |
| `TEAMSPACE_GUEST_DOWNLOAD_TOKENS` | `20` | Concurrent guest download slots (public-share / Form payload reads) per window |
| `TEAMSPACE_HTTP_TOKENS` | `60` | HTTP redeem / misc requests per IP per window |
| `TEAMSPACE_MAX_WS_CONNECTIONS` | `200` | Hard cap on concurrent WebSocket clients. Any value you set is honored up to `20000` - it is NOT silently clamped to `500` regardless of what you set it to. Default gives headroom above a 100-person team (each member may open more than one connection across windows/devices) |
| `TEAMSPACE_MAX_INFLIGHT_HTTP_BODY_BYTES` | `268435456` (256 MiB) | Process-wide ceiling on total bytes buffered across every in-flight HTTP request body (chat/compose blob uploads, JSON bodies) at once. Bounds worst-case resident memory when many uploads land in parallel. Range `8 MiB`-`4 GiB` |
| `TEAMSPACE_MAX_INFLIGHT_HTTP_BODY_BYTES_PER_MEMBER` | `134217728` (128 MiB) | Per-member ceiling on in-flight HTTP bodies this member is charged for (profile photo, chat attach, CRM files, and Compose JSON when the route names the member). The process-wide ceiling still applies. Floor is 28000000 bytes (28 MB, about 26.7 MiB) so one large file always fits; ceiling `4 GiB`. Four 25 MiB uploads from one member stay under the default |
| `TEAMSPACE_MAX_INFLIGHT_HTTP_DOWNLOAD_BYTES` | `268435456` (256 MiB) | Process-wide ceiling on bytes loaded into memory for HTTP downloads (CRM file GET, Compose pack, guest payload reads). Range `8 MiB`-`4 GiB` |
| `TEAMSPACE_MAX_INFLIGHT_HTTP_DOWNLOAD_BYTES_PER_MEMBER` | `134217728` (128 MiB) | Per-member share of that download heap. Floor is 28000000 bytes (28 MB, about 26.7 MiB) so one Compose pack or CRM file still fits; ceiling `4 GiB`. Guest reads without a member stay on the process-wide ceiling only |
| `TEAMSPACE_CHAT_ROOMS_LIST_SCAN_CONCURRENCY` | `8` | Max room-file scans run concurrently for one `chat_rooms_list` call (rest queue behind the pool) |
| `TEAMSPACE_CHAT_ROOMS_TOTAL_MAX` | `2000` | How many lasting (not temporary) chat rooms this team may have open. Creating a new room past this number is refused. Range `2`-`20000`. The server's own room list never hides a room below this ceiling - its list cap always covers the full `20000` range no matter what you set here. The desktop app has a separate, lower "chats this computer keeps track of" setting (Settings - Team Space), capped at `2000` as of this writing - raise this env var only after that desktop-side cap is raised to match, or some members will not see every room past 2000 on their own device |
| `TEAMSPACE_RECENT_OPS_SHARED_READ_WINDOW_MS` | `2000` | How long a completed op-log catch-up scan is reused by other near-concurrent reconnects before triggering a fresh scan (reconnect-storm mitigation) |
| `TEAMSPACE_PRESENCE_JOIN_COALESCE_MS` | `300` | Window that batches multiple join/leave presence changes into one roster broadcast instead of one broadcast per change |
| `TEAMSPACE_PRESENCE_HEARTBEAT_INTERVAL_MS` | `30000` | Server-initiated WS ping/pong interval used to detect and reap "ghost" sessions (device force-quit, lost power, no clean close) |
| `TEAMSPACE_YJS_ROOM_MAX_PEERS` | `40` | Max sockets allowed to co-edit ONE live Doc/Whiteboard/Compose room at once. Range `5`-`500` |
| `TEAMSPACE_YJS_ROOMS_PER_SOCKET_MAX` | `64` | Max concurrent Doc/Whiteboard/Compose rooms ONE socket may join at once (min `8`, max `512`) - raise if members with many open boards see co-edit joins refused |
| `TEAMSPACE_YJS_JOIN_TOKENS_PER_SEC` | `10` | `yjs_join` / `yjs_leave` actions one member may send per second. Range `2`-`100` |
| `TEAMSPACE_YJS_UPDATE_TOKENS_PER_SEC` | `20` | Live-edit (`yjs_update`) frames one member may send per second before being throttled |
| `TEAMSPACE_YJS_AWARENESS_TOKENS_PER_SEC` | `30` | Cursor/presence (`yjs_awareness`) frames one member may send per second before being throttled |
| `TEAMSPACE_YJS_DOC_WHITEBOARD_ENABLED` | `false` | Server-side switch for live co-edit on Docs/Whiteboard. Off by default on both client and server - the desktop app also gates this feature client-side, so both sides must turn it on |
| `TEAMSPACE_YJS_COMPOSE_ENABLED` | `false` | Same contract as `TEAMSPACE_YJS_DOC_WHITEBOARD_ENABLED`, for Compose co-edit rooms |
| `TEAMSPACE_FANOUT_BACKPRESSURE_BYTES` | `2097152` (2 MiB) | Skip fanout to a peer whose send buffer exceeds this. Range `1`-`16777216` (16 MiB) |
| `TEAMSPACE_CHAT_SCAN_REQUIRED` | (unset) | Set to `1` to refuse every chat attachment unless a scan hook is registered. The stock build never registers one, so this fails closed for a normal Docker/GHCR/checkout deployment - see [Security](#security) |
| `TEAMSPACE_TLS_CERT_FILE` | (unset) | PEM **full chain** certificate path (leaf + intermediates - `fullchain.pem`, not `cert.pem`) - with KEY enables native `wss://` / HTTPS |
| `TEAMSPACE_TLS_KEY_FILE` | (unset) | PEM private key path, **must not be passphrase-encrypted** (required with CERT) |
| `TEAMSPACE_AT_REST_KEY` | (unset) | 64-hex key or passphrase (>=16 chars) - AES-GCM for members/invites/acks/ops/blobs/chat/public-share (backup index metadata excepted, see [Security](#security)) |
| `TEAMSPACE_ADMIN_RECOVERY_KEY` | (auto-generated) | Recovery key that lets a locked-out Admin get back in. Must be 24-512 characters - a shorter or longer value stops the server with one clear line instead of being accepted as a weak password or silently truncated. Leave unset and the server generates a strong key on first boot and saves it to `$TEAMSPACE_DATA_DIR/admin-recovery.key`. See [Admin recovery](#admin-recovery-locked-out-of-your-own-server) |
| `TEAMSPACE_ADMIN_RECOVERY_TOKENS` | `5` | Admin recovery attempts allowed per IP per window (min `1`, max `50`) |
| `TEAMSPACE_ADMIN_RECOVERY_WINDOW_MS` | `900000` (15 min) | Lockout window for those attempts. Spending the budget locks that IP out for the rest of the window |

Throughput note: desktop always saves Modules edits locally first (SQLite outbox). If the bridge is busy, locked, or briefly rate-limited, work stays pending and drains when the link is healthy again. Raise the frame/token env vars for larger catch-up windows (still one bridge process per team). This is not a hosted multi-tenant SaaS - one bridge process is one team. Very large orgs may need to split teams or raise caps carefully; do not treat the defaults as proven for every org size.

## Security

- Prefer `wss://` with a real certificate (Let's Encrypt) for any public hostname. You can terminate TLS in a reverse proxy, or set `TEAMSPACE_TLS_CERT_FILE` + `TEAMSPACE_TLS_KEY_FILE` so this process listens with HTTPS/`wss` itself.
- Loopback `ws://` is fine for a single-machine home server. LAN `ws://` works but the desktop app warns - prefer `wss://` on shared Wi-Fi.
- The desktop app **refuses** public plaintext `ws://` / `http://` (use `wss://` / `https://`).
- Sessions are per member + device. The bridge binds each session token to one `deviceId` - restoring a device-move bundle on a second computer requires redeeming again (or using that device's own token). A hello with a mismatched deviceId is refused.
- Session tokens are stored hashed (sha256) in `members.json` - a stolen data dir does not yield live bearers.
- Invite tokens are stored hashed (sha256) in `invites.json`. The plaintext is returned once at create (and briefly while this process keeps the unused invite in memory) so the admin can share the link.
- Set `TEAMSPACE_AT_REST_KEY` so members/invites/acks JSON, the op log, CRM blobs, team chat (rooms, history in `chat/rooms/*/messages.jsonl`, unread markers, avatars, chat settings), and the public-share / portal / Compose-share registries are all AES-256-GCM encrypted on disk. Without it, CRM field values in `ops.jsonl`, chat message bodies, and media blobs are plaintext files - encrypt the volume (FileVault / BitLocker / LUKS) or set the key.
- Team-server backup metadata is a separate case: `backups/members/<memberId>/index.json` and `backups/_meta.json` (snapshot id, label, size, timestamp) are **not** covered by `TEAMSPACE_AT_REST_KEY` - only the `.aimove` snapshot bytes matter for confidentiality, and those are already sealed end-to-end with the member's own backup password before upload (see [Team server backups](#team-server-backups)). A reader of the plain index only learns snapshot labels, sizes, and dates, never CRM content.
- `TEAMSPACE_TLS_CERT_FILE` must point at the **full certificate chain** (leaf plus intermediates - the file Let's Encrypt calls `fullchain.pem`, not `cert.pem`), or clients that do not already have the intermediate cached will fail to verify. `TEAMSPACE_TLS_KEY_FILE` must be an **unencrypted** private key - this process does not prompt for or accept a passphrase-protected key, so `openssl rsa -in privkey.pem -out privkey-nopass.pem` first if your key has one.
- A torn or corrupt `members.json` refuses first-admin bootstrap (quarantines the file) so an empty rewrite cannot mint a new admin over a live team. Admin recovery is refused in that state too.
- Rate limits are counted per caller address, so behind a reverse proxy the forwarding header decides who shares a bucket. Set `TEAMSPACE_TRUSTED_PROXY_HOPS` to the number of proxies you actually run (`1` for a single one, `0` for none). The server reads the chain from the end, discarding your own hops and ignoring everything a caller put in front - so a caller cannot hand itself a fresh bucket per request and slip past the limits. Getting this wrong in the safe direction (too many hops) only lumps honest callers together; getting it wrong the other way weakens every per-address limit, including Admin recovery attempts and sign-in code requests.
- The Admin recovery key is a password-equivalent secret. It is only as private as the server's environment and data directory - anyone who can read `admin-recovery.key` can already read every message and row in the same directory. Keep the data volume off shared storage, and set `TEAMSPACE_ADMIN_RECOVERY_KEY` yourself if you would rather the secret never touch disk. Attempts are capped per IP (see Environment) and every attempt is logged.
- `TEAMSPACE_CHAT_SCAN_REQUIRED=1` fails closed: the stock server ships no built-in attachment scanner, so every chat attachment upload is refused the moment this is set, with no way to allow them back short of unsetting it. It is a hook for a custom build that calls the exported `setChatAttachmentScanHook` before starting the server (see the source `chat-dangerous-type.ts`), not a flag a default Docker/GHCR deployment can turn on. Leave it unset unless you have built and are running that custom scanner integration.
- v1 supports self-signed / private PKI via Settings - Team Space:
  - **Allow untrusted certificate** (off by default) - connect even when the certificate is not from a public authority. MITM risk if used alone.
  - **Certificate fingerprint** - optional SHA-256 of the leaf certificate (64 hex). When set, Connect refuses a mismatch. Prefer pin + real CA when possible; pin alone is enough for a known self-signed server.

## Invites (no email from the bridge)

1. First desktop to connect becomes Admin and receives a session token (stored in the OS keychain).
2. Admin creates an invite (Settings - Team Space - Create invite, or `POST /v1/invite/create` with Bearer token).
3. Admin shares the **https landing link** (`https://v-aid.ai/team-invite?token=...&bridge=...`) or the app deep link manually (email, chat, etc.). The bridge does not send SMTP mail in v1.
4. To cancel an unused invite before it expires: `POST /v1/invite/cancel` (or `/v1/invite/revoke`) with Admin Bearer and `{ "id": "..." }` or `{ "token": "..." }`.
5. Teammate opens the link / pastes the code; the app redeems via `POST /v1/invite/redeem` and stores the session.

Invite tokens are short-lived (**24 hours**). Expired invites are refused at redeem. Prefer the app deep link with a `#token=` fragment when sharing inside the installed app (less likely to leak via referrer logs); the https landing page still uses query params for browsers.

Invite landing page (opens in a browser when the app is not installed yet): `https://v-aid.ai/team-invite?token=...&bridge=ws://...`

## Admin recovery (locked out of your own server)

The first computer to connect becomes Admin and keeps a session token in its OS keychain. Everyone else joins by invite, and only an Admin can create invites. So if you run the server yourself and you are the only Admin, losing that one session token used to be permanent: a keychain reset, a reinstall, a new computer, or pressing **Disconnect** left your rooms, chat history, and synced rows sitting on the volume with no way back in.

The recovery key fixes that. Anyone who can read this server's environment or its data directory is, by definition, the person who runs it - so that is the proof of ownership we accept.

### Where the key comes from

1. `TEAMSPACE_ADMIN_RECOVERY_KEY` if you set it (24-512 characters).
2. Otherwise `$TEAMSPACE_DATA_DIR/admin-recovery.key`, reused on every later boot.
3. Otherwise the server generates a strong random key on first boot and writes it to that file, owner-read/write only (`0600`). It lives in the persisted data directory, so it survives container restarts and image upgrades exactly like `members.json`.

The key file is plaintext on purpose: you have to be able to read the key back out in order to type it into the app, and a hash cannot be typed in. File permissions plus the privacy of the data volume are what protect it.

### Reading the key

Every boot prints where the key lives, plus a short fingerprint so you can confirm the running server is using the key you think it is:

```
[bridge] admin recovery key: /data/admin-recovery.key (fingerprint 1a2b3c4d). Set TEAMSPACE_ADMIN_RECOVERY_KEY to pin your own instead.
```

The key value itself is printed **once**, in the boot where it was generated:

```
[bridge] admin recovery key generated (printed once - save it now): <key>
```

Save it somewhere safe then. If you missed that line, read the file directly.

In Docker:

```bash
docker exec <container> cat /data/admin-recovery.key
```

On a server without containers, the file belongs to the account the service runs as, and only that account can read it:

```bash
sudo ls -l /var/lib/teamspace-bridge/admin-recovery.key
# -rw------- 1 teamspace teamspace 43 Jan 14 09:12 admin-recovery.key

sudo cat /var/lib/teamspace-bridge/admin-recovery.key
```

`sudo` is needed because the file is `0600` and owned by the service user - that is deliberate, and the same reason the data folder itself should be `700`. If you moved the data folder while the service was stopped, keep the ownership with it (`sudo chown -R teamspace:teamspace <new-path>`) or the server cannot read its own key on the next start.

### Using it

In the desktop app, connect to your server and supply the recovery key when asked. The server then:

- binds the computer you are on to your existing Admin account and issues it a fresh session,
- keeps every other device session on that account (your old computer still works if it turns up),
- changes nothing else - no rooms, messages, attachments, invites, synced rows, or teammate accounts are touched.

Recovery can never hand out a role you did not already have. It only ever rebinds an account that is **already** an Admin: if you present the key as a viewer or member, the session lands on the earliest-created Admin account instead, and your own row is left exactly as it was. A server with no Admin row at all refuses, and so does a server whose `members.json` is corrupt.

Wrong keys are refused and counted. The default budget is 5 attempts per IP per 15 minutes (`TEAMSPACE_ADMIN_RECOVERY_TOKENS` / `TEAMSPACE_ADMIN_RECOVERY_WINDOW_MS`); spending it locks that address out for the rest of the window. Every attempt, successful or not, is logged with a truncated member and device id. The key itself is never logged.

### Rotating the key

Set `TEAMSPACE_ADMIN_RECOVERY_KEY` to a new value (24-512 characters) and restart - the environment always wins over the file. To go back to a generated key, unset the variable, delete `admin-recovery.key`, and restart. Old keys stop working immediately; sessions already issued are unaffected.

## Data boundary (not stored in Directus / v-aid.ai)

Team Space **operational data never lives in Directus or the v-aid.ai account database**.

| What | Where it lives |
|---|---|
| Members, invites, session hashes, op log, blobs | This bridge `TEAMSPACE_DATA_DIR` only |
| Shared Modules CRM cells | Each member's local project SQLite + this bridge |
| Session token on the device | OS keychain + project settings (desktop) |
| Pro entitlement check | Existing `/me` subscription (plan gate only - not Team Space content) |
| Invite landing page | Stateless BFF HTML - reads `token` + `bridge` from the URL, opens the app. No invite/member/op rows |
| Marketing copy only | Directus `ui_strings` (invite page labels) + Pro pricing bullet. Never members, tokens, or CRM |

Do **not** add Directus collections for Team Space sync, invites, shared Modules, or public share / Form intake. Website CMS blocks named `team_*` are marketing "our team" content - unrelated.

## Public share HTTP

| Method | Path | Who |
|---|---|---|
| `POST` | `/v1/public-share/register` | Admin Bearer - upsert share + optional payload |
| `POST` | `/v1/public-share/payload` | Admin Bearer - replace scrubbed snapshot |
| `POST` | `/v1/public-share/revoke` | Admin Bearer |
| `GET` / `POST` | `/v1/public-share/submissions` | Admin Bearer - list pending / ack applied\|rejected |
| `GET` / `POST` | `/share/:token` | Guest - read shell / Form submit (password header when set) |

## Protocol

See `src/index.ts` for frame types. Batched `ops` frames return per-op `applied` / `refused` / `parked`. Unknown `op.kind` is parked so older apps never discard newer ops. On reconnect, hello replays a bounded recent op-log tail (`TEAMSPACE_RECENT_OPS_LIMIT`) and devices ack via `ack_ops` - this is catch-up for a bounded window, not infinite offline history.

## Blobs

`POST /v1/blobs/<sha256>` with `Authorization: Bearer <session>` and raw body (max 25 MB).  
`GET /v1/blobs/<sha256>` streams the bytes. Content-addressed; checksum verified on upload.

## Team server backups

Full app backups are **not** CRM blobs. They live under `$TEAMSPACE_DATA_DIR/backups/members/<memberId>/` with an `index.json` and `.aimove` snapshot files.

| Method | Path | Who |
|--------|------|-----|
| `POST` | `/v1/backups` | Member/Admin - stream upload (`Content-Length` required, max 8 GiB). Viewers cannot upload. |
| `GET` | `/v1/backups` | List mine. Admin may pass `?scope=all` (rows include `departed` when the member left). |
| `GET` | `/v1/backups/meta` | **Admin only** - retention ceilings only (no backup list). Desktop Settings reads this instead of listing every snapshot. |
| `GET` | `/v1/backups/export.zip` | **Admin only** - STORED zip of newest-1-per-member (`?mode=newestPerMember`) or selected ids (`?mode=ids&ids=a,b`), **plus live `chat/` files** from `TEAMSPACE_DATA_DIR` (rooms, history, attachments, meta). Headers: `x-backup-export-count` (aimoves), `x-backup-export-chat-count`, `x-backup-export-chat-truncated`. Chat-only is allowed when no member snapshots exist. Register before `/v1/backups/:id`. |
| `DELETE` | `/v1/backups/members/:memberId` | **Admin only** - wipe a **departed** member folder (409 if still on the roster). Register before `/v1/backups/:id`. |
| `GET` | `/v1/backups/:id` | Download (owner, or Admin). |
| `DELETE` | `/v1/backups/:id` | Owner or Admin. |
| `PATCH` | `/v1/backups/meta` | Admin - retention ceilings (`maxKeepPerMember`, quotas, `minIntervalMs`). |

Desktop Settings: **Back up now**, scheduled uploads (backup password in the OS keychain), **Restore** (stop Team Space dial + suspend project DBs, then passphrase-unlock via the Move-to-this-computer path), **Download**, and Admin **Download backups + team chat (zip)** (member `.aimove` files plus live `chat/`). Restoring a member move file does not rewrite team chat on the server - keep the zip if you need chat later. Removing a member **retains** their backups until an Admin downloads or deletes that folder.

Auth is **header Bearer only** (same class as blobs - no `?token=`). Desktop seals with a member password (`exportDeviceBundle`, identity-scoped projects) before upload. Never reuse the machine-only local backup key for the team-server file.

Rate limit: `TEAMSPACE_BACKUP_TOKENS` (default 20 per refill window) - see Environment table.

## Op log retention

Record field values sync verbatim once a module is shared. The append-only op log is a second copy. Ops are pruned after every known device has acked them, with a bounded catch-up window (`TEAMSPACE_OP_RETENTION_DAYS`) so a teammate offline within that window can still catch up. Beyond that window, ops may already be pruned - re-share or expect gaps. This is retention, not redaction.

There is a second, separate bound on catch-up. A computer that already has acks and is only briefly away replays the newest `TEAMSPACE_RECENT_OPS_LIMIT` changes (default 5000). A new device (or a replace-connection that mints a new device id), or a reconnect whose tail is full of newer edits, streams the durable log from the start in batches until every unacked change is sent. There is no 5000 or 200000 send stop - a large module (hundreds of thousands of records) lands little by little. `TEAMSPACE_FULL_OPS_CATCHUP_LIMIT` is only a progress-log interval. If the socket drops mid-scan, the next hello continues from already-acked ops.

## Team chat

Chat uses dedicated WebSocket frames (`chat_send` / `chat_history` / `chat_delete` / `chat_config_*` / `task_*`), not the Modules op log. History lives under `chat/rooms/` and prunes with the live Admin retention (seeded from `TEAMSPACE_CHAT_RETENTION_DAYS`, overridable via `chat_config_set`). Disk quotas for history files and attachments seed from env and are Admin-writable the same way. Viewers may read; only Members and Admins may post. `/task` in chat fans a request to connected Admins; task creation happens on the Admin desktop when that computer has the grant on.

## Temporary chat (never-persisted)

Temporary chat (1:1 and small group DMs, `eph:` room ids) is a separate feature from Team chat above: nothing in this path - not the room, not a message body, not membership - is ever written to disk. Rooms and messages live only in this process's memory and are gone the moment the room closes, a member's last socket disconnects, or the process restarts. That is the intended privacy contract, not a bug or a missing backup: there is nothing to restore, and a `TEAMSPACE_AT_REST_KEY` has nothing to encrypt here because nothing is written.

Because it is memory-only, a bridge restart (upgrade, crash, redeploy) silently ends every open temporary chat. Warn members if you restart mid-conversation - there is no reconnect-and-resume for this feature the way there is for Team chat or Modules sync.

| Variable | Default | Meaning |
|---|---|---|
| `TEAMSPACE_EPHEMERAL_ROOMS_TOTAL_MAX` | `2000` | Concurrent live temporary-chat rooms across the whole process. Range `10`-`20000` |
| `TEAMSPACE_EPHEMERAL_ROOMS_PER_MEMBER_MAX` | `5` | Concurrent live temporary-chat rooms one member may hold open at once. Range `1`-`50` |
| `TEAMSPACE_EPHEMERAL_GROUP_MEMBERS_MAX` | `12` | Max members in one temporary group chat. Range `3`-`50` |
| `TEAMSPACE_EPHEMERAL_GROUP_FORMATIONS_PER_MEMBER_MAX` | `3` | Concurrent pending (not-yet-formed) group invitations one member may have open at once. Range `1`-`20` |
| `TEAMSPACE_EPHEMERAL_PENDING_INVITES_PER_MEMBER_MAX` | `5` | Sent-but-not-yet-accepted-or-declined temporary-chat invites one member may hold open. Range `1`-`50` |
| `TEAMSPACE_EPHEMERAL_INVITE_TTL_MS` | `120000` (2 min) | How long an unanswered temporary-chat invite stays live before it silently expires. Range `15000`-`900000` |
| `TEAMSPACE_EPHEMERAL_START_TOKENS_PER_MIN` | `10` | Temporary-chat start/invite actions one member may send per minute. Range `2`-`60` |
| `TEAMSPACE_EPHEMERAL_MESSAGE_TOKENS_PER_MIN` | `30` | Temporary-chat messages one member may send per minute. Range `5`-`300` |
| `TEAMSPACE_EPHEMERAL_CLOSE_TOKENS_PER_MIN` | `20` | Temporary-chat close/leave actions one member may send per minute. Range `5`-`120` |
| `TEAMSPACE_EPHEMERAL_INFO_TOKENS_PER_MIN` | `10` | Temporary-chat description/icon updates one member may send per minute. Range `3`-`60` |
| `TEAMSPACE_EPHEMERAL_CLOSE_TIMEOUT_MS_DEFAULT` | `600000` (10 min) | Default grace period before an idle temporary-chat room closes. Range `30000`-`3600000` |
| `TEAMSPACE_EPHEMERAL_CLOSE_TIMEOUT_MS_FLOOR` | `30000` | Shortest close-grace-period a caller may request. Range `5000`-`3600000` |
| `TEAMSPACE_EPHEMERAL_CLOSE_TIMEOUT_MS_CEILING` | `1800000` (30 min) | Longest close-grace-period a caller may request. Range `60000`-`21600000` |

## Presence (online + cursors)

Presence is ephemeral on the bridge `live` session map (`presence_snapshot` / `presence_peer`), not Modules ops. Multi-device: a member stays online until their last live socket closes. Doc/Whiteboard cursors use separate `yjs_awareness` frames (same room caps as content `yjs_update`); they are not written into the CRDT document.

The online-peer list itself is capped at 128 entries per snapshot. This cap is fixed in the server, not an environment variable. A team running near or above the `TEAMSPACE_MAX_WS_CONNECTIONS` default of 200 sockets (for example, 100 members with two devices each) can already have more live sockets than the snapshot shows - some online names may be missing from the list even though those members are connected and can send and receive normally.

## Docker

The official image is `ghcr.io/stanislavmandrik621/aitomation-teamspace-bridge` (tags: `latest` and `vX.Y.Z`). It binds `0.0.0.0` (`TEAMSPACE_BRIDGE_HOST`) and runs as a non-root `bridge` user with `/data` mode `700`. A desktop `v*` tag does not publish this image (BRG-056). Pull it yourself after each team-server release.

```bash
docker pull ghcr.io/stanislavmandrik621/aitomation-teamspace-bridge:latest
docker run --rm -p 8788:8788 \
  -e TEAMSPACE_BRIDGE_HOST=0.0.0.0 \
  -e TEAMSPACE_BRIDGE_PORT=8788 \
  -e TEAMSPACE_AT_REST_KEY=<64-hex-or-passphrase> \
  -e TEAMSPACE_DATA_DIR=/data \
  -v teamspace-data:/data \
  ghcr.io/stanislavmandrik621/aitomation-teamspace-bridge:latest
```

Prefer the official GHCR image. Build from a public team-server checkout only. Never from a `packages/bridge` folder inside a desktop project.

To build locally from this public source tree:

```bash
docker build -t aitomation-teamspace-bridge .
docker run --rm -p 8788:8788 \
  -v teamspace-data:/data \
  -e TEAMSPACE_DATA_DIR=/data \
  -e TEAMSPACE_BRIDGE_HOST=0.0.0.0 \
  -e TEAMSPACE_AT_REST_KEY=<64-hex-or-passphrase> \
  aitomation-teamspace-bridge
```

Without `TEAMSPACE_BRIDGE_HOST=0.0.0.0` (or the image default), a loopback-only listen inside the container never receives traffic from published host ports.

To run more than one team on the same computer, see
[Several teams on one machine](#several-teams-on-one-machine).