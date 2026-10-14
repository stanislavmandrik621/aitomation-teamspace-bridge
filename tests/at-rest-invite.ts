/**
 * TS-BRG-014 / TS-SCL-001 / TS-SCL-002 - at-rest encrypt + invite hash.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import {
  OPS_ENC_PREFIX,
  BLOB_ENC_MAGIC,
  resolveAtRestKeyFromEnv,
  encryptOpsLine,
  decryptOpsLine,
} from '../src/at-rest.js'
import { BridgeStore, hashInviteToken, mintToken } from '../src/store.js'

function must(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'ts-at-rest-'))
  try {
    // --- at-rest leaf ---
    {
      const key = resolveAtRestKeyFromEnv({
        TEAMSPACE_AT_REST_KEY: randomBytes(32).toString('hex'),
      } as NodeJS.ProcessEnv)
      must(!!key, 'hex key resolves')
      if (!key) throw new Error('unreachable')
      const line = encryptOpsLine(key, '{"opId":"x"}')
      must(line.startsWith(OPS_ENC_PREFIX), 'ops enc prefix')
      must(decryptOpsLine(key, line) === '{"opId":"x"}', 'ops round-trip')
      must(decryptOpsLine(key, '{"opId":"plain"}') === '{"opId":"plain"}', 'plaintext passthrough')
    }

    // --- invite tokens hashed on disk (TS-SCL-001) ---
    {
      const store = new BridgeStore(join(root, 'inv'), 21, null)
      store.helloOrBootstrap({
        memberId: 'mem_a', deviceId: 'd1', memberEmail: 'a@example.com',
      })
      const created = store.createInvite('mem_a', 'b@example.com', 'member')
      must(created.ok === true, 'invite created')
      if (!created.ok) throw new Error('unreachable')
      const invite = created.invite
      must(invite.token.length > 20, 'create returns plaintext')
      const raw = readFileSync(join(root, 'inv', 'invites.json'), 'utf8')
      must(!raw.includes(invite.token), 'plaintext invite not on disk')
      must(raw.includes(hashInviteToken(invite.token)), 'hashed invite on disk')
      const redeem = await store.redeemInvite({
        token: invite.token,
        deviceId: 'd2',
        displayName: 'Bob',
      })
      must(redeem.ok === true, 'redeem with plaintext works')
    }

    // --- ops + blob encrypt when key set (TS-BRG-014 / TS-SCL-002) ---
    {
      const key = resolveAtRestKeyFromEnv({
        TEAMSPACE_AT_REST_KEY: 'test-passphrase-16+',
      } as NodeJS.ProcessEnv)
      must(!!key, 'passphrase key')
      if (!key) throw new Error('unreachable')
      const dir = join(root, 'enc')
      const store = new BridgeStore(dir, 21, key)
      store.helloOrBootstrap({
        memberId: 'mem_e', deviceId: 'de', memberEmail: 'e@example.com',
      })
      store.appendOp({
        opId: 'op_secret',
        kind: 'record.update',
        protocolVersion: 1,
        hopCount: 0,
        originDevice: 'de',
        data: { name: 'Secret Customer' },
      } as never)
      const opsRaw = readFileSync(join(dir, 'ops.jsonl'), 'utf8')
      must(opsRaw.includes(OPS_ENC_PREFIX), 'ops line encrypted')
      must(!opsRaw.includes('Secret Customer'), 'CRM PII not plaintext in ops.jsonl')
      const recent = await store.readRecentOps(10)
      must(recent.some((o) => o.opId === 'op_secret'), 'decrypt read works')

      const plain = Buffer.from('hello-blob-bytes')
      const sha = createHash('sha256').update(plain).digest('hex')
      const put = await store.putBlobFromStream(sha, Readable.from(plain), plain.length)
      must(put.ok === true, 'blob put ok')
      const disk = readFileSync(join(dir, 'blobs', sha))
      must(disk.subarray(0, 4).equals(BLOB_ENC_MAGIC), 'blob magic')
      must(!disk.includes(plain), 'blob body not plaintext')
      const opened = store.openBlobRead(sha)
      must(!!opened && opened.size === plain.length, 'blob open size')
      if (!opened) throw new Error('unreachable')
      const chunks: Buffer[] = []
      for await (const c of opened.stream) {
        chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
      }
      must(Buffer.concat(chunks).equals(plain), 'blob decrypt round-trip')

      const membersRaw = readFileSync(join(dir, 'members.json'), 'utf8')
      must(membersRaw.includes('"ciphertext"'), 'members.json envelope encrypted')
    }

    // --- short passphrase refused ---
    {
      let threw = false
      try {
        resolveAtRestKeyFromEnv({ TEAMSPACE_AT_REST_KEY: 'short' } as NodeJS.ProcessEnv)
      } catch {
        threw = true
      }
      must(threw, 'short passphrase refused')
    }

    console.log('at-rest-invite: ok')
  } finally {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* */ }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
