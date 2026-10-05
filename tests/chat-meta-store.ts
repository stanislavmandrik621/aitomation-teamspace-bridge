/**
 * Chat Admin retention + disk quota meta (TS-CHAT-008).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import {
  ChatMetaStore,
  CHAT_META_SCHEMA_VERSION,
  CHAT_QUOTA_BYTES_MIN,
  CHAT_RETENTION_DAYS_MAX,
} from '../src/chat-meta-store.js'
import {
  CHAT_DISK_QUOTA_BLOBS_DEFAULT,
  CHAT_DISK_QUOTA_BLOBS_LEGACY_DEFAULT,
  CHAT_DISK_QUOTA_CHAT_DEFAULT,
  CHAT_DISK_QUOTA_CHAT_LEGACY_DEFAULT,
} from '../src/chat-room.js'
import {
  resolveChatDiskQuotas,
  setChatDiskQuotaLiveResolver,
  resolveEnvChatDiskQuotas,
} from '../src/chat-disk-quota.js'
import { ChatStore } from '../src/chat-store.js'

const dir = mkdtempSync(join(tmpdir(), 'ts-chat-meta-'))
try {
  const meta = new ChatMetaStore(dir, null, {
    retentionDays: 90,
    chatFilesBytes: 2 * 1024 * 1024 * 1024,
    chatBlobsBytes: 8 * 1024 * 1024 * 1024,
  })
  assert.equal(meta.get().retentionDays, 90)
  assert.equal(meta.get().schemaVersion, CHAT_META_SCHEMA_VERSION)

  const badRetain = meta.set({ retentionDays: -1 })
  assert.ok('error' in badRetain)

  const badQuota = meta.set({ chatFilesBytes: 1024 })
  assert.ok('error' in badQuota)

  const ok = meta.set({ retentionDays: 30, chatFilesBytes: CHAT_QUOTA_BYTES_MIN })
  if ('error' in ok) throw new Error(ok.error)
  assert.equal(ok.retentionDays, 30)
  assert.equal(ok.chatFilesBytes, CHAT_QUOTA_BYTES_MIN)

  const forever = meta.set({ retentionDays: 0 })
  if ('error' in forever) throw new Error(forever.error)
  assert.equal(forever.retentionDays, 0)

  const tooLong = meta.set({ retentionDays: CHAT_RETENTION_DAYS_MAX + 1 })
  assert.ok('error' in tooLong)

  // Persist + reload
  const reloaded = new ChatMetaStore(dir, null, {
    retentionDays: 90,
    chatFilesBytes: 99,
    chatBlobsBytes: 99,
  })
  assert.equal(reloaded.get().retentionDays, 0)
  assert.equal(reloaded.get().chatFilesBytes, CHAT_QUOTA_BYTES_MIN)

  setChatDiskQuotaLiveResolver(() => reloaded.getQuotas())
  const live = resolveChatDiskQuotas()
  assert.equal(live.chatFilesBytes, CHAT_QUOTA_BYTES_MIN)
  setChatDiskQuotaLiveResolver(null)
  const envFallback = resolveChatDiskQuotas()
  assert.deepEqual(envFallback, resolveEnvChatDiskQuotas())

  const chat = new ChatStore(dir, 90, 365, null)
  chat.setRetentionDays(14)
  assert.equal(chat.getRetentionDays(), 14)
  chat.setRetentionDays(0)
  assert.equal(chat.getRetentionDays(), 0)

  // v1 -> v2 quota-default migration: a stored value equal to the OLD default
  // upgrades to the new default once; anything else survives untouched.
  const legacyDir = mkdtempSync(join(tmpdir(), 'ts-chat-meta-legacy-'))
  try {
    // Seed the store once so the chat/ folder exists, then rewrite as a v1 file.
    void new ChatMetaStore(legacyDir, null)
    const metaPath = join(legacyDir, 'chat', '_meta.json')
    writeFileSync(
      metaPath,
      JSON.stringify({
        schemaVersion: 1,
        retentionDays: 45,
        chatFilesBytes: CHAT_DISK_QUOTA_CHAT_LEGACY_DEFAULT,
        chatBlobsBytes: CHAT_DISK_QUOTA_BLOBS_LEGACY_DEFAULT,
      }),
      'utf8',
    )
    const migrated = new ChatMetaStore(legacyDir, null)
    assert.equal(migrated.get().schemaVersion, CHAT_META_SCHEMA_VERSION)
    assert.equal(migrated.get().retentionDays, 45)
    assert.equal(migrated.get().chatFilesBytes, CHAT_DISK_QUOTA_CHAT_DEFAULT)
    assert.equal(migrated.get().chatBlobsBytes, CHAT_DISK_QUOTA_BLOBS_DEFAULT)
    // Migration persisted (one-shot): the file on disk is stamped v2.
    const onDisk = JSON.parse(readFileSync(metaPath, 'utf8')) as { schemaVersion?: number }
    assert.equal(onDisk.schemaVersion, CHAT_META_SCHEMA_VERSION)

    // An Admin-chosen value (not the old default) is never bumped.
    const customBytes = 3 * 1024 * 1024 * 1024
    writeFileSync(
      metaPath,
      JSON.stringify({
        schemaVersion: 1,
        retentionDays: 45,
        chatFilesBytes: customBytes,
        chatBlobsBytes: customBytes,
      }),
      'utf8',
    )
    const kept = new ChatMetaStore(legacyDir, null)
    assert.equal(kept.get().chatFilesBytes, customBytes)
    assert.equal(kept.get().chatBlobsBytes, customBytes)

    // A v2 file holding exactly the old numbers (deliberate re-pick) stays.
    writeFileSync(
      metaPath,
      JSON.stringify({
        schemaVersion: CHAT_META_SCHEMA_VERSION,
        retentionDays: 45,
        chatFilesBytes: CHAT_DISK_QUOTA_CHAT_LEGACY_DEFAULT,
        chatBlobsBytes: CHAT_DISK_QUOTA_BLOBS_LEGACY_DEFAULT,
      }),
      'utf8',
    )
    const rePicked = new ChatMetaStore(legacyDir, null)
    assert.equal(rePicked.get().chatFilesBytes, CHAT_DISK_QUOTA_CHAT_LEGACY_DEFAULT)
    assert.equal(rePicked.get().chatBlobsBytes, CHAT_DISK_QUOTA_BLOBS_LEGACY_DEFAULT)
  } finally {
    rmSync(legacyDir, { recursive: true, force: true })
  }

  const badDir = mkdtempSync(join(tmpdir(), 'ts-chat-meta-bad-'))
  try {
    mkdirSync(join(badDir, 'chat'), { recursive: true })
    const badPath = join(badDir, 'chat', '_meta.json')
    const badBody = '{not-json'
    writeFileSync(badPath, badBody, 'utf8')
    const bad = new ChatMetaStore(badDir, null)
    const refused = bad.set({ retentionDays: 7 })
    assert.ok('error' in refused, 'set must refuse when _meta.json is unreadable')
    assert.equal(readFileSync(badPath, 'utf8'), badBody, 'unreadable _meta.json must not be overwritten')
  } finally {
    rmSync(badDir, { recursive: true, force: true })
  }

  console.log('chat-meta-store: ok')
} finally {
  rmSync(dir, { recursive: true, force: true })
  setChatDiskQuotaLiveResolver(null)
}
