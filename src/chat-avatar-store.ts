/**
 * Team chat profile avatars (TS-CHAT-013).
 * Content-addressed under chat/avatars/<sha256> - team-wide readable by any session.
 * Distinct from room-ACL chat attachment blobs (SEC-CHAT-05).
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { CHAT_AVATAR_MAX_BYTES } from './chat-room.js'
import { capStr } from './text-cap.js'
import type { AtRestKey } from './at-rest.js'
import { encryptBlobBody, decryptBlobBody } from './at-rest.js'

export function isTeamChatAvatarBlobSha(ref: string | null | undefined): boolean {
  return typeof ref === 'string' && /^[a-f0-9]{64}$/.test(ref.trim().toLowerCase())
}

export function sniffChatAvatarMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (
    bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
  ) return 'image/png'
  if (
    bytes[0] === 0x52
    && bytes[1] === 0x49
    && bytes[2] === 0x46
    && bytes[3] === 0x46
    && bytes[8] === 0x57
    && bytes[9] === 0x45
    && bytes[10] === 0x42
    && bytes[11] === 0x50
  ) return 'image/webp'
  return null
}

export class ChatAvatarStore {
  private readonly dir: string

  /** `atRest` defaults to null so existing single-arg call sites stay plaintext. */
  constructor(
    dataDir: string,
    private readonly atRest: AtRestKey | null = null,
  ) {
    this.dir = join(dataDir, 'chat', 'avatars')
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
  }

  pathFor(sha: string): string {
    return join(this.dir, sha.toLowerCase())
  }

  put(bytes: Uint8Array): { ok: true; sha256: string; mime: string; bytes: number } | { error: string } {
    if (!bytes || bytes.length === 0) return { error: 'Empty avatar' }
    if (bytes.length > CHAT_AVATAR_MAX_BYTES) {
      return { error: 'Avatar must be a JPEG, PNG, or WebP under 2 MB' }
    }
    const mime = sniffChatAvatarMime(bytes)
    if (!mime) return { error: 'Avatar must be JPEG, PNG, or WebP' }
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const dest = this.pathFor(sha256)
    if (!existsSync(dest)) {
      const tmp = `${dest}.${process.pid}.${randomBytes(4).toString('hex')}.part`
      try {
        // TCC-R1125-BRG-002: encrypt avatar bytes at rest (content-address stays
        // over the plaintext sha so dedupe is unaffected by the random IV).
        const onDisk = this.atRest ? encryptBlobBody(this.atRest, Buffer.from(bytes)) : bytes
        writeFileSync(tmp, onDisk)
        renameSync(tmp, dest)
      } catch (err) {
        try { unlinkSync(tmp) } catch { /* */ }
        return {
          error: err instanceof Error ? capStr(err.message, 200) : 'Could not store avatar',
        }
      }
    }
    return { ok: true, sha256, mime, bytes: bytes.length }
  }

  get(sha: string): { bytes: Buffer; mime: string } | null {
    const id = String(sha || '').toLowerCase().trim()
    if (!isTeamChatAvatarBlobSha(id)) return null
    const p = this.pathFor(id)
    if (!existsSync(p)) return null
    try {
      const onDisk = readFileSync(p)
      const bytes = decryptBlobBody(this.atRest, onDisk)
      if (bytes.length === 0 || bytes.length > CHAT_AVATAR_MAX_BYTES) return null
      const mime = sniffChatAvatarMime(bytes) || 'application/octet-stream'
      return { bytes, mime }
    } catch {
      return null
    }
  }

  /**
   * Drop avatar files not referenced by any live member avatarRef (TS-CHAT-014).
   * Age gate avoids racing a put that has not yet stamped the member row.
   */
  gc(
    keepShas: ReadonlySet<string>,
    maxAgeMs = 7 * 24 * 60 * 60 * 1000,
  ): { removedFiles: number } {
    let removedFiles = 0
    const now = Date.now()
    const ageMs = Number.isFinite(maxAgeMs) && maxAgeMs >= 0 ? maxAgeMs : 7 * 24 * 60 * 60 * 1000
    const keep = new Set<string>()
    for (const raw of keepShas) {
      const id = String(raw || '').toLowerCase().trim()
      if (isTeamChatAvatarBlobSha(id)) keep.add(id)
    }
    try {
      for (const name of readdirSync(this.dir)) {
        if (!/^[a-f0-9]{64}$/.test(name)) continue
        if (keep.has(name)) continue
        const p = join(this.dir, name)
        try {
          const st = statSync(p)
          if (now - st.mtimeMs > ageMs) {
            unlinkSync(p)
            removedFiles += 1
          }
        } catch { /* */ }
      }
    } catch { /* */ }
    return { removedFiles }
  }
}
