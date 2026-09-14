import assert from 'node:assert/strict'
import { createServer, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createClamavScanner, configureLocalAttachmentScanner } from '../src/attachment-clamav.js'
import { runChatAttachmentScan, setChatAttachmentScanHook } from '../src/chat-dangerous-type.js'
import { ChatBlobRegistry, CHAT_BLOB_UPLOAD_AUTH_REVOKED, chatBlobRoomIds } from '../src/chat-blob-registry.js'

// Protocol regression harness, not an antivirus substitute. It exercises real
// local sockets, framing, errors, deadlines and concurrency without provider IO.
const dir = await mkdtemp('/tmp/aitomation-clam-')
const socketPath = join(dir, 'scan.sock')
const sockets = new Set<Socket>()
let response: string | null = 'stream: OK\0'
let onStream: (() => void) | undefined
const seen: Buffer[] = []
const server = createServer(socket => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket))
  let pending = Buffer.alloc(0), header = false
  const parts: Buffer[] = []
  socket.on('data', bytes => {
    pending = Buffer.concat([pending, bytes])
    if (!header) {
      if (pending.length < 10) return
      assert.equal(pending.subarray(0, 10).toString(), 'zINSTREAM\0')
      pending = pending.subarray(10); header = true
    }
    while (pending.length >= 4) {
      const size = pending.readUInt32BE(0)
      if (pending.length < size + 4) return
      parts.push(pending.subarray(4, 4 + size)); pending = pending.subarray(4 + size)
      if (!size) { seen.push(Buffer.concat(parts)); onStream?.(); if (response !== null) socket.end(response); return }
    }
  })
})
try {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
  const scan = createClamavScanner({ socketPath, maxBytes: 1024 * 1024, timeoutMs: 200, maxConcurrent: 1 })
  const bytes = Buffer.alloc(130_000, 47)
  assert.deepEqual(await scan(bytes), { clean: true })
  assert.deepEqual(seen[0], bytes)
  for (const answer of ['stream: Test.Signature FOUND\0', 'stream: size limit ERROR\0', 'stream: OK', 'stream: OK\0stream: ERROR\0']) {
    response = answer; assert.equal((await scan(Buffer.from('file'))).clean, false)
  }
  response = null
  const stalled = scan(Buffer.from('file'))
  assert.match((await scan(Buffer.from('second'))).reason || '', /busy/)
  assert.match((await stalled).reason || '', /timed out/)
  assert.equal((await scan(Buffer.alloc(1024 * 1024 + 1))).clean, false)
  assert.throws(() => createClamavScanner({ socketPath: 'https://scanner.example' }))
  configureLocalAttachmentScanner({ TEAMSPACE_CLAMAV_SOCKET: 'invalid' })
  assert.equal((await runChatAttachmentScan(Buffer.from('file'), 'file.txt')).ok, false)
  const unavailable = createClamavScanner({ socketPath: join(dir, 'missing.sock'), timeoutMs: 200 })
  assert.equal((await unavailable(Buffer.from('file'))).clean, false)
  console.log('PASS ClamAV local-socket protocol, exact verdict, limits, deadlines and fail-closed configuration')
  response = 'stream: OK\0'
  setChatAttachmentScanHook(createClamavScanner({ socketPath, timeoutMs: 2000 }))
  const registry = new ChatBlobRegistry(join(dir, 'registry'), null)
  const upload = { roomId: 'chat:team', uploadedBy: 'member1', filename: 'note.txt', bytes: Buffer.from('scan before publication') }
  const stored = await registry.registerUpload(upload)
  assert.ok(!('error' in stored))
  response = 'stream: Changed.Signature FOUND\0'
  const duplicate = await registry.registerUpload({ ...upload, roomId: 'chat:dm:alice_bob' })
  assert.ok('error' in duplicate, 'deduplicated upload must obey the current scanner verdict')
  assert.match(duplicate.error, /malware scanner/)
  assert.deepEqual(chatBlobRoomIds(registry.get(stored.sha256)!), ['chat:team'], 'refused duplicate cannot grant another room access')
  response = 'stream: OK\0'
  let authorized = true
  onStream = () => { authorized = false }
  assert.deepEqual(await registry.registerUpload({ ...upload, roomId: 'chat:dm:alice_bob', authorize: () => authorized }), { error: CHAT_BLOB_UPLOAD_AUTH_REVOKED })
  assert.deepEqual(chatBlobRoomIds(registry.get(stored.sha256)!), ['chat:team'], 'authorization must survive the scan await')
  onStream = undefined
  console.log('PASS real blob registry scans duplicate exposure and rechecks authorization after socket scanning')
  if (process.env.TEST_CLAMAV_SOCKET) {
    const real = createClamavScanner({ socketPath: process.env.TEST_CLAMAV_SOCKET })
    assert.equal((await real(Buffer.from('Plain text scan integration test.'))).clean, true)
    const eicar = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join('')
    assert.equal((await real(Buffer.from(eicar))).clean, false)
    console.log('PASS real configured ClamAV clean-text and EICAR detection')
  } else console.log('NOT RUN real antivirus detection: TEST_CLAMAV_SOCKET is not configured')
} finally {
  setChatAttachmentScanHook(null)
  for (const socket of sockets) socket.destroy()
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
}
