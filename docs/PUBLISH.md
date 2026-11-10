# Publishing the public Team Space team server

Day-to-day edits live in the **private** AItomation monorepo under `packages/bridge`.

## Customer surfaces

| Surface | URL |
|---|---|
| Public source | https://github.com/stanislavmandrik621/aitomation-teamspace-bridge |
| Official image | `ghcr.io/stanislavmandrik621/aitomation-teamspace-bridge` (`latest` + `vX.Y.Z`) |

## Sync (source)

```bash
# From monorepo root (uses git credentials / SYNC_TOKEN):
bash scripts/sync-teamspace-bridge-public.sh
```

One direction of truth: monorepo -> public mirror. Do not expect long-lived divergent edits on the public repo.

## Docker (image)

Official image CI is the **public** repo workflow `publish-image.yml`. The GHCR package is linked there. The private monorepo `GITHUB_TOKEN` cannot push (`write_package` denied, BRG-058).

Monorepo CI (`.github/workflows/teamspace-bridge-publish.yml`):

- Proves `packages/bridge` still builds (no registry push).
- Optional secret `TEAMSPACE_BRIDGE_SYNC_TOKEN` mirrors source to the public repo. That push fires public `publish-image`, which writes GHCR `:sha-...` and `:latest`.
- Tag `bridge-vX.Y.Z` also stamps public `vX.Y.Z` so `publish-image` tags GHCR `:vX.Y.Z` + `:latest`.

## Manual first publish (when CI has not run yet)

Needs a GitHub token with `write:packages` (the ordinary git HTTPS credential often lacks this scope):

```bash
cd packages/bridge
echo "$GHCR_TOKEN" | docker login ghcr.io -u stanislavmandrik621 --password-stdin
docker build -t ghcr.io/stanislavmandrik621/aitomation-teamspace-bridge:latest .
docker push ghcr.io/stanislavmandrik621/aitomation-teamspace-bridge:latest
```

After the first successful push, make the package public under GitHub Packages if pulls should work without auth.

## Desktop honesty

Settings and `manage_teamspace_server` print Docker pull/run + public clone commands from `apps/desktop/src/lib/teamspace-selfhost.ts`. Never tell customers to `cd packages/bridge` inside a project folder.
