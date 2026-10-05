/**
 * Chat tree paths included in team-server backup / export walks.
 */

import { existsSync, readdirSync, lstatSync } from 'node:fs'
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
  authorityDir = dataDir,
): {
  files: string[]
  entries: Array<{ name: string; size: number; absolutePath: string }>
  truncated: boolean
} {
  const root = chatBackupRoot(dataDir)
  const files: string[] = []
  const entries: Array<{ name: string; size: number; absolutePath: string }> = []
  const hasRoot=existsSync(root)
  if (hasRoot&&!lstatSync(root).isDirectory()) throw new Error('Chat backup root must be a real directory')
  const seen = new Set<string>()
  // TCC-R1132-BKP-001: pin the must-survive top-level metadata files FIRST,
  // outside the maxFiles/depth cap below. `readdirSync` order is
  // OS/filesystem-dependent (not guaranteed alphabetical), so a large
  // attachment fan-out under chat/rooms/ can otherwise fill the cap before
  // the walk ever reaches rooms.json / unread.json / blob-registry.json /
  // _meta.json at the root. These are small, bounded JSON files - reserving them
  // ahead of the cap can never meaningfully starve room-file budget.
  for (const relEntry of CHAT_BACKUP_TOP_LEVEL) {
    // An old /data copy of rooms.json is never substituted for current room
    // membership retained outside the rollback directory.
    seen.add(relEntry)
    const abs = join(relEntry==='chat/rooms.json'?authorityDir:dataDir, relEntry)
    let st
    try {
      st = lstatSync(abs)
    } catch {
      continue
    }
    if (!st.isFile()) continue
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
      if (/\.(?:tmp|part|rewrite)(?:\.|$)/.test(name)) continue
      if (files.length >= maxFiles) {
        truncated = true
        return
      }
      const abs = join(dir, name)
      const relPath = rel ? `${rel}/${name}` : name
      let st
      try {
        st = lstatSync(abs)
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
  if(hasRoot)walk(root, '', 0)
  return { files, entries, truncated }
}
