import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, mkdirSync, symlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable, PassThrough } from 'node:stream'
import { TeamBackupStore } from '../src/backup-store.js'
import { listChatBackupZipEntries } from '../src/chat-backup-paths.js'

const root = mkdtempSync(join(tmpdir(), 'backup-concurrency-'))
const memberId = 'alice'
const data = Buffer.from('last-known-good')
const store = new TeamBackupStore(root)
store.setMeta({ minIntervalMs: 0, maxKeepPerMember: 1 })
const put = (body = data, extra = {}) => store.putSnapshotFromStream({ memberId, stream: Readable.from([body]), contentLength: body.length, ...extra })
const requireOk = <T extends { ok: boolean }>(result: T) => { assert.equal(result.ok, true, JSON.stringify(result)); return result as Extract<T, { ok: true }> }
try {
  const first = requireOk(await put())
  const opened = await store.openSnapshotRead(memberId, first.snapshot.id)
  assert.ok(opened)
  assert.ok(typeof (opened.stream as any).fd === 'number', 'download owns an open descriptor before releasing member lock')
  requireOk(await store.deleteSnapshot(memberId, first.snapshot.id))
  const chunks: Buffer[] = []
  for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk))
  assert.deepEqual(Buffer.concat(chunks), data, 'a concurrent delete cannot break an admitted download')

  const good = requireOk(await put())
  const originalWrite = (store as any).writeIndex.bind(store)
  let writes = 0
  ;(store as any).writeIndex = (...args: any[]) => {
    if (++writes === 2) throw new Error('injected second index write failure')
    return originalWrite(...args)
  }
  const newest = requireOk(await put(Buffer.from('replacement')))
  assert.equal(writes, 1, 'retention and new snapshot commit use one atomic index update')
  assert.equal(store.listForMember(memberId)[0]!.id, newest.snapshot.id)
  ;(store as any).writeIndex = () => { throw new Error('injected index write failure') }
  const failedDelete = await store.deleteSnapshot(memberId, newest.snapshot.id)
  assert.equal(failedDelete.ok, false)
  assert.ok(await store.openSnapshotRead(memberId, newest.snapshot.id).then(read => { read?.stream.destroy(); return read }))
  assert.equal((await put(Buffer.from('must-not-delete-good'))).ok, false)
  ;(store as any).writeIndex = originalWrite
  assert.equal(store.listForMember(memberId)[0]!.id, newest.snapshot.id)

  const indexPath = join(root, 'backups/members/alice/index.json')
  const index = readFileSync(indexPath)
  writeFileSync(indexPath, '{torn')
  assert.equal((await put()).ok, false, 'corrupt index must not become an empty successful write')
  assert.equal(readFileSync(indexPath, 'utf8'), '{torn')
  writeFileSync(indexPath, index)

  ;(store as any).writeIndex = (...args: any[]) => {
    originalWrite(...args)
    throw new Error('injected directory fsync failure after index rename')
  }
  const uncertainCommit = await store.putSnapshotFromStream({ memberId: 'post-rename', contentLength: 4, stream: Readable.from(['safe']) })
  assert.equal(uncertainCommit.ok, false, 'failed durability fence must not acknowledge the upload')
  ;(store as any).writeIndex = originalWrite
  const uncertainRow = store.listForMember('post-rename')[0]!
  assert.ok(uncertainRow, 'a published index is preserved after a directory-fsync failure')
  const uncertainRead = await store.openSnapshotRead('post-rename', uncertainRow.id)
  assert.ok(uncertainRead, 'never delete the archive referenced by an already-renamed index')
  uncertainRead.stream.destroy()

  const stream = new PassThrough()
  let authorized = true
  const upload = store.putSnapshotFromStream({ memberId, stream, contentLength: 4, authorize: () => authorized })
  stream.write('ab')
  const snapshots = join(root, 'backups/members/alice/snapshots')
  while (!readdirSync(snapshots).some(name => name.endsWith('.part'))) await new Promise(resolve => setImmediate(resolve))
  authorized = false
  stream.end('cd')
  const refused = await upload
  assert.equal(refused.ok, false)
  if (!refused.ok) assert.equal(refused.status, 403)
  assert.equal(store.listForMember(memberId)[0]!.id, newest.snapshot.id)
  assert.equal(readdirSync(snapshots).some(name => name.endsWith('.part')), false)

  const quotaStream = new PassThrough()
  const quotaUpload = store.putSnapshotFromStream({ memberId, stream: quotaStream, contentLength: 4 })
  quotaStream.write('ab')
  while (!readdirSync(snapshots).some(name => name.endsWith('.part'))) await new Promise(resolve => setImmediate(resolve))
  store.setMeta({ maxBytesPerMember: 1 })
  quotaStream.end('cd')
  assert.equal((await quotaUpload).ok, false, 'changed quota is rechecked before upload commit')

  const outside = join(root, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'secret.txt'), 'private')
  symlinkSync(outside, join(root, 'backups/members/link-member'), 'dir')
  assert.throws(() => store.listForMember('link-member'), /symbolic links/)
  mkdirSync(join(root, 'chat'))
  symlinkSync(outside, join(root, 'chat/linked'), 'dir')
  symlinkSync(join(outside, 'secret.txt'), join(root, 'chat/rooms.json'))
  writeFileSync(join(root, 'chat/live.json'), '{}')
  writeFileSync(join(root, 'chat/incomplete.tmp'), 'partial')
  const picked = listChatBackupZipEntries(root)
  assert.deepEqual(picked.files, ['chat/live.json'], 'export never follows symlinks or includes unfinished writes')
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'private')
  assert.equal(existsSync(join(snapshots, `${good.snapshot.id}.aimove`)), false, 'successful retention removes the superseded snapshot')
  console.log('backup-concurrency-runtime: pinned read/delete race; atomic retention/index faults; corrupt metadata; mid-stream revocation/quota change; symlink isolation passed')
} finally {
  rmSync(root, { recursive: true, force: true })
}
