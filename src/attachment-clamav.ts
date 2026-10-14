import { createConnection } from 'node:net'
import { isAbsolute } from 'node:path'
import { setChatAttachmentScanHook } from './chat-dangerous-type.js'

type Verdict = { clean: boolean; reason?: string }
export interface ClamavOptions { socketPath: string; maxBytes?: number; timeoutMs?: number; maxConcurrent?: number }

/** Local-only INSTREAM client. No shell, file paths or external scanning API.
 * Only a complete, exact OK is accepted; limits and errors fail closed. */
export function createClamavScanner(options: ClamavOptions): (bytes: Uint8Array) => Promise<Verdict> {
  const { socketPath } = options
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024
  const timeoutMs = options.timeoutMs ?? 30_000
  const maxConcurrent = options.maxConcurrent ?? 2
  if (!isAbsolute(socketPath) || socketPath.includes('\0') || Buffer.byteLength(socketPath) > 103 ||
    !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 128 * 1024 * 1024 ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000 ||
    !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) {
    throw new Error('Invalid local ClamAV configuration')
  }
  let active = 0
  return async (bytes) => {
    if (!bytes.byteLength || bytes.byteLength > maxBytes) return { clean: false, reason: 'Attachment exceeds the scanner size limit' }
    if (active >= maxConcurrent) return { clean: false, reason: 'Attachment scanner is busy; retry later' }
    active++
    try {
      return await new Promise<Verdict>((resolve) => {
        const socket = createConnection({ path: socketPath })
        let finished = false
        let submitted = false
        let reply = Buffer.alloc(0)
        const finish = (verdict: Verdict) => {
          if (finished) return
          finished = true
          clearTimeout(timer)
          socket.destroy()
          resolve(verdict)
        }
        const timer = setTimeout(() => finish({ clean: false, reason: 'Attachment scanner timed out' }), timeoutMs)
        socket.on('error', () => finish({ clean: false, reason: 'Local attachment scanner is unavailable' }))
        socket.on('data', (chunk: Buffer) => {
          if (reply.length + chunk.length > 4096) { finish({ clean: false, reason: 'Invalid scanner response' }); return }
          reply = Buffer.concat([reply, chunk])
        })
        socket.on('end', () => {
          const text = reply.toString('utf8')
          if (submitted && text === 'stream: OK\0') finish({ clean: true })
          else finish({ clean: false, reason: text.includes(' FOUND') ? 'Attachment blocked by the malware scanner' : 'Attachment could not be fully scanned' })
        })
        socket.on('close', () => finish({ clean: false, reason: 'Attachment scanner disconnected before completion' }))
        const write = (buffer: Uint8Array) => new Promise<void>((done, reject) => socket.write(buffer, (error) => error ? reject(error) : done()))
        socket.on('connect', () => {
          void (async () => {
            await write(Buffer.from('zINSTREAM\0'))
            for (let offset = 0; offset < bytes.byteLength && !finished; offset += 64 * 1024) {
              const part = bytes.subarray(offset, Math.min(bytes.byteLength, offset + 64 * 1024))
              const size = Buffer.alloc(4); size.writeUInt32BE(part.byteLength)
              await write(size)
              await write(part)
            }
            if (finished) return
            submitted = true
            await write(Buffer.alloc(4))
          })().catch(() => finish({ clean: false, reason: 'Attachment scanner transfer failed' }))
        })
      })
    } finally { active-- }
  }
}

/** Administrator-managed Unix socket. Invalid config cannot restore unsafe access. */
export function configureLocalAttachmentScanner(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.TEAMSPACE_CLAMAV_SOCKET
  if (raw === undefined || raw === '') return false
  try {
    setChatAttachmentScanHook(createClamavScanner({ socketPath: raw.trim() }))
  } catch {
    setChatAttachmentScanHook(async () => ({ clean: false, reason: 'Local attachment scanner configuration is invalid' }))
  }
  return true
}
