/**
 * TS-BRG-011: exclusive lock for TEAMSPACE_DATA_DIR so two bridge processes
 * cannot corrupt the same file-backed store.
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'

const LOCK_NAME = '.bridge.lock'
const MAX_STALE_MS = 7 * 24 * 60 * 60 * 1000

type LockPayload = { pid: number; startedAt: number }

function readLockPayload(lockPath: string): LockPayload | null {
  try {
    const raw = readFileSync(lockPath, 'utf8').trim()
    if (!raw) return null
    const parsed = JSON.parse(raw) as LockPayload
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const pid = typeof parsed.pid === 'number' ? parsed.pid : NaN
    const startedAt = typeof parsed.startedAt === 'number' ? parsed.startedAt : NaN
    if (!Number.isFinite(pid) || !Number.isFinite(startedAt)) return null
    return { pid: Math.floor(pid), startedAt }
  } catch {
    return null
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err: unknown) {
    const code = err && typeof err === 'object' && 'code' in err
      ? String((err as NodeJS.ErrnoException).code)
      : ''
    return code === 'EPERM'
  }
}

function lockLooksStale(payload: LockPayload | null): boolean {
  if (!payload) return true
  if (!isPidAlive(payload.pid)) return true
  return Date.now() - payload.startedAt > MAX_STALE_MS
}

function removeLockFile(lockPath: string): void {
  try {
    unlinkSync(lockPath)
  } catch (err: unknown) {
    const code = err && typeof err === 'object' && 'code' in err
      ? String((err as NodeJS.ErrnoException).code)
      : ''
    if (code === 'ENOENT') return
  }
}

export type BridgeDataDirLock =
  | { ok: true; release: () => void }
  | { ok: false; reason: string }

/**
 * Acquire an exclusive lock under `root/.bridge.lock`.
 * Keeps the fd open until `release()` so the lock survives for process lifetime.
 */
export function acquireBridgeDataDirLock(root: string): BridgeDataDirLock {
  mkdirSync(root, { recursive: true })
  const lockPath = join(root, LOCK_NAME)

  const tryOnce = (): number => {
    return openSync(lockPath, 'wx')
  }

  let fd: number
  try {
    fd = tryOnce()
  } catch (err: unknown) {
    const code = err && typeof err === 'object' && 'code' in err
      ? String((err as NodeJS.ErrnoException).code)
      : ''
    if (code !== 'EEXIST') {
      return {
        ok: false,
        reason: err instanceof Error ? err.message.slice(0, 200) : 'Could not lock data directory',
      }
    }
    const payload = readLockPayload(lockPath)
    if (!lockLooksStale(payload)) {
      const holder = payload?.pid ?? 'unknown'
      return {
        ok: false,
        reason: `Another Team Space server is already using this data folder (pid ${holder}). Stop it first or pick a different TEAMSPACE_DATA_DIR.`,
      }
    }
    removeLockFile(lockPath)
    try {
      fd = tryOnce()
    } catch (retryErr: unknown) {
      return {
        ok: false,
        reason: retryErr instanceof Error
          ? retryErr.message.slice(0, 200)
          : 'Could not lock data directory after clearing a stale lock',
      }
    }
  }

  const payload: LockPayload = { pid: process.pid, startedAt: Date.now() }
  writeSync(fd, JSON.stringify(payload), 0, 'utf8')

  let released = false
  const release = (): void => {
    if (released) return
    released = true
    try { closeSync(fd) } catch { /* */ }
    removeLockFile(lockPath)
  }

  /**
   * TCC-R1134-BRG-003: this module used to ALSO register its own
   * `process.once('SIGINT'/'SIGTERM', () => { release(); process.exit(N) })`
   * listeners. Node invokes every listener registered for a given signal
   * SYNCHRONOUSLY, in registration order - and `acquireBridgeDataDirLock()`
   * runs near the TOP of `server.ts` (before the WS/HTTP servers exist),
   * so this module's SIGTERM/SIGINT listener was always registered FIRST.
   * Once `server.ts` gained its own graceful-shutdown SIGTERM/SIGINT
   * handler (TCC-R1134-BRG-002, registered much later at module bottom),
   * a real SIGTERM would hit THIS listener first, which called
   * `process.exit(143)` immediately - `process.exit()` terminates the
   * process synchronously and never returns, so the second (graceful)
   * listener registered by server.ts would NEVER run. Every routine
   * restart (systemctl/Docker/PM2 stop, `Ctrl+C`) would silently skip the
   * connection-draining logic entirely and hard-reset every live WS
   * client, exactly the failure TCC-R1134-BRG-002 exists to prevent -
   * two independent, uncoordinated exit paths on the same signal is a
   * last-registered-loses-silently bug class.
   *
   * Fix: this module no longer touches SIGINT/SIGTERM at all. The 'exit'
   * listener below is the ONLY thing releasing the lock, and it covers
   * every real exit path uniformly - Node emits 'exit' synchronously
   * whenever `process.exit()` runs (graceful shutdown's `process.exit(0)`,
   * the uncaughtException/unhandledRejection handlers' `process.exit(1)`,
   * or a bare process exit) - so lock release still always happens
   * exactly once, but the ONE process now fully owns deciding whether
   * (and how) to drain before exiting.
   */
  const onExit = (): void => { release() }
  process.once('exit', onExit)

  return { ok: true, release }
}
