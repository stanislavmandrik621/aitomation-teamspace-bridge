/**
 * BRG-069 group (G17): one process is one team. Several teams on one
 * host is several containers. Fairness is the operator's job and cannot
 * be solved in-process. This pin only requires the guide section, the
 * runbook twin, and the example compose. It does not scan server.ts
 * and it does not require any lock or fairness code.
 *
 * Cite TS-BRG-011 (existing `.bridge.lock` / acquireBridgeDataDirLock).
 * Do not rebuild the lock. Deep BRG-069 (two-stores disk total) is G6.
 *
 * Unique phrases (must appear inside ## Several teams on one machine):
 *   - Several teams on one machine means several containers.
 *   - Fairness between teams is the host's job
 *   - .bridge.lock
 *   - already using this data folder
 *
 * Pin-break (do not leave this in the tree):
 *   Delete the several-containers sentence in docs/SELF-HOST.md
 *   (the line that says "Several teams on one machine means several
 *   containers."). This file then EXIT 1. Restore the sentence.
 *   Expect green. SHA of SELF-HOST.md must match the pre-break file.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(root, '..', '..')
const guidePath = join(root, 'docs/SELF-HOST.md')
const runbookPath = join(repoRoot, 'docs/team-space/SELF-HOST-RUNBOOK.md')
const examplePath = join(root, 'docker-compose.multi-team.example.yml')
const liveComposePath = join(root, 'docker-compose.yml')
const lockSrcPath = join(root, 'src/data-dir-lock.ts')

const SEVERAL_CONTAINERS_SENTENCE =
  'Several teams on one machine means several containers.'
const FAIRNESS_PHRASE = "Fairness between teams is the host's job"
const LOCK_FILE_NAME = '.bridge.lock'
const LOCK_REFUSE = 'already using this data folder'
const LOCK_PICK_DIR = 'pick a different TEAMSPACE_DATA_DIR'
const HEADING = '## Several teams on one machine'
const RUNBOOK_HEADING = '### Several teams on one machine'
const TEAM_IDENTITY_HEADING = '## Team identity'
const AUDIT_LEAKS = ['BRG-069', 'TS-BRG-011', 'G17'] as const

function sectionAfterHeading(src: string, heading: string): string {
  const headingIdx = src.indexOf(heading)
  assert.ok(headingIdx >= 0, `missing heading ${heading}`)
  const after = src.slice(headingIdx + heading.length)
  const next = after.search(/\n## /)
  return next >= 0 ? after.slice(0, next) : after
}

function assertNoAuditLeak(label: string, src: string): void {
  for (const leak of AUDIT_LEAKS) {
    assert.equal(src.includes(leak), false, `${label} must not contain ${leak}`)
  }
}

try {
  const guide = readFileSync(guidePath, 'utf8')
  const runbook = readFileSync(runbookPath, 'utf8')
  const example = readFileSync(examplePath, 'utf8')
  const liveCompose = readFileSync(liveComposePath, 'utf8')
  const lockSrc = readFileSync(lockSrcPath, 'utf8')

  assert.ok(guide.includes(HEADING), `SELF-HOST.md missing ${HEADING}`)
  const section = sectionAfterHeading(guide, HEADING)

  assert.ok(
    section.includes(SEVERAL_CONTAINERS_SENTENCE),
    `SELF-HOST several-teams section missing "${SEVERAL_CONTAINERS_SENTENCE}"`,
  )
  assert.ok(
    section.includes(FAIRNESS_PHRASE),
    'SELF-HOST several-teams section missing fairness phrase',
  )
  assert.ok(
    section.includes(LOCK_FILE_NAME),
    'SELF-HOST several-teams section missing .bridge.lock',
  )
  assert.ok(
    section.includes(LOCK_REFUSE),
    'SELF-HOST several-teams section missing lock refuse text',
  )
  assert.ok(
    section.includes(LOCK_PICK_DIR),
    'SELF-HOST several-teams section missing pick-a-different-dir refuse',
  )
  assert.ok(
    section.includes('The one-team compose file and the example compose file both set'),
    'SELF-HOST several-teams section must say the one-team compose has the same limits',
  )

  const identity = sectionAfterHeading(guide, TEAM_IDENTITY_HEADING)
  assert.equal(
    identity.includes(SEVERAL_CONTAINERS_SENTENCE),
    false,
    'do not satisfy this pin by editing the Team identity paragraph',
  )
  assert.equal(
    identity.includes(LOCK_FILE_NAME),
    false,
    'do not satisfy this pin by putting .bridge.lock in Team identity',
  )

  const throughputLine = guide
    .split('\n')
    .find((line) => line.includes('one bridge process is one team'))
  assert.ok(throughputLine, 'throughput one-process note missing (false-friend check)')
  assert.equal(
    throughputLine.includes(SEVERAL_CONTAINERS_SENTENCE),
    false,
    'do not satisfy this pin by editing the throughput note',
  )
  assert.equal(
    throughputLine.includes(LOCK_FILE_NAME),
    false,
    'do not satisfy this pin by editing the throughput note',
  )

  assert.ok(
    lockSrc.includes(LOCK_REFUSE),
    'data-dir-lock.ts no longer has the refuse text this guide cites',
  )
  assert.ok(
    lockSrc.includes(LOCK_PICK_DIR),
    'data-dir-lock.ts no longer has the pick-dir refuse this guide cites',
  )
  assert.ok(
    lockSrc.includes(LOCK_FILE_NAME),
    'data-dir-lock.ts no longer names .bridge.lock',
  )

  assert.ok(runbook.includes(RUNBOOK_HEADING), 'runbook missing several-teams heading')
  assert.ok(
    runbook.includes(SEVERAL_CONTAINERS_SENTENCE),
    `runbook missing "${SEVERAL_CONTAINERS_SENTENCE}"`,
  )
  assert.ok(
    runbook.includes(FAIRNESS_PHRASE),
    'runbook missing fairness phrase',
  )
  assert.ok(runbook.includes(LOCK_FILE_NAME), 'runbook missing .bridge.lock')
  assert.ok(runbook.includes(LOCK_REFUSE), 'runbook missing lock refuse text')

  assert.ok(
    /cpus:\s*['"]?1(\.0)?['"]?/.test(example),
    'example compose missing cpus: 1 / 1.0',
  )
  assert.ok(
    /mem_limit:\s*1g/.test(example),
    'example compose missing mem_limit: 1g',
  )
  assert.ok(
    example.includes('teamspace-data-a:/data'),
    'example compose missing teamspace-data-a mount',
  )
  assert.ok(
    example.includes('teamspace-data-b:/data'),
    'example compose missing teamspace-data-b mount',
  )
  assert.ok(
    /^  teamspace-data-a:\s*$/m.test(example),
    'example compose missing teamspace-data-a volume declaration',
  )
  assert.ok(
    /^  teamspace-data-b:\s*$/m.test(example),
    'example compose missing teamspace-data-b volume declaration',
  )
  assert.ok(example.includes("'8788:8788'"), 'example compose missing host 8788')
  assert.ok(example.includes("'8789:8788'"), 'example compose missing host 8789')
  assert.equal(
    /8787/.test(example),
    false,
    'example compose must not use 8787',
  )
  assert.equal(
    liveCompose.includes('teamspace-data-a'),
    false,
    'do not turn live docker-compose.yml into two teams',
  )
  assert.ok(
    liveCompose.includes('teamspace-data:'),
    'live docker-compose.yml must keep the one-team named volume',
  )
  assert.ok(
    /cpus:\s*['"]?1(\.0)?['"]?/.test(liveCompose),
    'one-team compose must set cpus: 1 / 1.0 (G17 residual: default was unlimited)',
  )
  assert.ok(
    /mem_limit:\s*1g/.test(liveCompose),
    'one-team compose must set mem_limit: 1g (G17 residual: default was unlimited)',
  )
  assert.ok(
    /pids_limit:\s*64/.test(liveCompose),
    'one-team compose must set pids_limit: 64',
  )

  assertNoAuditLeak('SELF-HOST.md', guide)
  assertNoAuditLeak('SELF-HOST-RUNBOOK.md', runbook)
  assertNoAuditLeak('docker-compose.multi-team.example.yml', example)
  assert.equal(guide.includes('P1-C'), false, 'SELF-HOST.md must not name P1-C')
  assert.equal(/\bP6\b/.test(guide), false, 'SELF-HOST.md must not name P6')
  assert.ok(
    guide.includes('TEAMSPACE_MAX_INFLIGHT_HTTP_DOWNLOAD_BYTES'),
    'SELF-HOST.md env table must list the download heap ceiling',
  )
  assert.ok(
    guide.includes('TEAMSPACE_MAX_INFLIGHT_HTTP_DOWNLOAD_BYTES_PER_MEMBER'),
    'SELF-HOST.md env table must list the per-member download share',
  )
  const bodyPerMember = guide
    .split('\n')
    .find((line) => line.includes('TEAMSPACE_MAX_INFLIGHT_HTTP_BODY_BYTES_PER_MEMBER'))
  assert.ok(bodyPerMember, 'SELF-HOST.md missing per-member body row')
  assert.ok(
    /compose/i.test(bodyPerMember),
    'per-member body row must name Compose JSON, not binary-only',
  )

  console.log('ok')
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  console.log('FAIL', message)
  process.exit(1)
}
