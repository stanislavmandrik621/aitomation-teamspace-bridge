/**
 * Admin recovery key - the escape hatch for a locked-out Admin.
 *
 * The problem this solves: `helloOrBootstrap` only mints a session for the very
 * first hello (when the members roster is empty). After that, a hello needs a
 * valid session token bound to the presenting device, and the only other way in
 * is redeeming an invite - which only an Admin can mint. A solo self-hoster (one
 * person runs the server, that person is the only Admin) who loses their session
 * token (keychain reset, reinstall, new computer, or pressing Disconnect) was
 * therefore locked out of their own server forever, with all of their rooms,
 * messages, and synced rows still sitting on the data volume.
 *
 * The proof of ownership we accept is "you can read this server's environment or
 * its data directory" - which is exactly what operating the server means. That
 * is the same class of proof the at-rest key already relies on.
 *
 * Secret resolution order (once per data directory, at startup):
 *   1. `TEAMSPACE_ADMIN_RECOVERY_KEY` when set (must be at least
 *      ADMIN_RECOVERY_KEY_MIN_LEN characters - a shorter value fails loud
 *      instead of being silently accepted as a weak password).
 *   2. Otherwise `<data dir>/admin-recovery.key`, reused on every later boot.
 *   3. Otherwise a fresh random key, written to that same file with 0600
 *      permissions. It lives in the persisted data directory, so it survives
 *      container restarts and image upgrades exactly like `members.json`.
 *
 * Why the key file is plaintext (and not hashed at rest): the operator has to be
 * able to READ the key back out in order to type it into the app. A hash cannot
 * be typed in, and printing the key only once at generation time would strand
 * anyone who lost that line of log output. So the honest trade-off is plaintext
 * plus 0600 file permissions plus the fact that anyone who can read this file
 * can already read `members.json` and every message body in the same directory.
 * There is nothing extra to protect once the data directory is readable.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'

/** Environment variable an operator may set to pin their own recovery key. */
export const ADMIN_RECOVERY_ENV_VAR = 'TEAMSPACE_ADMIN_RECOVERY_KEY'

/** File under the bridge data dir that holds an auto-generated key. */
export const ADMIN_RECOVERY_KEY_FILENAME = 'admin-recovery.key'

/**
 * Minimum length for an operator-supplied key. 24 characters of anything is
 * well past the point where the per-IP attempt budget makes guessing pointless,
 * and short enough that a human-chosen passphrase can still meet it.
 */
export const ADMIN_RECOVERY_KEY_MIN_LEN = 24

/** Longest key we will store or compare. Caps the work an attacker can force. */
export const ADMIN_RECOVERY_KEY_MAX_LEN = 512

/** Bytes of randomness in an auto-generated key (43 base64url characters). */
const ADMIN_RECOVERY_GENERATED_BYTES = 32

/**
 * Refusal reasons. These are NEW strings, deliberately distinct from the
 * pre-existing hello refusals (`Session token required`, `Invalid session`,
 * `Session does not match member`, `Session is bound to another device - redeem
 * an invite on this computer`) so a client can tell a recovery failure apart
 * from an ordinary session failure. Never change these without updating the
 * desktop classifier.
 */
export const ADMIN_RECOVERY_REFUSE_BAD_KEY = 'Admin recovery key is not correct'
export const ADMIN_RECOVERY_REFUSE_LOCKED =
  'Admin recovery is locked - too many attempts, wait and try again'
export const ADMIN_RECOVERY_REFUSE_UNAVAILABLE = 'Admin recovery is not available on this server'
export const ADMIN_RECOVERY_REFUSE_NO_ADMIN = 'No Admin account to recover on this server'

export type AdminRecoveryKeySource = 'env' | 'file' | 'generated'

export type AdminRecoveryKey = {
  /** Plaintext secret. Never log this, never send it anywhere. */
  readonly secret: string
  readonly source: AdminRecoveryKeySource
  /** Absolute path of the key file, or null when the key came from the env. */
  readonly path: string | null
  /** Operator-facing notes worth printing at startup (never contains the key). */
  readonly warnings: readonly string[]
}

/** Mint a fresh recovery key (also used by tests). */
export function generateAdminRecoveryKey(): string {
  return randomBytes(ADMIN_RECOVERY_GENERATED_BYTES).toString('base64url')
}

/**
 * Short digest of the key, safe to print. Lets an operator confirm the running
 * server is using the key they think it is without revealing the key itself.
 */
export function adminRecoveryKeyFingerprint(key: AdminRecoveryKey): string {
  return createHash('sha256').update(key.secret, 'utf8').digest('hex').slice(0, 8)
}

/**
 * Constant-time compare of a presented key against the server secret.
 *
 * Both sides are hashed to a fixed 32-byte digest BEFORE the compare, so an
 * unequal input length cannot take a different code path: there is no early
 * length return that an attacker could distinguish from a plain mismatch, and
 * `timingSafeEqual` always sees two equal-length buffers. An oversized value is
 * truncated (not rejected early) for the same reason - it costs exactly what a
 * wrong key of the right length costs.
 *
 * The presented value is trimmed because every path that produces the stored
 * secret trims too (env, key file, generated) - so surrounding whitespace can
 * never be part of a real key, and a paste that picked up a stray space or
 * newline would otherwise read to the operator as "wrong key".
 */
export function adminRecoveryKeyMatches(key: AdminRecoveryKey | null, presented: unknown): boolean {
  if (!key) return false
  const raw = typeof presented === 'string' ? presented.trim() : ''
  const candidate = raw.slice(0, ADMIN_RECOVERY_KEY_MAX_LEN)
  const a = createHash('sha256').update(candidate, 'utf8').digest()
  const b = createHash('sha256').update(key.secret, 'utf8').digest()
  return timingSafeEqual(a, b)
}

/**
 * True when a hello frame is actually asking for recovery. A blank / whitespace
 * value is treated as "not presented" so an empty input box behaves exactly like
 * today's hello and never burns an attempt.
 */
export function hasPresentedAdminRecoveryKey(presented: unknown): boolean {
  return typeof presented === 'string' && presented.trim().length > 0
}

function readKeyFile(path: string): { raw: string; looseMode: boolean } | null {
  if (!existsSync(path)) return null
  const body = readFileSync(path, 'utf8')
  // Tolerate a trailing newline or an operator editing the file in place.
  const raw = body.split(/\r?\n/, 1)[0]?.trim() ?? ''
  let looseMode = false
  try {
    const mode = statSync(path).mode & 0o777
    looseMode = (mode & 0o077) !== 0
  } catch {
    /* permission probe is advisory only */
  }
  return { raw, looseMode }
}

function writeKeyFileAtomic(path: string, secret: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  try {
    // `mode` is masked by umask, so chmod explicitly before the rename - the
    // final file must never be world-readable even for a moment.
    writeFileSync(tmp, `${secret}\n`, { encoding: 'utf8', mode: 0o600 })
    try {
      chmodSync(tmp, 0o600)
    } catch {
      /* not every filesystem supports chmod (Windows, some volume mounts) */
    }
    renameSync(tmp, path)
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* best effort */
    }
    throw err
  }
  try {
    chmodSync(path, 0o600)
  } catch {
    /* see above */
  }
}

/**
 * Resolved once per data directory so the store and the server share one
 * instance and a freshly generated key is written (and announced) exactly once
 * per boot, no matter how many callers ask for it.
 */
const resolvedByDataDir = new Map<string, AdminRecoveryKey>()

/** Test helper - drop the per-data-dir memo. */
export function resetAdminRecoveryKeyCacheForTests(): void {
  resolvedByDataDir.clear()
}

/**
 * Resolve this server's recovery key. Throws (fail loud, never fall back to a
 * weak or absent key) when the operator supplied something unusable.
 */
export function resolveAdminRecoveryKey(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): AdminRecoveryKey {
  const dir = String(dataDir || '').trim()
  if (!dir) throw new Error('Admin recovery key needs a data directory')

  const fromEnvRaw = String(env[ADMIN_RECOVERY_ENV_VAR] ?? '').trim()
  if (fromEnvRaw) {
    if (fromEnvRaw.length < ADMIN_RECOVERY_KEY_MIN_LEN) {
      throw new Error(
        `${ADMIN_RECOVERY_ENV_VAR} must be at least ${ADMIN_RECOVERY_KEY_MIN_LEN} characters` +
          ` (got ${fromEnvRaw.length}). Unset it to let the server generate a strong key instead.`,
      )
    }
    if (fromEnvRaw.length > ADMIN_RECOVERY_KEY_MAX_LEN) {
      throw new Error(
        `${ADMIN_RECOVERY_ENV_VAR} must be at most ${ADMIN_RECOVERY_KEY_MAX_LEN} characters` +
          ` (got ${fromEnvRaw.length}).`,
      )
    }
    // Env wins over any file, and is not memoized against the data dir path so
    // a changed env var takes effect on the next boot without stale reuse.
    return { secret: fromEnvRaw, source: 'env', path: null, warnings: [] }
  }

  const cached = resolvedByDataDir.get(dir)
  if (cached) return cached

  mkdirSync(dir, { recursive: true })
  const path = join(dir, ADMIN_RECOVERY_KEY_FILENAME)
  const warnings: string[] = []

  const existing = readKeyFile(path)
  if (existing) {
    if (existing.raw.length < ADMIN_RECOVERY_KEY_MIN_LEN) {
      // Never silently regenerate over a file the operator may have truncated -
      // that would swap out a key they might still be holding, and would hide
      // tampering. Make them decide.
      throw new Error(
        `${path} holds a recovery key shorter than ${ADMIN_RECOVERY_KEY_MIN_LEN} characters.` +
          ' Delete the file to have a new one generated, or set' +
          ` ${ADMIN_RECOVERY_ENV_VAR} instead.`,
      )
    }
    const secret = existing.raw.slice(0, ADMIN_RECOVERY_KEY_MAX_LEN)
    if (existing.looseMode) {
      try {
        chmodSync(path, 0o600)
        warnings.push(`recovery key file permissions were too open - tightened ${path} to 0600`)
      } catch {
        warnings.push(`recovery key file ${path} is readable by other users - tighten it to 0600`)
      }
    }
    const resolved: AdminRecoveryKey = { secret, source: 'file', path, warnings }
    resolvedByDataDir.set(dir, resolved)
    return resolved
  }

  const secret = generateAdminRecoveryKey()
  writeKeyFileAtomic(path, secret)
  const resolved: AdminRecoveryKey = { secret, source: 'generated', path, warnings }
  resolvedByDataDir.set(dir, resolved)
  return resolved
}
