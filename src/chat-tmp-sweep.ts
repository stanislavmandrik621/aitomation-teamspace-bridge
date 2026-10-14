/**
 * TCC-R1134-CHAT-021: boot-time crash-recovery sweep for Team chat's
 * temp-file-then-rename writes.
 *
 * Every chat store (`chat-room-history-store.ts`, `chat-rooms-store.ts`,
 * `chat-unread-store.ts`, `chat-blob-registry.ts`, `chat-meta-store.ts`,
 * `chat-avatar-store.ts`) writes durable state via `writeFileSync(tmp, ...)`
 * then `renameSync(tmp, dest)` - safe against a crash landing before the
 * rename (the real file is untouched), but a crash landing AFTER
 * `writeFileSync` and BEFORE `renameSync` leaves the `tmp`/`.part` file
 * behind forever: nothing ever names it again, and no existing GC sweep
 * matches it (blob/avatar GC only match a bare 64-hex-char sha filename,
 * `chat-room-history-store.ts` has no GC at all for its own tmp files). Left
 * unswept, these orphans accumulate on every crash and silently eat disk -
 * for files under `chat/rooms/**`, they even count against the user's "chat
 * history storage" quota with no way to reclaim the space short of a manual
 * file-system dig. `TeamBackupStore.cleanupPartials()` already established
 * this exact "boot-time crash-recovery sweep" pattern for P6 backups; this
 * is the same pattern applied to the Team chat data tree.
 *
 * Bounded (`MAX_ENTRIES_VISITED`) so a pathologically large chat tree cannot
 * turn a boot-time sweep into an unbounded synchronous walk.
 *
 * Server also calls this hourly. Live writers name temps `*.${pid}.*`, so the
 * sweep skips this process's own pid. `existsSync` is not the missing-folder
 * probe (EACCES looks like absent).
 */

import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { invalidateChatFilesBytesCache } from './chat-disk-quota.js'

const MAX_ENTRIES_VISITED = 200_000
const MAX_DEPTH = 8

function isFsMissing(err: unknown): boolean {
  return Boolean(
    err
    && typeof err === 'object'
    && 'code' in err
    && (err as { code: unknown }).code === 'ENOENT',
  )
}

function isOrphanTempFile(name: string): boolean {
  // `.encpart` / `.decpart` end in `.part`. Store's encrypt dest is `*.tsb1`
  // (G5-pipe) and does not end in `.part` - a crash between encrypt rename
  // and the follow-up rename leaves that file forever unless we match it.
  return name.endsWith('.tmp') || name.endsWith('.part') || name.endsWith('.tsb1')
}

/**
 * Live write-then-rename names are `*.${pid}.*`. Hourly sweep (not just boot)
 * must skip this process's own temps or it unlinks a file still being written.
 */
export function isThisProcessTempName(name: string): boolean {
  const pid = String(process.pid || '')
  if (!pid) return false
  return name.includes(`.${pid}.`)
}

function sweepOrphanTemps(
  root: string,
  maxDepth: number,
  budget: { visited: number },
): number {
  try {
    const st = statSync(root)
    if (!st.isDirectory()) return 0
  } catch (err) {
    if (isFsMissing(err)) return 0
    const detail = err instanceof Error ? err.message : 'unreadable'
    console.warn(`[bridge] tmp sweep skipped unreadable folder (${detail})`)
    return 0
  }
  let removed = 0
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  while (stack.length > 0 && budget.visited < MAX_ENTRIES_VISITED) {
    const next = stack.pop()
    if (!next) break
    let names: string[] = []
    try {
      names = readdirSync(next.dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (budget.visited >= MAX_ENTRIES_VISITED) break
      budget.visited += 1
      const full = join(next.dir, name)
      let isDir = false
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        continue
      }
      if (isDir) {
        if (next.depth < maxDepth) stack.push({ dir: full, depth: next.depth + 1 })
        continue
      }
      if (!isOrphanTempFile(name)) continue
      if (isThisProcessTempName(name)) continue
      try {
        unlinkSync(full)
        removed += 1
      } catch {
        /* best-effort - a concurrent process may have already removed it */
      }
    }
  }
  return removed
}

/**
 * Remove crash-leftover `*.tmp` / `*.part` (and `.encpart` / `.decpart`, which
 * end in `.part`) plus G5-pipe `*.tsb1` under `chat/` and CRM `blobs/`. Skips
 * this-process pid temps so the hourly caller cannot unlink a live write. Boot
 * still clears leftovers from a previous pid. After a real chat/rooms remove,
 * drop the 2s history bytes cache (BRG-069).
 */
export function cleanupChatTmpFiles(dataDir: string): number {
  // Separate visit budgets. Sharing one counter let a huge chat/ tree
  // exhaust MAX_ENTRIES_VISITED and skip CRM `blobs/*.tsb1` leftovers.
  const chatRemoved = sweepOrphanTemps(join(dataDir, 'chat'), MAX_DEPTH, { visited: 0 })
  const crmRemoved = sweepOrphanTemps(join(dataDir, 'blobs'), 1, { visited: 0 })
  if (chatRemoved > 0) invalidateChatFilesBytesCache(dataDir)
  return chatRemoved + crmRemoved
}
