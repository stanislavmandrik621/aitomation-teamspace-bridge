# Private-server app connections

This broker registers Google and Microsoft accounts for the four-service Connections panel in Advanced mode. Existing `/v1/mail` accounts, shared-mailbox grants and queued mail remain separate and continue using their current storage and routes.

The server administrator supplies an OAuth registration once; individual members sign in and grant consent. The administrator can use an existing enterprise registration or a new one. Members do not create developer keys.

## Server configuration

Configure secrets in the server environment, never in source, desktop settings or agent prompts:

```
TEAMSPACE_AT_REST_KEY=<existing server encryption key>
TEAMSPACE_CONNECTIONS_PUBLIC_URL=https://team.example.org
TEAMSPACE_CONNECTIONS_GOOGLE_CLIENT_ID=<web application client ID>
TEAMSPACE_CONNECTIONS_GOOGLE_CLIENT_SECRET=<web application secret>
TEAMSPACE_CONNECTIONS_MICROSOFT_CLIENT_ID=<application client ID>
TEAMSPACE_CONNECTIONS_MICROSOFT_CLIENT_SECRET=<application secret>
TEAMSPACE_CONNECTIONS_MICROSOFT_TENANT=common
```

One configured provider is sufficient. The public URL must be an HTTPS origin, with no path, query or credentials. Existing `TEAMSPACE_MAIL_*` values are fallback registration values; this does not upgrade the permissions or reuse the accounts of the legacy mail service. A provider's client ID and secret must come from the same namespace: setting either `TEAMSPACE_CONNECTIONS_*` credential requires both. Self-hosted registrations are independent of the managed-cloud paid-plan requirement.

Add these exact redirect URIs to the corresponding provider registration, replacing the origin:

```
https://team.example.org/v1/connections/oauth/google/callback
https://team.example.org/v1/connections/oauth/microsoft/callback
```

Keep existing `/v1/mail/oauth/.../callback` registrations if legacy mail is used. Microsoft `common` accepts the account types allowed by the actual Entra registration, `organizations` restricts organizational accounts, `consumers` restricts personal accounts, and a tenant UUID restricts that organization. Tenant and user consent policy can still block a connection. Google Workspace accounts also depend on the registration's audience and the organization's consent policy.

Enable the APIs for the selected services. The generated `catalog.ts` is the exact scope contract: Google Mail currently asks for full Gmail permission to support explicitly confirmed permanent deletion; other selected services request Calendar, Drive or Contacts access. Microsoft requests delegated Mail.ReadWrite/Mail.Send, Calendars.ReadWrite, Files.ReadWrite.All or Contacts.ReadWrite as selected. Additional provider publishing, verification and organization approval requirements must be completed before production use. Existing consent is not silently expanded.

## Data path and authority

The server handles OAuth, encrypted refresh credentials and short control requests. `start`, `list`, `update`, `disconnect` and `lease` are POST endpoints bound to the authenticated Team Space member, device and private project namespace. Viewer accounts cannot use them. A project identifier is a private namespace, not a team-wide access grant.

The desktop main process obtains a credential lease internally, validates local assistant grants and calls the provider directly. Files and provider response bodies do not travel through these new broker routes. Renderer code and AI tools cannot request the lease operation or receive access/refresh tokens. Every native write requires review of the exact action and payload; file previews use size and SHA-256. Headless writes are refused.

Stopping a chat cancels its native action through a local request ID bound to the originating window and captured project/server scope. Cancellation is not a broker route. A stopped confirmation cannot later send its write; stopping a write already dispatched to the provider reports an uncertain outcome and does not retry automatically.

The app's lease cache expires within five minutes and is scoped by owner/project/window/server/session. This is an application deadline, not a shortened provider token expiry. A compromised native process could use an already issued token until the provider expires or revokes it. Disconnect and changed service permissions block new leases; local management changes also invalidate the native cache. Existing queued-mail processing continues through the legacy mail service.

Legacy-style `prepare`, `approve` and `action` requests receive `connections.native_required` before their bodies are parsed. Control requests have a 16 KiB body limit. Binary actions are validated by the native file contract, independently of that metadata limit.

## Storage and verification

Encrypted credential records are stored under `TEAMSPACE_DATA_DIR/workspace-connections/mail-oauth/mail-store.sqlite3`. This deliberately uses a separate database and worker from the legacy `mail-oauth` directory. Do not open another live SQLite writer against either database. Back up the complete directory after orderly server shutdown, including the matching at-rest key stored separately.

The provider/service modules are generated from the managed broker. Keep adapters (`config.ts`, `http.ts`, `store.ts`) separate:

```
node packages/bridge/scripts/sync-workspace-connections.mjs
node packages/bridge/scripts/sync-workspace-connections.mjs --check
pnpm --dir packages/bridge build
cd packages/bridge
node --import tsx tests/workspace-connections.ts
```

The test starts isolated loopback HTTP and real encrypted SQLite with fixture OAuth responses. It verifies authority, exact lease ownership, native-only route rejection, service changes, revocation and shutdown. It does not establish live provider consent or production capacity.
