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
 */

import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const MAX_ENTRIES_VISITED = 200_000
const MAX_DEPTH = 8

function isOrphanTempFile(name: string): boolean {
  return name.endsWith('.tmp') || name.endsWith('.part')
}

/**
 * Recursively remove every `*.tmp` / `*.part` file under `chat/` left behind
 * by an interrupted write-then-rename. Call once at bridge boot, before any
 * chat store starts handling live requests, so there is no risk of deleting
 * a tmp file that a THIS-process write is still in the middle of producing.
 */
export function cleanupChatTmpFiles(dataDir: string): number {
  const chatRoot = join(dataDir, 'chat')
  if (!existsSync(chatRoot)) return 0
  let removed = 0
  let visited = 0
  const stack: Array<{ dir: string; depth: number }> = [{ dir: chatRoot, depth: 0 }]
  while (stack.length > 0 && visited < MAX_ENTRIES_VISITED) {
    const next = stack.pop()
    if (!next) break
    let names: string[] = []
    try {
      names = readdirSync(next.dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (visited >= MAX_ENTRIES_VISITED) break
      visited += 1
      const full = join(next.dir, name)
      let isDir = false
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        continue
      }
      if (isDir) {
        if (next.depth < MAX_DEPTH) stack.push({ dir: full, depth: next.depth + 1 })
        continue
      }
      if (!isOrphanTempFile(name)) continue
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
