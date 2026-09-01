/**
 * Chat tree paths included in team-server backup / export walks.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Relative paths under TEAMSPACE_DATA_DIR that must survive team backup. */
export const CHAT_BACKUP_TOP_LEVEL = [
  'chat/rooms.json',
  'chat/unread.json',
  'chat/blob-registry.json',
  'chat/_meta.json',
] as const

/** Default file ceiling for chat/ walks (admin export.zip + ops). */
export const CHAT_BACKUP_MAX_FILES = 50_000

export function chatBackupRoot(dataDir: string): string {
  return join(dataDir, 'chat')
}

/** Enumerate every file under chat/ for zip/export (bounded depth). */
export function enumerateChatBackupFiles(
  dataDir: string,
  maxFiles = CHAT_BACKUP_MAX_FILES,
): string[] {
  return listChatBackupZipEntries(dataDir, maxFiles).files
}

/**
 * Absolute zip entries for live `chat/` under dataDir.
 * `truncated` is true when the walk hit maxFiles (more files may exist on disk).
 */
export function listChatBackupZipEntries(
  dataDir: string,
  maxFiles = CHAT_BACKUP_MAX_FILES,
): {
  files: string[]
  entries: Array<{ name: string; size: number; absolutePath: string }>
  truncated: boolean
} {
  const root = chatBackupRoot(dataDir)
  const files: string[] = []
  const entries: Array<{ name: string; size: number; absolutePath: string }> = []
  if (!existsSync(root)) {
    return { files, entries, truncated: false }
  }
  const seen = new Set<string>()
  // TCC-R1132-BKP-001: pin the must-survive top-level metadata files FIRST,
  // outside the maxFiles/depth cap below. `readdirSync` order is
  // OS/filesystem-dependent (not guaranteed alphabetical), so a large
  // attachment fan-out under chat/rooms/ can otherwise fill the cap before
  // the walk ever reaches rooms.json / unread.json / blob-registry.json /
  // _meta.json at the root. These are small, bounded JSON files - reserving them
  // ahead of the cap can never meaningfully starve room-file budget.
  for (const relEntry of CHAT_BACKUP_TOP_LEVEL) {
    const abs = join(dataDir, relEntry)
    let st
    try {
      st = statSync(abs)
    } catch {
      continue
    }
    if (!st.isFile() || seen.has(relEntry)) continue
    seen.add(relEntry)
    files.push(relEntry)
    entries.push({
      name: relEntry,
      size: Number.isFinite(st.size) ? st.size : 0,
      absolutePath: abs,
    })
  }
  let truncated = false
  const walk = (dir: string, rel: string, depth: number): void => {
    if (files.length >= maxFiles || depth > 14) {
      if (files.length >= maxFiles) truncated = true
      return
    }
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (!name || name === '.' || name === '..') continue
      if (files.length >= maxFiles) {
        truncated = true
        return
      }
      const abs = join(dir, name)
      const relPath = rel ? `${rel}/${name}` : name
      let st
      try {
        st = statSync(abs)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(abs, relPath, depth + 1)
      else if (st.isFile()) {
        const nameZip = `chat/${relPath}`
        if (seen.has(nameZip)) continue
        seen.add(nameZip)
        files.push(nameZip)
        entries.push({
          name: nameZip,
          size: Number.isFinite(st.size) ? st.size : 0,
          absolutePath: abs,
        })
      }
    }
  }
  walk(root, '', 0)
  return { files, entries, truncated }
}
