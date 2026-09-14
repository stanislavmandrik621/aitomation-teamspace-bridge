import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planStoredBackupZip } from '../src/backup-zip.js'

const root = mkdtempSync(join(tmpdir(), 'backup-path-identity-'))
try {
  const file = join(root, 'source')
  writeFileSync(file, 'verified bytes')
  const name = `chat/rooms/${'r'.repeat(128)}/attachments/${'a'.repeat(64)}.json`
  const planned = await planStoredBackupZip([{ name, absolutePath: file, size: 14 }])
  assert.ok(planned.ok)
  assert.equal(planned.planned[0]!.nameBuf.toString('utf8'), name,
    'backup paths are restore identities, not display labels that may be truncated')
  for (const name of ['../escape', 'chat/./rooms.json', 'chat//rooms.json', 'chat/rooms.json ', 'chat/rooms.json.', 'chat/a\\b', 'chat/a:b', '/absolute', 'chat/a*b', 'chat/a?b', 'chat/a|b', 'chat/\ud800.json']) {
    assert.equal((await planStoredBackupZip([{ name, absolutePath: file, size: 14 }])).ok, false, `unsafe path must be refused: ${name}`)
  }
  const unicodeCollision = await planStoredBackupZip([
    { name: 'chat/é.json', absolutePath: file, size: 14 },
    { name: 'chat/e\u0301.json', absolutePath: file, size: 14 },
  ])
  assert.equal(unicodeCollision.ok, false, 'canonical-equivalent names cannot overwrite one another on macOS extraction')
  console.log('backup-path-identity-runtime: long exact paths, unsafe aliases and Unicode extraction collisions passed')
} finally {
  rmSync(root, { recursive: true, force: true })
}
