import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { BridgeStore } from '../src/store.js'
import { initializeCurrentAuthority } from '../src/independent-authority.js'
import { readCurrentBackupPermissions } from '../../../apps/desktop/electron/modules-sync/backup-permission-read.js'

const dir = mkdtempSync(join(tmpdir(), 'backup-pagination-live-'))
let child: ReturnType<typeof spawn> | undefined
try {
  const store = new BridgeStore(dir, 21, null)
  const owner = store.helloOrBootstrap({ memberId: 'owner', deviceId: 'device', displayName: 'Audit' })
  assert.ok(owner.ok)
  initializeCurrentAuthority(dir,dir+'.authority')
  const socket = createServer().listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = (socket.address() as { port: number }).port
  await new Promise<void>(resolve => socket.close(() => resolve()))
  let output = ''
  child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, TEAMSPACE_DATA_DIR: dir, TEAMSPACE_BRIDGE_HOST: '127.0.0.1', TEAMSPACE_BRIDGE_PORT: String(port), TEAMSPACE_BACKUP_TOKENS: '20' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout!.on('data', data => { output += String(data) })
  child.stderr!.on('data', data => { output += String(data) })
  const deadline = Date.now() + 15_000
  while (!output.includes('bridge listening')) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error('Isolated bridge failed to start')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  const base = `http://127.0.0.1:${port}`
  const body = JSON.stringify({ version: 1, targets: [{ kind: 'record', id: 'unknown' }] })
  const exhaust = async () => {
    for (let i = 0; i < 100; i++) {
      const response = await fetch(`${base}/v1/backups/read-scope`, { method: 'POST', headers: { authorization: `Bearer ${owner.sessionToken}`, 'content-type': 'application/json' }, body })
      await response.arrayBuffer()
      if (response.status === 429) { assert.ok(Number(response.headers.get('retry-after')) > 0); return }
      assert.equal(response.status, 200)
    }
    throw new Error('Expected the production permission rate limit')
  }
  await exhaust()
  const transport = { usedOrigin: base, sessionToken: owner.sessionToken, teamId: store.ensureTeam().teamId, memberId: owner.member.memberId }
  const started = Date.now()
  const scope = await readCurrentBackupPermissions({ transport, targets: Array.from({ length: 12_001 }, (_, i) => ({ kind: 'record', id: `unknown-${i}` })), assertCurrent() {} })
  assert.equal(scope.grants.length, 12_001)
  assert.ok(scope.grants.every(grant => grant === null), 'Unknown records never receive access while retrying')
  assert.ok(Object.isFrozen(scope.grants))
  await scope.revalidate()
  await exhaust()
  const controller = new AbortController(), cancelStarted = Date.now()
  const timer = setTimeout(() => controller.abort(new Error('Audit cancellation')), 50)
  try {
    await assert.rejects(readCurrentBackupPermissions({ transport: { ...transport, signal: controller.signal }, targets: [{ kind: 'record', id: 'unknown' }], assertCurrent() {} }), /cancel|abort/i)
  } finally { clearTimeout(timer) }
  assert.ok(Date.now() - cancelStarted < 3000, 'Rate-limit waiting must remain cancellable')
  console.log(JSON.stringify({ productionBridge: true, targets: 12_001, pages: 25, rateLimitObserved: true, revalidation: true, cancellation: true, elapsedMs: Date.now() - started }))
} finally {
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    const timer = setTimeout(() => child?.kill('SIGKILL'), 5000)
    try { await exited } finally { clearTimeout(timer) }
  }
  rmSync(dir, { recursive: true, force: true })
  rmSync(dir+'.authority', { recursive: true, force: true })
}
