/**
 * TCC-R1146-BRG-001: GET/PATCH `/v1/limits` must not be nested under the
 * `/v1/backups` path guard (that made every limits call unreachable / 404).
 *
 * `server.ts` boots a real listener as a module side effect, so this is a
 * source-scan pin (same class as server-hardening-pins.ts).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = readFileSync(join(root, 'src/server.ts'), 'utf8')

const citeIdx = server.indexOf('TCC-R1146-BRG-001')
assert.ok(citeIdx > 0, 'fix citation TCC-R1146-BRG-001 must appear in server.ts')

const limitsPathIdx = server.indexOf("path === '/v1/limits'", citeIdx)
assert.ok(limitsPathIdx > citeIdx, 'independent path === \'/v1/limits\' gate must follow the citation')

const backupsGuardIdx = server.indexOf(
  "path === '/v1/backups' || path.startsWith('/v1/backups/')",
  citeIdx,
)
assert.ok(backupsGuardIdx > limitsPathIdx, '/v1/limits gate must appear BEFORE the /v1/backups path guard')

// Prove the limits handlers are not still nested: between the limits gate and
// the backups guard there must be GET + PATCH method branches, and the
// backups block must not re-declare path === '/v1/limits'.
const between = server.slice(limitsPathIdx, backupsGuardIdx)
assert.match(between, /req\.method === 'GET'/, 'GET /v1/limits handled in the independent gate')
assert.match(between, /req\.method === 'PATCH'/, 'PATCH /v1/limits handled in the independent gate')
assert.match(between, /getPublicChatCaps/, 'member public-caps branch retained')
assert.match(between, /limitsStore\.setMeta/, 'Admin PATCH still writes limitsStore')

const nestedLimits = server.indexOf("path === '/v1/limits'", backupsGuardIdx)
assert.equal(
  nestedLimits,
  -1,
  'must not re-declare path === \'/v1/limits\' inside/after the backups guard (regression of nesting)',
)

console.log('limits-route-reachability: ok')
