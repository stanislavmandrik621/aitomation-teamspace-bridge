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

Composer boards are private until explicitly shared from the open board’s
**More board tools → Share with team** menu or Team Space settings.
Knowing a private board's ID or holding the Admin role does not grant a live
room. A first share requires selecting specific teammates or deliberately
choosing the whole team; Admins can manage boards that have been shared.
Unsharing removes recipient replicas and live access while preserving the
owner's original. Existing explicitly shared boards retain their audience.
Invited teammates, including Free accounts and Viewers, can publish their own
existing saved boards through the authenticated owner-sharing endpoint; normal
Viewer edits remain forbidden. Every Admin can see and manage shared boards,
including selected-person boards, while unshared originals stay private.

External review links are separate from team editing. Use the open board’s
**More board tools → Share review link** action to publish a password-protected
snapshot. Invited Free members may publish their own boards. Guests see a
view-only canvas with pan, zoom, page navigation and an optional comments panel.
Click or drag in comment mode to pin a point or region; coordinates are stored
relative to the page, so they survive zoom and viewport changes. PDF, PNG, JPEG
and SVG use the same review interface. PDF.js and its fonts/workers are served by
this bridge; no CDN is required. Original file downloads remain available.
Appearance offers System, Light and Dark using a custom menu; the canvas surround
follows that theme without recolouring the published artwork. Opening a preview
from the editor inherits its current theme.

Comments belong to that immutable publication, not the editable source board.
Updating the design requires a new publication; existing pins never silently
move to different artwork. The editor's left **Comments** section shows these same
discussions to current board recipients, including team replies and resolution.
Its preview opens the exact publication with the selected pin.

Review access supports a shared password with an entered name or animal alias,
or individual reviewer names and passwords. Personal access and password resets
are managed from **Review access** in the share dialog or Comments section.
Identity and colour are session-bound; a personal password identifies its named
invitation, not a verified real-world identity. Team authors come from the current
authenticated membership. Replies preserve their parent and root discussion;
resolution closes the whole thread. Current team editors may resolve discussions,
and guests may resolve their own. Revoking one personal invitation invalidates
only its sessions. Online viewers use a short presence lease and a visible-page
heartbeat; no editable team roster access is granted to guests.

Comments are encrypted when server at-rest encryption is enabled. Revoking or expiring a
link refuses subsequent viewing, downloads and comments. An already downloaded
copy cannot be recalled. The viewer rechecks access on refresh/focus and keeps
passwords only during unlock. The resulting expiring review token is kept in that
tab's sessionStorage; it never carries source editing permissions. Every request
rechecks link, reviewer and membership access. Server-busy responses use bounded
delayed retries. Presence pauses when hidden; the editor refreshes comments every
30 seconds while its Comments section is open.

Ownership is stored with Compose authority. Removing or leaving members
transfers their currently shared boards to the oldest remaining administrator.
Private boards and revoked grants are not transferred. Startup repairs a crash
between roster removal and the ownership update. A removed person returning
with a fresh invitation gets a new membership: old selected-person grants and
transferred ownership do not return. Current whole-team grants apply normally.
Cancelled/used invitations and revoked session tokens cannot restore access.

Live Composer co-edit remains opt-in on both sides: enable
`TEAMSPACE_YJS_COMPOSE_ENABLED=true` on the bridge and the Composer live co-edit
setting in the desktop project. These flags do not share private boards.
The desktop pauses a live session while permissions or team identity are
unreadable, and reconnects only after resolving an authorized scope. Use the
matching desktop and bridge versions to enforce the complete flow.

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
