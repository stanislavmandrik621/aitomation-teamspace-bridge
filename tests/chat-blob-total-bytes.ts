/**
 * G12 (Wave 14 box 12) / BRG-069: `ChatBlobRegistry.totalBlobBytes()` fed
 * BOTH Admin `chat_metrics` twins (WS + HTTP, as `blobBytes`) and
 * `chat_config_get` (as `usedBlobsBytes`), and was an O(n) scan of `bySha`
 * on EVERY call - a full Map walk on every single attachment upload's
 * quota check (registerUpload, hot path) AND on every Admin metrics poll.
 * `bySha` grows with every distinct attachment ever uploaded (soft-capped
 * at load() to 100_000 rows) - the exact "in-memory collection that could
 * itself grow unbounded" BRG-069 warns about, the same class of bug
 * `CrmBlobDiskTotal` (crm-blob-disk.ts / crm-blob-disk-total.ts) already
 * fixed for CRM blobs.
 *
 * Fix: an O(1) running total (`totalBytesTracked`) kept in lockstep with
 * every insert/delete of a `bySha` row - load() sums while populating the
 * map, registerUpload adds only for a genuinely NEW row (dedup/raced paths
 * reuse existing bytes and must not double-count), and gc()'s two deletion
 * loops (file-gone rows, aged-unreferenced rows) subtract before deleting.
 *
 * Pin-break (do not leave this in the tree): revert `totalBlobBytes()` to
 * `for (const row of this.bySha.values()) n += row.bytes` and this file
 * must EXIT 1 on the source-scan pin below.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ChatBlobRegistry } from '../src/chat-blob-registry.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const registrySrc = readFileSync(join(root, 'src/chat-blob-registry.ts'), 'utf8')

function sourceWithoutComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
}

/** Index of the `}` matching the `{` at `openIdx` (naive brace counting). */
function matchingBraceIndex(src: string, openIdx: number): number {
  let depth = 0
  for (let j = openIdx; j < src.length; j++) {
    if (src[j] === '{') depth += 1
    else if (src[j] === '}') {
      depth -= 1
      if (depth === 0) return j
    }
  }
  assert.fail('unmatched brace')
}

function sliceClassMethod(src: string, name: string): string {
  const re = new RegExp(`\\n  (?:(?:private|public|protected|static)\\s+)?(?:async\\s+)?${name}\\(`)
  const m = re.exec(src)
  assert.ok(m, `missing method ${name}(`)
  const start = m.index + 1
  let i = m.index + m[0].length - 1
  assert.equal(src[i], '(')
  let paren = 0
  let angle = 0
  let bodyOpen = -1
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === '(') paren += 1
    else if (c === ')') paren -= 1
    else if (c === '<') angle += 1
    else if (c === '>' && angle > 0) angle -= 1
    else if (c === '{' && paren === 0 && angle === 0) {
      // Could be the real function body OR a `{...}` object-type return
      // annotation before it (e.g. `): { removedFiles: number } {`, as in
      // gc()). If a second `{` follows immediately after this brace's own
      // close, this one was the return-type object - keep scanning past it.
      const closeIdx = matchingBraceIndex(src, i)
      const gapLen = src.slice(closeIdx + 1).match(/^\s*/)?.[0].length ?? 0
      if (src[closeIdx + 1 + gapLen] === '{') {
        i = closeIdx
        continue
      }
      bodyOpen = i
      break
    }
  }
  assert.ok(bodyOpen >= 0, `no body for ${name}`)
  let depth = 0
  for (i = bodyOpen; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  assert.fail(`unclosed method ${name}`)
}

function shaOf(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

let passed = 0
async function t(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn()
  passed += 1
  console.log(`ok ${passed} ${name}`)
}

await t('source-scan: totalBlobBytes() returns the running total, never re-sums bySha', () => {
  const body = sliceClassMethod(registrySrc, 'totalBlobBytes')
  const live = sourceWithoutComments(body)
  assert.doesNotMatch(
    live,
    /for\s*\(\s*const\s+row\s+of\s+this\.bySha\.values\s*\(\s*\)\s*\)/,
    'totalBlobBytes must not walk bySha on every call (BRG-069)',
  )
  assert.match(live, /this\.totalBytesTracked/)
  const broken = body.replace(
    'return Math.max(0, this.totalBytesTracked)',
    'let n = 0\n    for (const row of this.bySha.values()) n += Math.max(0, row.bytes || 0)\n    return n',
  )
  assert.notEqual(broken, body, 'fixture must restore the O(n) scan')
  assert.match(
    sourceWithoutComments(broken),
    /for\s*\(\s*const\s+row\s+of\s+this\.bySha\.values\s*\(\s*\)\s*\)/,
    'putting the bySha scan back must fail this pin (TOOL-G31-066)',
  )
})

await t('source-scan: load() sums into the running total while populating bySha', () => {
  const body = sliceClassMethod(registrySrc, 'load')
  const live = sourceWithoutComments(body)
  assert.match(live, /this\.totalBytesTracked\s*\+=\s*bytes/)
  assert.match(live, /this\.totalBytesTracked\s*=\s*0/, 'the catch branch must reset the total with bySha.clear()')
  const commented = body.replace(
    'this.totalBytesTracked += bytes',
    '// this.totalBytesTracked += bytes',
  )
  assert.notEqual(commented, body, 'fixture must comment the load-time sum')
  assert.equal(
    /this\.totalBytesTracked\s*\+=\s*bytes/.test(sourceWithoutComments(commented)),
    false,
    'a commented sum is not a seeded running total (TOOL-G31-066)',
  )
})

await t('source-scan: registerUpload adds only for a genuinely new row, rolls back on persist fail', () => {
  const body = sliceClassMethod(registrySrc, 'registerUpload')
  const live = sourceWithoutComments(body)
  const newRowIdx = live.search(/this\.bySha\.set\(\s*sha,\s*row\s*\)/)
  assert.ok(newRowIdx >= 0, 'registerUpload must insert the new row')
  const addIdx = live.indexOf('this.totalBytesTracked += row.bytes', newRowIdx)
  assert.ok(addIdx > newRowIdx, 'must add bytes right after inserting the new row')
  const rollbackIdx = live.indexOf('this.totalBytesTracked -= row.bytes', addIdx)
  assert.ok(rollbackIdx > addIdx, 'must roll back on persist failure')
  const deleteIdx = live.indexOf('this.bySha.delete(sha)', addIdx)
  assert.ok(deleteIdx > addIdx && deleteIdx < rollbackIdx, 'rollback must delete the row then subtract its bytes')

  // The existing-row and raced-row reuse branches (before the new-row
  // insert) must never touch the total - they reuse an already-counted row.
  const beforeNewRow = live.slice(0, newRowIdx)
  assert.doesNotMatch(
    beforeNewRow,
    /totalBytesTracked/,
    'dedup / raced reuse paths must not double-count an existing row',
  )
})

await t('source-scan: gc() subtracts bytes before deleting a row, both loops', () => {
  const body = sliceClassMethod(registrySrc, 'gc')
  const live = sourceWithoutComments(body)
  const matches = [...live.matchAll(/this\.totalBytesTracked\s*-=\s*row\.bytes/g)]
  assert.equal(matches.length, 2, 'both the file-gone loop and the age-delete loop must subtract')
  const deletes = [...live.matchAll(/this\.bySha\.delete\(\s*sha\s*\)/g)]
  assert.equal(deletes.length, 2)

  const commented = body.replaceAll(
    'this.totalBytesTracked -= row.bytes',
    '// this.totalBytesTracked -= row.bytes',
  )
  assert.notEqual(commented, body, 'fixture must comment both subtracts')
  assert.equal(
    (sourceWithoutComments(commented).match(/this\.totalBytesTracked\s*-=\s*row\.bytes/g) || []).length,
    0,
    'a commented subtract is not a decrement (TOOL-G31-066)',
  )
})

await t('behavior: registerUpload increments the O(1) total for a new blob only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-blob-total-reg-'))
  try {
    const reg = new ChatBlobRegistry(dir, null)
    assert.equal(reg.totalBlobBytes(), 0)

    const a = Buffer.from('a'.repeat(40))
    const rowA = await reg.registerUpload({ roomId: 'chat:team', uploadedBy: 'm1', filename: 'a.txt', bytes: a })
    assert.equal('error' in rowA, false)
    assert.equal(reg.totalBlobBytes(), 40)

    const b = Buffer.from('b'.repeat(15))
    const rowB = await reg.registerUpload({ roomId: 'chat:team', uploadedBy: 'm1', filename: 'b.txt', bytes: b })
    assert.equal('error' in rowB, false)
    assert.equal(reg.totalBlobBytes(), 55)

    // Same-sha re-upload into a second room reuses the row - must not
    // double-count (dedup path, TCC-R1146-MEDIA-003).
    const again = await reg.registerUpload({ roomId: 'chat:g:room2room', uploadedBy: 'm1', filename: 'a.txt', bytes: a })
    assert.equal('error' in again, false)
    assert.equal(reg.totalBlobBytes(), 55, 'dedup reuse must not double-count')

    // A fresh registry instance re-opened on the same dir must load() to
    // the identical total (proves load() sums correctly from disk).
    const reopened = new ChatBlobRegistry(dir, null)
    assert.equal(reopened.totalBlobBytes(), 55)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await t('behavior: gc() file-gone prune decrements the total', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-blob-total-gone-'))
  try {
    const reg = new ChatBlobRegistry(dir, null)
    const a = Buffer.from('c'.repeat(30))
    const rowA = await reg.registerUpload({ roomId: 'chat:team', uploadedBy: 'm1', filename: 'a.txt', bytes: a })
    assert.equal('error' in rowA, false)
    if ('error' in rowA) throw new Error('unreachable')
    assert.equal(reg.totalBlobBytes(), 30)

    // Delete the on-disk file out-of-band so gc() treats the row as
    // file-gone (its first deletion loop).
    const path = reg.blobPath(rowA.sha256)
    assert.equal(existsSync(path), true)
    rmSync(path)
    const out = reg.gc()
    assert.ok(out.removedRows >= 1)
    assert.equal(reg.totalBlobBytes(), 0, 'file-gone row must be subtracted from the running total')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await t('behavior: gc() age-delete of an unreferenced row decrements the total', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-blob-total-age-'))
  try {
    const reg = new ChatBlobRegistry(dir, null)
    const live = Buffer.from('d'.repeat(20))
    const dead = Buffer.from('e'.repeat(50))
    const rowLive = await reg.registerUpload({ roomId: 'chat:team', uploadedBy: 'm1', filename: 'live.txt', bytes: live })
    const rowDead = await reg.registerUpload({ roomId: 'chat:team', uploadedBy: 'm1', filename: 'dead.txt', bytes: dead })
    assert.equal('error' in rowLive, false)
    assert.equal('error' in rowDead, false)
    if ('error' in rowLive || 'error' in rowDead) throw new Error('unreachable')
    assert.equal(reg.totalBlobBytes(), 70)

    // gc()'s age-delete loop keys on row.createdAt (not file mtime, see
    // TCC-R1144-MEDIA-002) - backdate the dead row directly, same as the
    // existing chat-blob-gc.ts TS-CHAT-014 tests do.
    const bySha = (reg as unknown as { bySha: Map<string, { createdAt: number }> }).bySha
    const deadRow = bySha.get(rowDead.sha256)
    assert.ok(deadRow, 'dead row must be in bySha before backdating')
    deadRow.createdAt = Date.now() - 8 * 24 * 60 * 60 * 1000

    const out = reg.gc(new Set([rowLive.sha256]), 7 * 24 * 60 * 60 * 1000)
    assert.ok(out.removedRows >= 1)
    assert.equal(reg.totalBlobBytes(), 20, 'only the kept row bytes remain in the running total')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await t('behavior: quota check uses the O(1) total, not a fresh scan, on the hot path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-blob-total-quota-'))
  try {
    const reg = new ChatBlobRegistry(dir, null)
    const many = 200
    for (let i = 0; i < many; i++) {
      const buf = Buffer.from(`row-${i}-${shaOf(Buffer.from(String(i))).slice(0, 8)}`)
      const row = await reg.registerUpload({ roomId: 'chat:team', uploadedBy: 'm1', filename: `f${i}.txt`, bytes: buf })
      assert.equal('error' in row, false)
    }
    const expected = reg.totalBlobBytes()
    assert.ok(expected > 0)
    // Re-open from disk and confirm load() matches the running total exactly
    // (proves the O(1) field and the on-disk truth never drift after N inserts).
    const reopened = new ChatBlobRegistry(dir, null)
    assert.equal(reopened.totalBlobBytes(), expected)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

console.log(`chat-blob-total-bytes: ${passed}/8 ok`)
