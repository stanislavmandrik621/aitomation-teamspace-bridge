import assert from 'node:assert/strict'
import { fork, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'bridge-aged-lock-'))
const childPath = new URL('./fixtures/data-dir-lock-child.ts', import.meta.url)
const owner = fork(childPath, [dir, 'hold'], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
try {
  await Promise.race([once(owner, 'message'), new Promise((_, reject) => { const t = setTimeout(() => reject(new Error('lock child timeout')), 10000); t.unref() })])
  const path = join(dir, '.bridge.lock')
  const liveLock = JSON.parse(readFileSync(path, 'utf8'))
  writeFileSync(path, JSON.stringify({ ...liveLock, startedAt: Date.now() - 365 * 86400000 }))
  const contender = spawnSync(process.execPath, ['--import', 'tsx', childPath.pathname, dir], { encoding: 'utf8', timeout: 10000 })
  assert.equal(contender.status, 2, contender.stderr)
  assert.match(contender.stdout, /already using/)
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, owner.pid, 'live owner lock never replaced')
  const exited = once(owner, 'exit'); owner.kill('SIGKILL'); await exited
  const recovery = spawnSync(process.execPath, ['--import', 'tsx', childPath.pathname, dir], { encoding: 'utf8', timeout: 10000 })
  assert.equal(recovery.status, 0, recovery.stderr)
  console.log('aged data-dir lock runtime: second process refused after one-year uptime; dead-owner SIGKILL recovery passed')
} finally {
  if (owner.exitCode === null && owner.signalCode === null) { const exited = once(owner, 'exit'); owner.kill('SIGKILL'); await exited }
  rmSync(dir, { recursive: true, force: true })
}
