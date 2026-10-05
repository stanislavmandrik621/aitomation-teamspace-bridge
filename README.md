# AItomation Team Space server

Self-hosted **private team server** for AItomation Team Space, syncing shared Modules and custom project Playbooks between teammates.

This repository is the **team server only**. It is **not** the AItomation desktop app. The desktop app Connects to this server from Settings - Team Space (Pro host). Teammates join with an invite.

## Quick start (Docker - preferred)

```bash
docker pull ghcr.io/stanislavmandrik621/aitomation-teamspace-bridge:latest
docker run --rm -p 8788:8788 \
  -e TEAMSPACE_BRIDGE_HOST=0.0.0.0 \
  -e TEAMSPACE_BRIDGE_PORT=8788 \
  -e TEAMSPACE_AT_REST_KEY=<64-hex-or-passphrase> \
  -e TEAMSPACE_DATA_DIR=/data \
  -e TEAMSPACE_AUTHORITY_DIR=/authority \
  -v teamspace-data:/data \
  -v teamspace-authority:/authority \
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
- `TEAMSPACE_AUTHORITY_DIR` - an independent, persistent directory outside the data backup root. Defaults to `${TEAMSPACE_DATA_DIR}.authority`; Docker uses `/authority`. Keep it current when rolling back data.
- `TEAMSPACE_TRUSTED_PROXY_HOPS` - `1` for a single reverse proxy, `0` for none. Rate limits are counted per caller address, and behind a proxy this is what tells the server which part of the forwarding header it can believe.

Step-by-step service unit, pm2 config, and `wss://` proxy snippets: [Running on a VPS](docs/SELF-HOST.md#running-on-a-vps-systemd-pm2-reverse-proxy).

Shared human tasks, review credentials, optional private coordinator monitoring,
backup files and deployment limits: [Workspace Work operations](WORKSPACE-WORK.md).
Monitoring runs in this single bridge process after each member explicitly
enables it; it does not call an AI model or send messages. Current limits are
100 monitoring subscriptions, 10,000 tasks per workspace, 100 attention rows,
and a nominal 30-second monitoring cycle. See the operations guide before
planning a larger deployment.

## Item-access revocation and upgrades

The server enforces current item grants for operation delivery, queued writes,
attachment downloads, and record document rooms. Deploy the matching desktop
update with this server: older clients without author-time access revisions must
update before editing an item whose grants have changed. Stale queued edits are
refused, including after a recipient is re-granted access.

Compose HTTP/Yjs permissions and synced snapshots now share per-document
revocation revisions, including durable removal tombstones. On startup the
server reconciles a committed HTTP change whose sync checkpoint was interrupted.
Server-only `compose.access` notifications refresh client edit revisions without
creating or changing document content. `compose-live-acl.json` and its
`.initialized` marker live with the independently retained authority.

Deletion/revocation notifications carry only cleanup metadata; historical
destructive notices are not replayed over a restored grant. Legacy payloads are
canonicalized before authorization so the bridge validates the same content the
desktop applies.

Current membership, sessions, item/field grants, Office sharing, private chat
membership, and public-link revocations live in `TEAMSPACE_AUTHORITY_DIR`.
Restoring `TEAMSPACE_DATA_DIR` uses these current permissions. Missing, foreign,
corrupt, or unwritable authority refuses access; old data is never promoted to
new authorization. Retain the entire authority directory, its binding marker,
and the configured at-rest encryption key independently of data rollback.

Existing installations require a one-time stopped-server migration. See
[Independent authorization and rollback](docs/INDEPENDENT-AUTHORITY.md) before
upgrading. Never initialize authorization from an old backup as a repair.

Run `pnpm run test:content-access` for the storage and real-localhost revocation
regressions. These cover current access and retry safety, not erasure of copies
previously exported by a recipient.

## Locked out?

If you are the only Admin and you lose your session token (keychain reset, reinstall, new computer, or pressing Disconnect), use the recovery key instead of starting over. The server generates one on first boot and saves it to `$TEAMSPACE_AUTHORITY_DIR/admin-recovery.key`, or set your own with `TEAMSPACE_ADMIN_RECOVERY_KEY` (at least 24 characters):

```bash
# Docker:
docker exec <container> cat /authority/admin-recovery.key
# Without containers (file is owner-read-only, owned by the service account):
sudo cat /var/lib/teamspace-bridge.authority/admin-recovery.key
```

Supply that key when the desktop app asks, and it rebinds your existing Admin account to the computer you are on. Nothing is deleted - rooms, chat history, attachments, synced rows, and teammate accounts are all left alone. Details: [Admin recovery](docs/SELF-HOST.md#admin-recovery-locked-out-of-your-own-server).

## Docs

Full environment, security, invites, recovery, backups, and Docker notes: [docs/SELF-HOST.md](docs/SELF-HOST.md).

Connect private Gmail or Microsoft mailboxes using your own OAuth app and HTTPS callback: [Self-hosted mailbox OAuth](docs/MAIL-OAUTH.md).

## Source of truth

Day-to-day edits live in the AItomation monorepo `packages/bridge` and are published here for customers. Do **not** expect this folder to appear inside a desktop project directory.

## License

MIT - see [LICENSE](LICENSE).
