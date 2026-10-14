/**
 * TS-BRG-011: exclusive data-dir lock behavior.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireBridgeDataDirLock } from '../src/data-dir-lock.js'

function must(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}

const dir = mkdtempSync(join(tmpdir(), 'bridge-lock-test-'))

try {
  const first = acquireBridgeDataDirLock(dir)
  must(first.ok === true, 'first acquire ok')
  if (!first.ok) throw new Error('unreachable')

  const second = acquireBridgeDataDirLock(dir)
  must(second.ok === false, 'second acquire blocked')
  if (second.ok) throw new Error('unreachable')
  must(second.reason.includes('already using'), 'plain English block reason')

  first.release()

  const third = acquireBridgeDataDirLock(dir)
  must(third.ok === true, 're-acquire after release')
  if (third.ok) third.release()

  /**
   * TCC-R1134-BRG-003: acquireBridgeDataDirLock() used to register its own
   * `process.once('SIGINT'/'SIGTERM', () => { release(); process.exit(N) })`
   * listeners. Since server.ts calls this near the TOP of the module
   * (before its own graceful-shutdown SIGTERM/SIGINT handler is registered
   * near the bottom), this module's listener always ran FIRST and called
   * `process.exit()` synchronously - which never returns, so server.ts's
   * graceful drain listener (registered second, same event) would never
   * fire on a real SIGTERM/SIGINT. Pin that this module never touches
   * SIGINT/SIGTERM at all - lock release must flow ONLY through the
   * `process.once('exit', ...)` listener, which fires for every exit path
   * (including a caller's own `process.exit()` after a graceful drain)
   * without racing a second listener on the same signal.
   */
  const fourth = acquireBridgeDataDirLock(dir)
  must(fourth.ok === true, 'fourth acquire ok (SIGTERM/SIGINT pin setup)')
  if (fourth.ok) {
    must(process.listenerCount('SIGTERM') === 0, 'data-dir-lock must not register a SIGTERM listener')
    must(process.listenerCount('SIGINT') === 0, 'data-dir-lock must not register an SIGINT listener')
    fourth.release()
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('bridge data-dir-lock: ok')
