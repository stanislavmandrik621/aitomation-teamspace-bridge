# Independent authorization and rollback

The server uses two persistent stores. `/data` contains restorable operation
history, documents, messages, attachments, and uploaded backup files.
`/authority` contains current membership and session revocations, invitations,
item and field restrictions, document permissions, record access indexes,
Office sharing, private-room membership, and public/Compose/portal link state.
Some authority records include their current published content so an older
payload cannot reactivate a revoked or stale public link.

Use named volumes for both directories, as in `docker-compose.yml`. For a
service without Docker, set absolute `TEAMSPACE_DATA_DIR` and
`TEAMSPACE_AUTHORITY_DIR` paths. The authority directory must be outside the
data directory. Each team needs its own pair. Both are locked against a second
server process. Binding markers reject missing or foreign authority volumes.
After a team is established, missing or unreadable team identity and an empty
roster also refuse startup. They never reopen first-admin setup or import an
old roster from the data snapshot. Damaged files remain available for recovery.
The binding also records initialized access checkpoints. Removing both an ACL
database and its local initialization marker refuses startup instead of rebuilding
permissions from old operation history.

The binding also retains the paths of authorization families once they are
used. Losing a family file together with its own marker still refuses startup.
Unreadable JSON is rejected before repair or quarantine can alter the original.
Public, Compose, and portal revocations have a separate durable negative-token
index: losing an individual retirement file cannot make its link usable again.
Missing, damaged, or wrong-key indexes refuse access and remain available for
recovery. A revocation is committed before it is acknowledged.

## Upgrade a current legacy server

Stop the old server and retain a complete recovery copy before migrating.
Use only the current, authoritative installation, with its original at-rest
key. Verify any access changes made outside that installation first. The
operator's explicit trust decision is required because an old snapshot alone
cannot prove today's permissions.

For Docker, mount the existing data volume and a new named authority volume
into the new image and run its normal entrypoint with this command:

```sh
docker run --rm \
  --env-file /secure/teamspace.env \
  -e TEAMSPACE_DATA_DIR=/data -e TEAMSPACE_AUTHORITY_DIR=/authority \
  -v teamspace-data:/data -v teamspace-authority:/authority \
  ghcr.io/stanislavmandrik621/aitomation-teamspace-bridge:YOUR_NEW_VERSION \
  node dist/authority-migrate.js /data /authority --trust-current-permissions
```

The environment file must supply the existing `TEAMSPACE_AT_REST_KEY`. This
command copies current authority and commits the binding; source files stay
intact. It rejects links, nonregular files, populated destinations, and an
already bound installation. Start the new server with the same two volumes
and key. Never run the old server on that data again: it writes obsolete
authority files under `/data` which the new server intentionally ignores.

For a non-Docker service, the equivalent command is
`node dist/authority-migrate.js DATA_PATH AUTHORITY_PATH --trust-current-permissions`
under the stopped service's OS account and configured environment.

If migration is interrupted, leave the server stopped and preserve the source
and partial destination. A partial copy does not become live authority. Complete
recovery from the known-current source into a fresh empty authority directory;
do not remove a committed binding to make an older snapshot start.

## Restore data

Stop the server. Restore a complete, consistent data snapshot to `/data`, keeping
the **current** `/authority` volume and encryption key. Start the server and
reconnect clients. Current members retain the access they still have; removed
members, revoked links, and excluded private-room users remain denied. The
desktop rechecks restored shared content against the server before opening it.
Data from before the binding was introduced requires explicit administrator
reconciliation while the server remains isolated.

Retain authority using a separate replication/backup policy and recovery
credentials. Never pair an old data snapshot with an equally old authority
snapshot. Rolling back an entire VM, both volumes, or all independent copies
cannot reveal permissions that no surviving system remembers. In that disaster,
keep the service isolated until the latest authority is recovered or access is
explicitly reconciled. Missing authority never causes automatic bootstrap.

For loss of the original host, provision fresh data and authority volumes while
the replacement server is stopped. Put the chosen consistent content snapshot
in the data volume, and the separately retained **latest** authorization copy
in the authority volume. Preserve the binding files and original encryption
key. Start isolated, confirm that known revoked members and links remain denied
and current members can read their permitted content, then reopen connectivity.
Do not generate a replacement encryption key or delete a checkpoint to make a
failed recovery start. Preserve both recovery copies while resolving the error.

The Admin “backups + chat” export is a content archive, not an authorization
restore or complete disaster-recovery image. Personal backups preserve only
currently readable shared data. Restored unsent chat messages are parked for
review and retry; they are never automatically sent.

## Restoring a previously connected desktop

A personal restore installs the current verified item-access revisions and
requires authenticated history replay for each restored team. During this one
catch-up, the server includes permitted history already acknowledged by that
same device, including its own newer edits. Current item and field restrictions
still apply at every send boundary. Other devices' receipts are unchanged.
The desktop waits for durable application before clearing the restore generation;
truncated replay, failed application, and an unsupported older server keep shared
editing paused. Update the desktop and team server together for this recovery
protocol. Restored queued writes are not silently assigned new permissions.
Members receive only the current opaque field-permission revision/hash needed
to author a fresh permitted edit, never the Admin's full permissions metadata.

## Personal Office, chat, and legacy file recovery

Personal export and restore verify each shared module, record, document, Office
object, chat room, and attachment against the currently authenticated server.
Still-authorized content remains usable. Office shapes and human responsibilities
come from the current server; private local settings need separate creator proof.
Creating a room does not prove ownership of its parent floor. Chat history stays
on the server, while authorized unsent drafts can travel in the personal backup
and require explicit retry after restore.

Older Office rows with an explicit team association and files with a verified
current content grant can be recovered. Verified legacy files are copied into
portable project storage, with references and file hashes checked again before
restoring. This includes Markdown links (inline and reference style), HTML media
and link attributes, and references nested inside rich document JSON. Labels and
surrounding prose are preserved when the verified destination is relocated.
A filename, folder location, cached role, or archive owner flag alone
is not proof. Ambiguous files and unsupported copies remain in their original
project/archive; the operation refuses rather than exporting potentially private
data or silently deleting it. No restore rewrites the source archive.

A restored connection flag is not authorization. The desktop repairs that flag
only after the bound server authenticates the connection. Shared tables and
fields remain protected while their membership cannot be verified, including
when the connection toggle is off. Unbound local private tables retain their
ordinary local access.
