# Self-hosted Google and Microsoft mailbox OAuth

The private Team Space server can connect a member's Gmail or Microsoft mailbox using OAuth credentials owned by the server administrator. This is separate from signing in to V-Aid: a V-Aid login, Team Space invite, or team membership does not grant mailbox access. Each mailbox requires its own provider consent.

In self-hosted mode the authorization-code exchange, token refresh, and mailbox API requests go from **your bridge directly to Google or Microsoft**. Mailbox access/refresh tokens are stored encrypted on your bridge, not in Directus or a V-Aid/vendor mailbox service. Provider client secrets stay in the bridge environment; they must not be placed in desktop settings, browser JavaScript, project files, or a public repository.

## Ownership and supported operations

Connections are private to the authenticated Team Space member, device, and selected project namespace on that server by default. Connecting a mailbox does **not** publish it to teammates or automatically share it with other projects. A project identifier is a private namespace, not a team-wide access grant; the bridge does not maintain a separate desktop-project membership registry. A matching mailbox address is not authorization to use someone else's connection.

The connection owner can explicitly grant send and/or inbox-summary access to an exact **member ID, target project ID, and device ID** in the authenticated team. This is an application access grant to that connection, not Microsoft/Google provider-side shared-mailbox permission. It does not delegate management: the recipient cannot issue new grants or manage the connection. Confirm the intended member, device, and project before granting; a similarly named project or another device is not interchangeable. Revoking access or pausing the connection stops pending work from using it and prevents subsequent inbox reads. Work already dispatched to the provider may have an uncertain outcome and cannot be recalled by revoking access.

A connection supports at most 2,000 access records including its owner; target-scope and server-wide access limits also apply. Grants do not remove provider quotas or convert a private provider mailbox into a provider-managed shared mailbox.

Connections remain owned by their original member and device, even when shared. Removing that member/device or downgrading the owner to a non-mail-authorized role blocks use by grantees as well. The bridge rechecks owner authority at enqueue, listing, and immediately before provider dispatch; it does not silently turn a departed member's mailbox into an organization-owned service account. Already-dispatched provider work cannot be recalled.

The integration supports queued sending and, when separately enabled during connection, paged mailbox summaries. The additional **Read and manage mailbox** checkbox explicitly requests broader provider consent for message bodies, read/unread, stars/flags, folders and labels/categories. Existing connections are not silently upgraded: the owner must sign in again. Existing summary-read grants remain summaries-only and cannot open full bodies or modify provider mail. These owner-only actions are exposed through the private mail reader in Communications and Communications settings.

Gmail lists system and custom labels, including Spam and Trash, and can create/apply/remove user labels. Outlook lists root and child folders, including Junk and Deleted Items, and can create folders and replace a message's categories. Pages and cursors are bound to the exact caller, connection, operation and folder. Message bodies are shown as inert text; HTML-only Gmail content is shown as source, never executable markup. Responses and display sizes are bounded (2 MiB provider response, 256 KiB body display); incomplete content is identified explicitly. MIME attachments and body parts stored as attachment references are not downloaded by this reader. A displayed attachment name is not a scan verdict or an available download.

Reading is non-destructive and does not implicitly mark provider mail read. Read/unread actions update Gmail's UNREAD label or Outlook's isRead property. Moves are explicit provider operations: Trash/Deleted Items is distinct from permanent deletion, and this API exposes no permanent-delete endpoint. Provider retention policies still apply to Spam and Trash. Gmail restore-and-move may require untrash followed by a label update; if a later request fails, refresh the folder because the restore may already have completed. There are no automatic mailbox retention/deletion rules or arbitrary sender aliases. Enqueuing is not sending: a `queued` acknowledgement means the server durably recorded work; only `accepted` means the provider accepted the request, and even that does not prove recipient delivery.

At-rest encryption is not end-to-end encryption against your server administrator: the running bridge can decrypt tokens to call the provider. Protect the server, its environment, backups, and administrator access accordingly.

## 1. Prepare your HTTPS endpoint and secrets

Run the bridge with **Node.js 22.13 or newer**; the mailbox worker requires the built-in SQLite API. Use a stable public HTTPS origin you control, for example `https://team.example.org`. Route its HTTP requests to the same bridge used by the desktop. The user's browser must be able to reach the callback. Configure TLS directly or follow the [reverse-proxy setup](SELF-HOST.md#running-on-a-vps-systemd-pm2-reverse-proxy).

Set these variables on the **bridge process**, not on the desktop:

```dotenv
TEAMSPACE_MAIL_PUBLIC_URL=https://team.example.org
TEAMSPACE_AT_REST_KEY=REPLACE_WITH_A_STRONG_64_HEX_CHARACTER_KEY

TEAMSPACE_MAIL_GOOGLE_CLIENT_ID=YOUR_GOOGLE_WEB_CLIENT_ID
TEAMSPACE_MAIL_GOOGLE_CLIENT_SECRET=YOUR_GOOGLE_CLIENT_SECRET

TEAMSPACE_MAIL_MICROSOFT_CLIENT_ID=YOUR_ENTRA_APPLICATION_CLIENT_ID
TEAMSPACE_MAIL_MICROSOFT_CLIENT_SECRET=YOUR_ENTRA_CLIENT_SECRET_VALUE
TEAMSPACE_MAIL_MICROSOFT_TENANT=common
```

Configure only the providers you intend to offer; omit both credentials for an unused provider. The Microsoft tenant is optional and defaults to `common`; restrict it to your tenant ID when only your organization should authorize accounts. Supported account types in the Entra registration must agree with this choice.

`TEAMSPACE_AT_REST_KEY` is **mandatory for mailbox OAuth**, even if another bridge feature permits running without it. The bridge accepts a 64-character hexadecimal key or a passphrase of at least 16 characters; prefer a randomly generated strong key. Keep it stable across restarts. Losing or replacing it without migrating encrypted data makes existing connections unreadable. Back up the key securely and separately from the data volume; do not print it in health checks or support logs.

Restart the bridge after changing its environment. Mailbox configuration must fail closed when credentials, the HTTPS origin, or encryption configuration are missing or invalid. Do not substitute a vendor callback when self-hosted setup is incomplete.

Connection credentials, access records, and outbox records are stored in `TEAMSPACE_DATA_DIR/mail-oauth/mail-store.sqlite3`. Sensitive record payloads use per-row authenticated encryption, with SQLite work and cryptography in a dedicated worker. This is not whole-disk encryption: database structure and operational/index metadata can still be visible to a server or backup administrator.

Use **one active bridge process with local durable disk** for a data directory. Do not share the directory between active servers, put it on NFS/shared network storage, or treat SQLite WAL files as a replication mechanism. Protect and back up the complete mailbox directory along with the server data. For a simple consistent filesystem backup, stop the bridge cleanly first; copying only the main database file while it is running can omit WAL-backed commits. Keep the original encryption key separately and restore it with the matching backup.

Prefer a runtime bundling SQLite 3.51.3 or newer (or a documented fixed backport). SQLite's [WAL-reset advisory](https://www.sqlite.org/wal.html#walresetbug) affects older versions when multiple connections write/checkpoint concurrently. The bridge's single mailbox worker avoids that concurrency, but do not open a second live SQLite connection using administrative tools. Stop the bridge and wait for graceful storage shutdown first. Passing local checks is not proof an unpatched SQLite build is immune.

Upgrading from the older `mail-oauth.v1.enc` format migrates legacy data into SQLite and retains the encrypted legacy file. That retained file is a migration source, **not** an up-to-date backup after the new server starts handling work. Rolling back to an older binary or restoring that stale file can lose new revocations, queue state, and duplicate-send protection. Stop service and plan a consistent database/key rollback with the administrator; never delete the new database just to force a legacy-file import.

Pending consent state is memory-only, single-use, and expires after ten minutes; it is intentionally not restored after a restart.

### Capacity and scheduling

These optional bridge environment settings are independent of provider quotas and do not replace Google/Microsoft consent:

- `TEAMSPACE_MAIL_MAX_CONNECTIONS`: 20,000 total connections by default; allowed range 1,000–100,000.
- `TEAMSPACE_MAIL_MAX_CONNECTIONS_PER_SCOPE`: 2,000 connections per exact member/device/project scope by default; range 1,000–20,000. Both owned connections and the combined owned/shared access list are capped. The server-wide limit also applies.
- `TEAMSPACE_MAIL_WORKERS`: eight global send workers by default; range 1–32. A provider account is dispatched serially, including when it has more than one connection/grant.
- `TEAMSPACE_MAIL_MAX_OUTBOX_RECORDS`: 1,000,000 records by default; range 10,000–5,000,000. This includes retained terminal history, not only pending messages.
- `TEAMSPACE_MAIL_STORE_MAX_BYTES`: 1,073,741,824 bytes (1 GiB) by default; range 67,108,864 bytes (64 MiB)–1,099,511,627,776 bytes (1 TiB).

Connection, inbox, and outbox lists use bounded cursor pages. Network concurrency is also bounded per provider account and globally; raising stored connection capacity does not create one simultaneous connection per mailbox. Size disk and provider quota budgets for the expected workload, and watch pending work, retries, and capacity errors before increasing worker counts. Capacity figures are supported configuration limits, **not proof that 1,000 live provider authorizations or deliveries have been exercised**.

## 2. Register Google OAuth

In your Google Cloud project, enable the Gmail API and configure the OAuth consent screen/audience for your organization. Create an OAuth client of type **Web application**, because your bridge exchanges the code using a confidential client secret. Register this exact authorized redirect URI, replacing only the origin:

```text
https://team.example.org/v1/mail/oauth/google/callback
```

Copy its client ID and client secret into the bridge variables above. The registered URI and configured public origin must match; do not register a V-Aid cloud callback or a desktop loopback callback for this flow. Google documents the web-server authorization-code flow and offline refresh-token access in its [web-server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server).

The connection requests `openid`, `email`, and `https://www.googleapis.com/auth/gmail.send`. Optional summaries add `https://www.googleapis.com/auth/gmail.metadata`; explicitly selecting **Read and manage mailbox** instead adds `https://www.googleapis.com/auth/gmail.modify`. Google classifies `gmail.send` as sensitive and `gmail.metadata` / `gmail.modify` as restricted. External/public apps may need OAuth verification; server storage or transmission of restricted-scope data can require a security assessment. An internal deployment is not a blanket exemption: confirm the rules for your audience and Google Workspace administrator policy. See [Gmail scopes and verification](https://developers.google.com/workspace/gmail/api/auth/scopes).

The integration does **not** request full `https://mail.google.com/` access. Changing scopes in the Cloud console alone does not upgrade a connection: new consent must complete in the app, and the bridge validates the returned scopes. Refreshing an old summary connection preserves its old permission tier.

For an External app left in Google's **Testing** publishing state, refresh tokens for these mail scopes generally expire after seven days. Add approved test users during testing, then complete the applicable publishing/verification process before relying on unattended production use. Refresh tokens may also be revoked or expire for other reasons; reconnect rather than assuming consent lasts forever. See [Google token expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration).

## 3. Register Microsoft OAuth

In Microsoft Entra admin center, register an application and choose the account types your organization permits. Add a **Web** platform with this exact redirect URI:

```text
https://team.example.org/v1/mail/oauth/microsoft/callback
```

Create a client secret under Certificates & secrets. Put the secret's **value**, not its secret ID, in `TEAMSPACE_MAIL_MICROSOFT_CLIENT_SECRET`, and record its expiration for rotation. Use the Application (client) ID for the client-ID variable. This implementation uses a client secret; configuring a certificate alone is not sufficient. See [Microsoft app registration](https://learn.microsoft.com/en-us/graph/auth-register-app-v2).

Configure Microsoft Graph **delegated** `User.Read` and `Mail.Send`. The authorization request includes `offline_access` for refresh tokens. Optional summaries add delegated `Mail.ReadBasic`; **Read and manage mailbox** instead requests delegated `Mail.ReadWrite`. Do not grant application-wide `Mail.Send`, `Mail.Read`, `Mail.ReadWrite`, or shared-mailbox permissions for this feature. Tenant policy may still require administrator approval for delegated consent. See [delegated access and offline access](https://learn.microsoft.com/en-us/graph/auth-v2-user) and the [Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference).

`Mail.ReadBasic` remains the summary tier; bodies and provider changes require explicit `Mail.ReadWrite` consent. Existing summary-read app grants do not gain body or modification access when the owner upgrades provider consent. See [Microsoft's list-messages permissions](https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0).

## 4. Connect and verify deliberately

Build and deploy a bridge version that includes this feature, and update the desktop too; changing environment variables cannot add it to an older server image. From a source checkout, `npm run verify:mail-server` builds and starts the actual bridge against isolated temporary data. It verifies HTTP authentication, viewer refusal and safe behavior without provider configuration. It does not use mocked providers, and it does **not** verify Google/Microsoft sign-in or delivery. The temporary verification data path is printed for inspection.

1. Connect the desktop to your private Team Space server and select the intended project.
2. Start the mailbox connection from Communications settings. Check the server origin and choose Google or Microsoft. Leave optional summaries and mailbox management off unless needed; management explicitly permits provider-side changes.
3. Complete consent in the provider's browser page. Check the mailbox and requested permissions before approving. Return to the desktop and refresh/check the connection status.
4. For a send test, explicitly send a harmless message to an inbox you control and verify receipt there. Do not treat connection status alone as proof of delivery.
5. Verify a different member/device/project cannot list or use this connection without an explicit grant. Verify a deliberately granted recipient can use only its selected send/read permissions, and that revoking the grant blocks pending work and future reads. Test disconnect and provider-side revocation using a mailbox you control before rollout.

Changing projects, removing the initiating session, restarting the server during consent, or reusing an expired callback may require starting connection again. Never paste authorization codes, OAuth state, refresh/access tokens, client secrets, or Team Space bearer tokens into chat, issue reports, or support bundles.

## Operations and troubleshooting

Before rollout, run `npm run build`, `npm run verify:mail-storage`, and `npm run verify:mail-server` from `packages/bridge`. These checks exercise real encrypted SQLite, service denial boundaries, and an actual local HTTP server without simulating mail providers. They do not replace the real consent, token-refresh, send/receipt, revocation, and workload checks above. New outbox entries are paged newest request first; older migrated entries retain their original identifiers.

From `apps/desktop`, `node tests/integration/selfhost-mail-identity-native.cjs` exercises the installed Electron runtime and real OS secure storage using isolated temporary diagnostic data, including a second-process reopen. It requires an available native secure-storage backend; never replace it with a fake backend to claim a pass. A process restart is not a physical power-loss test.

From the same desktop directory, `node --import tsx tests/integration/comms-real-sql.ts` exercises the actual SQLite implementation: profile pagination and selection above 1,000 stored profiles, indexed inbox deduplication beyond the former recent-message window, send-receipt durability after an abrupt process exit, and separate identities for explicitly selected threads. These are local storage and authorization checks, not 1,000 authenticated mailbox sessions. The bridge storage checks also cover disk-full rollback, queue saturation during close, bounded large-message pages/deletions, and indexed account queries across 2,000 namespaces.

The server owns the durable OAuth outbox. Once a send has been queued, closing the desktop does not cancel it: work can continue while the bridge is running, subject to the sending identity's current member/device authorization and mailbox/project access grant. Inspect the outbox and explicitly cancel work that has not started if you no longer want it sent. A message already handed to the provider cannot be reliably recalled through this feature.

Turning Communications off on one computer stops new local mail/inbox requests, not jobs already queued on the private server. Use the connection's server-side Pause control or cancel the relevant outbox jobs to stop pending work. Mailbox management remains available while local Communications is off. Check the worker-health status when work is not progressing; do not assume a healthy HTTP endpoint means the outbox worker is healthy.

Outbox status distinguishes `queued`, `retry_wait`, and `dispatching` from terminal `accepted`, `unknown`, `rejected`, or `cancelled`. Explicit provider throttling uses `Retry-After` (bounded to 24 hours) and exponential backoff with jitter, with at most 12 provider retry attempts. A transport failure that leaves acceptance uncertain becomes `unknown`; it is not automatically resent. Message content remains encrypted after completion. Outbox and OAuth warm-up history are retained forever by default. The exact owner/project/device can read `retention-get` and save `retention-save` with `retentionDays` (0 for forever or 7-3,650), `expectedRevision` (0 if absent), and explicit `approveDeletion: true` for a finite policy. The desktop requires a destructive confirmation before submitting that approval. Cleanup removes only expired eligible terminal history in bounded batches, checking the still-approved policy atomically; active and uncertain outcomes remain. Page/display limits never delete records. Capacity limits refuse new work rather than evict saved history. An unrecorded send key older than seven days is rejected rather than treated as a fresh request, so explicitly approved history expiration cannot silently turn an old retry into a duplicate send. Update both server and desktop; previously deleted history or stripped message bodies cannot be recovered by this migration.

SMTP/API profiles are a separate desktop-local transport. Their storage limit defaults to 1,000 per project and is configurable up to 10,000; existing explicitly saved lower limits are preserved. Settings lists are searchable and paged, and sending selects at most eight eligible profiles. IMAP polling is capped at 25 profiles per cycle, serial within a cycle, with at most four concurrent cycles across the desktop. Its in-memory round-robin cursor advances even through failed batches but resets on desktop restart. At large profile counts, slow servers and timeout settings can substantially delay a full sweep; increasing profile storage capacity does not make every inbox check simultaneous. Closing the desktop stops this SMTP/IMAP polling path.

Desktop SMTP/API sends record an intent before contacting the provider and retain a separate OS-encrypted native attempt marker outside the project database. Retrying an unchanged intent reads its receipt instead of sending it again. An uncertain result requires deliberate acknowledgement before a new attempt; inspect the provider first because resending can duplicate a message. Restoring an older project database does not clear the native attempt marker. Restoring both storage locations to older versions can defeat this protection: retain the current native identity store during recovery, and do not delete receipts or identity files to force a retry. Local storage cannot guarantee exactly-once delivery across arbitrary rollback or provider failures.

Desktop IMAP retains at most 32 MiB of UTF-16 message-body text per profile per poll, including recovery work. Interrupted or budget-limited bodies are marked incomplete rather than presented as complete. Later polls fairly retry up to five incomplete bodies alongside normal new-message polling. Recovery updates an existing row only after profile, UID validity, UID, and Message-ID match; deleted or reassigned provider messages cannot be reconstructed safely. These limits concern desktop IMAP, not the bridge's separately bounded OAuth mailbox reader.

Portal sign-in emails use the bridge OTP job identity as the delivery intent. If the mail provider accepted the email but the bridge acknowledgement failed, the next drain retries the acknowledgement without another send. Plaintext OTP content is not saved in Communications history; the receipt uses a keyed payload fingerprint whose key stays in native encrypted storage, not a bare hash that exposes a short code to guessing from the project database. A paused, expired, revoked, or changed project/team context blocks a new dispatch; mail already submitted cannot be recalled.

- **Provider unavailable:** check the bridge environment and encryption key; an unused provider should remain unavailable.
- **Redirect mismatch:** compare scheme, hostname, port, and complete callback path against the provider registration. Configure the external HTTPS origin, not an internal container URL. Do not derive callbacks from an untrusted request Host header.
- **Consent blocked:** check Google audience/test-user/verification settings or Microsoft account type, tenant, administrator consent policy, and client-secret expiration.
- **Reconnect required:** authorization may have been revoked, a Google testing token may have expired, or the saved encrypted credentials may be unreadable. Investigate the cause before reconnecting.
- **Inbox unavailable:** reconnect with the explicit summaries permission; send-only consent deliberately cannot read inbox metadata.
- **Disconnect versus revocation:** removing the local connection and revoking the app in the provider's account-security controls are separate operations. Use provider-side revocation when you need to invalidate a grant outside this bridge as well.
- **Uncertain send:** inspect the provider's Sent mail before taking another action. Retry only the unchanged message with its existing send key to check the recorded result; do not create a fresh key or reconnect just to force another attempt. The server records uncertain attempts before calling the provider to avoid automatic duplicates.
- **Storage capacity reached:** stop and involve the administrator. Do not delete or edit the encrypted send ledger to bypass a limit: it records duplicate-send protection, not merely disposable logging.

Keep reverse-proxy access logs from recording callback query strings: OAuth callbacks contain temporary authorization codes and state. Do not log authorization headers or token responses. Keep TLS enabled, bound request sizes/rates, and trusted-proxy hop settings aligned with your deployment. Pending OAuth states are not a recovery mechanism; recover server data using protected backups and the original encryption key.
