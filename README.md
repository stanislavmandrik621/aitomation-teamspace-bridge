# AItomation Team Space server

Self-hosted **private team server** for AItomation Team Space (Modules CRM sync between teammates).

This repository is the **team server only**. It is **not** the AItomation desktop app. The desktop app Connects to this server from Settings - Team Space (Pro host). Teammates join with an invite.

## Quick start (Docker - preferred)

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

Then in the desktop app: **Settings - Team Space** - paste `ws://127.0.0.1:8788` (or your secure `wss://` address) - Connect.

`GET /` and `GET /health` answer 200. A browser shows a short status page. `curl` and the app Check connection still get the one-line text `AItomation Team Space bridge`.

Versioned tags (`vX.Y.Z`) are published on each release. Prefer pinning a version in production. Official images are multi-arch (`linux/amd64` and `linux/arm64`).

## Alternate (clone + pnpm)

```bash
git clone https://github.com/stanislavmandrik621/aitomation-teamspace-bridge.git
cd aitomation-teamspace-bridge
pnpm install
pnpm start
```

Default listen: `ws://127.0.0.1:8788` (loopback only). Set `TEAMSPACE_BRIDGE_HOST=0.0.0.0` when teammates must reach this machine over the network.

`pnpm start` runs the server from source and is meant for development. For a real service, build once (`pnpm build`) and run `node dist/server.js` under a service manager.

## Running on a server (no containers)

Running under a service manager behind nginx or Caddy needs two settings that Docker sets for you, and both cause quiet damage if missed:

- `TEAMSPACE_DATA_DIR` - set an **absolute** path. The default is relative to whatever folder the process started in, so a service with no working folder set, or a deploy that unpacks each release into a new folder, silently starts an empty team and leaves your real one behind.
- `TEAMSPACE_TRUSTED_PROXY_HOPS` - `1` for a single reverse proxy, `0` for none. Rate limits are counted per caller address, and behind a proxy this is what tells the server which part of the forwarding header it can believe.

Step-by-step service unit, pm2 config, and `wss://` proxy snippets: [Running on a VPS](docs/SELF-HOST.md#running-on-a-vps-systemd-pm2-reverse-proxy).

## Locked out?

If you are the only Admin and you lose your session token (keychain reset, reinstall, new computer, or pressing Disconnect), use the recovery key instead of starting over. The server generates one on first boot and saves it to `$TEAMSPACE_DATA_DIR/admin-recovery.key`, or set your own with `TEAMSPACE_ADMIN_RECOVERY_KEY` (at least 24 characters):

```bash
# Docker:
docker exec <container> cat /data/admin-recovery.key
# Without containers (file is owner-read-only, owned by the service account):
sudo cat /var/lib/teamspace-bridge/admin-recovery.key
```

Supply that key when the desktop app asks, and it rebinds your existing Admin account to the computer you are on. Nothing is deleted - rooms, chat history, attachments, synced rows, and teammate accounts are all left alone. Details: [Admin recovery](docs/SELF-HOST.md#admin-recovery-locked-out-of-your-own-server).

## Docs

Full environment, security, invites, recovery, backups, and Docker notes: [docs/SELF-HOST.md](docs/SELF-HOST.md).

## Source of truth

Day-to-day edits live in the AItomation monorepo `packages/bridge` and are published here for customers. Do **not** expect this folder to appear inside a desktop project directory.

## License

MIT - see [LICENSE](LICENSE).
