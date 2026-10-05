import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const server = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.ts'),
  'utf8',
)
const start = server.indexOf('function handleOps(')
const end = server.indexOf('\nfunction requireAdmin(', start)
assert.ok(start >= 0 && end > start, 'handleOps source window exists')
const handleOps = server
  .slice(start, end)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '')

const spreadAt = handleOps.search(/\.\.\.op\s*,/)
const stampAt = handleOps.search(/originDevice\s*:\s*session\.deviceId\s*,/)
assert.ok(spreadAt >= 0 && stampAt > spreadAt, 'authenticated device stamp overwrites the client object')
assert.doesNotMatch(
  handleOps,
  /originDevice\s*:\s*(?:op|raw|frame)\b/,
  'op relay never trusts client-supplied device attribution',
)

console.log('brg-109-origin-device-stamp: authenticated socket device attribution passed')
