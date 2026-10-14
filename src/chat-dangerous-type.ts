/**
 * SEC-CHAT-11: dangerous attachment type policy (extension + magic sniff).
 * enabled-without-engine = refuse attach (never silent pass).
 */

import { capStr } from './text-cap.js'

const DANGEROUS_EXT = new Set([
  'exe', 'bat', 'cmd', 'com', 'scr', 'msi', 'msp', 'msu',
  'dll', 'sys', 'drv', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh',
  'ps1', 'psm1', 'psd1', 'ps1xml', 'psc1',
  'sh', 'bash', 'zsh', 'csh', 'ksh',
  'apk', 'app', 'dmg', 'pkg', 'deb', 'rpm',
  'jar', 'war', 'ear',
  'hta', 'cpl', 'inf', 'reg', 'lnk', 'url',
  'iso', 'img', 'vhd', 'vhdx',
  'php', 'asp', 'aspx', 'cgi', 'pl', 'py', 'rb',
])

const ALLOWED_IMAGE = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif'])
const ALLOWED_DOC = new Set(['pdf', 'txt', 'md', 'csv', 'json', 'docx', 'xlsx', 'pptx'])
// TCC-R1144-MEDIA-006: keep ALLOWED_MEDIA aligned with isAudioMime / voice-engine
// (ogg/aac/opus) so paste/voice extensions are not refuse-then-octet-stream.
const ALLOWED_MEDIA = new Set(['mp3', 'wav', 'm4a', 'mp4', 'webm', 'mov', 'ogg', 'aac', 'opus'])

/** TCC-R1144-MEDIA-005: real mime for media/docs - never collapse audio/video to octet-stream. */
function mimeHintForExt(ext: string): string {
  if (ALLOWED_IMAGE.has(ext)) return `image/${ext === 'jpg' ? 'jpeg' : ext}`
  if (ext === 'pdf') return 'application/pdf'
  if (ext === 'txt' || ext === 'md' || ext === 'csv' || ext === 'json') return 'text/plain'
  if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  if (ext === 'xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  if (ext === 'pptx') return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  if (ext === 'mp3') return 'audio/mpeg'
  if (ext === 'wav') return 'audio/wav'
  if (ext === 'm4a' || ext === 'aac') return 'audio/mp4'
  if (ext === 'opus') return 'audio/opus'
  if (ext === 'ogg') return 'audio/ogg'
  if (ext === 'webm') return 'audio/webm'
  if (ext === 'mp4') return 'video/mp4'
  if (ext === 'mov') return 'video/quicktime'
  return 'application/octet-stream'
}

export type ChatDangerVerdict =
  | { ok: true; ext: string; mimeHint: string }
  | { ok: false; reason: string }

function extOf(name: string): string {
  const base = String(name || '').replace(/\0/g, '').trim().toLowerCase()
  const i = base.lastIndexOf('.')
  if (i < 0 || i === base.length - 1) return ''
  return base.slice(i + 1).replace(/[^a-z0-9]/g, '').slice(0, 16)
}

/** Magic-byte sniff for common images/pdf; unknown binary treated as opaque. */
export function sniffChatAttachmentMagic(bytes: Uint8Array): string | null {
  if (!bytes || bytes.length < 4) return null
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  ) return 'image/png'
  if (
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
  ) return 'image/gif'
  if (
    bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'image/webp'
  if (
    bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46
  ) return 'application/pdf'
  // PE / MZ executable
  if (bytes[0] === 0x4d && bytes[1] === 0x5a) return 'application/x-msdownload'
  // ELF
  if (
    bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46
  ) return 'application/x-elf'
  // Mach-O
  if (
    (bytes[0] === 0xfe && bytes[1] === 0xed && bytes[2] === 0xfa)
    || (bytes[0] === 0xcf && bytes[1] === 0xfa && bytes[2] === 0xed && bytes[3] === 0xfe)
  ) return 'application/x-mach-binary'
  return null
}

/**
 * Optional scan hook. When TEAMSPACE_CHAT_SCAN_REQUIRED=1 and no scanner is
 * registered, attachments are refused (fail closed).
 */
let scanHook: ((bytes: Uint8Array, name: string) => Promise<{ clean: boolean; reason?: string }>) | null = null

export function setChatAttachmentScanHook(
  hook: ((bytes: Uint8Array, name: string) => Promise<{ clean: boolean; reason?: string }>) | null,
): void {
  scanHook = hook
}

export function chatScanRequired(): boolean {
  return String(process.env.TEAMSPACE_CHAT_SCAN_REQUIRED || '').trim() === '1'
}

export function evaluateChatAttachment(
  filename: string,
  bytes: Uint8Array | null,
): ChatDangerVerdict {
  const ext = extOf(filename)
  if (!ext) {
    return { ok: false, reason: 'File name needs a safe extension' }
  }
  if (DANGEROUS_EXT.has(ext)) {
    return { ok: false, reason: 'That file type is not allowed in Team chat' }
  }
  const allowed = ALLOWED_IMAGE.has(ext) || ALLOWED_DOC.has(ext) || ALLOWED_MEDIA.has(ext)
  if (!allowed) {
    return { ok: false, reason: 'That file type is not allowed in Team chat' }
  }
  if (bytes && bytes.length > 0) {
    const magic = sniffChatAttachmentMagic(bytes)
    if (magic === 'application/x-msdownload'
      || magic === 'application/x-elf'
      || magic === 'application/x-mach-binary') {
      return { ok: false, reason: 'That file looks like a program and cannot be attached' }
    }
    if (ALLOWED_IMAGE.has(ext) && magic && !magic.startsWith('image/')) {
      return { ok: false, reason: 'File contents do not match the image extension' }
    }
    if (ext === 'pdf' && magic && magic !== 'application/pdf') {
      return { ok: false, reason: 'File contents do not match a PDF' }
    }
  }
  return { ok: true, ext, mimeHint: mimeHintForExt(ext) }
}

export async function runChatAttachmentScan(
  bytes: Uint8Array,
  name: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (chatScanRequired() && !scanHook) {
    return {
      ok: false,
      reason: 'Attachment scanning is required on this server but no scanner is configured',
    }
  }
  if (!scanHook) return { ok: true }
  try {
    const res = await scanHook(bytes, name)
    if (!res || res.clean !== true) {
      return { ok: false, reason: res?.reason || 'Attachment failed the safety scan' }
    }
    return { ok: true }
  } catch {
    return { ok: false, reason: 'Attachment safety scan failed' }
  }
}

const CHAT_ATTACH_NAME_MAX = 180

/**
 * Sanitize display filename (SEC-CHAT-11).
 * Cap the stem; keep a trailing extension so a CJK/emoji name just over
 * 180 units does not become a different type (`notes.pd` from `notes.pdf`).
 */
export function sanitizeChatAttachmentName(name: string): string {
  const cleaned = String(name || '').replace(/\0/g, '').trim()
  if (!cleaned) return 'file'
  const slash = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'))
  const just = slash >= 0 ? cleaned.slice(slash + 1) : cleaned
  const dot = just.lastIndexOf('.')
  let stem = just
  let ext = ''
  if (dot > 0 && dot < just.length - 1) {
    const extRaw = just.slice(dot + 1).replace(/[^a-zA-Z0-9]/g, '')
    if (extRaw && extRaw.length <= 16) {
      ext = `.${extRaw.toLowerCase()}`
      stem = just.slice(0, dot)
    }
  }
  const stemClean = stem.replace(/[/\\]/g, '_').replace(/^\.+/, '').replace(/\s+/g, ' ')
  const budget = Math.max(1, CHAT_ATTACH_NAME_MAX - ext.length)
  const cappedStem = capStr(stemClean, budget)
  return capStr(`${cappedStem || 'file'}${ext}`, CHAT_ATTACH_NAME_MAX) || 'file'
}
