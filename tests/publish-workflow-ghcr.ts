/**
 * BRG-058: official GHCR write is public publish-image.yml. The private
 * monorepo GITHUB_TOKEN cannot write_package on a package linked to the
 * public repo. Pin both workflows (monorepo file is absent on a public
 * clone, so that half is skipped there).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const bridgeRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const publicWf = readFileSync(
  join(bridgeRoot, '.github/workflows/publish-image.yml'),
  'utf8',
)
const monoWfPath = join(
  bridgeRoot,
  '../../.github/workflows/teamspace-bridge-publish.yml',
)
const syncScriptPath = join(bridgeRoot, '../../scripts/sync-teamspace-bridge-public.sh')

describe('BRG-058 GHCR publish ownership', () => {
  it('public publish-image logs in and pushes the official image', () => {
    assert.match(publicWf, /docker\/login-action/)
    assert.match(publicWf, /push:\s*true/)
    assert.match(publicWf, /ghcr\.io\/stanislavmandrik621\/aitomation-teamspace-bridge/)
    assert.match(publicWf, /Official GHCR publisher/)
  })

  it('monorepo workflow smoke-builds and never docker-pushes', (t) => {
    if (!existsSync(monoWfPath)) {
      t.skip('monorepo workflow not in this tree')
      return
    }
    const mono = readFileSync(monoWfPath, 'utf8')
    assert.match(mono, /push:\s*false/)
    assert.match(mono, /build image \(no push\)/)
    assert.equal(mono.includes('docker/login-action'), false)
    assert.equal(/needs:\s*\[docker/.test(mono), false)
    assert.match(mono, /PUBLIC_IMAGE_TAG/)
    assert.match(mono, /BRG-058/)
  })

  it('sync script can stamp a public vX.Y.Z tag without a registry push', (t) => {
    if (!existsSync(syncScriptPath)) {
      t.skip('sync script not in this tree')
      return
    }
    const sync = readFileSync(syncScriptPath, 'utf8')
    assert.match(sync, /PUBLIC_IMAGE_TAG/)
    assert.match(sync, /refs\/tags\/\$\{PUBLIC_IMAGE_TAG\}/)
    assert.equal(sync.includes('docker push'), false)
    assert.equal(sync.includes('ghcr.io'), false)
  })
})
