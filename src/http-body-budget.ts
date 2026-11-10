/**
 * BRG-069: in-flight HTTP heap is one question answered one way.
 * Process-wide ceiling plus a per-member share so one member cannot fill
 * the process budget alone. Binary routes (avatar, chat attach, CRM) and
 * Compose JSON pass memberId. Guest / public readers pass a blank
 * memberId and stay process-only.
 */

import {
  MAX_INFLIGHT_HTTP_BODY_BYTES,
  MAX_INFLIGHT_HTTP_BODY_BYTES_PER_MEMBER,
  MAX_INFLIGHT_HTTP_DOWNLOAD_BYTES,
  MAX_INFLIGHT_HTTP_DOWNLOAD_BYTES_PER_MEMBER,
} from './throughput.js'
import { normalizeTeamIdSegment } from './text-cap.js'

const HTTP_BODY_MEMBER_ID_MAX = 128

/**
 * Cheap upper bound checked BEFORE `normalizeMemberId` does any real work
 * (regex NUL-strip, `.trim()`, `.indexOf('\0')`, surrogate repair - all
 * O(length) passes over the raw string). Every real caller passes a short,
 * server-minted `auth.member.memberId`, so in normal operation this never
 * fires. It exists purely so a FUTURE caller regression that accidentally
 * passes something unbounded (a whole request body, a JWT, a base64 blob)
 * as `memberId` cannot turn every single HTTP request's budget check into
 * multiple full-string scans of an attacker-sized value - fail closed to
 * "blank/process-only" immediately instead (same cheap-before-expensive
 * ordering BRG-057's Accept-header cap uses in `health-page.ts`). Deliberately
 * generous relative to `HTTP_BODY_MEMBER_ID_MAX` (32x) so it can never reject
 * a real id, only a pathological one.
 */
const HTTP_BODY_MEMBER_ID_SANITY_MAX = HTTP_BODY_MEMBER_ID_MAX * 32

/**
 * Defensive ceiling on the number of DISTINCT member keys either budget map
 * (`memberUsed` / `downloadMemberUsed`) will ever hold at once. Every real
 * caller passes a stable, authenticated `memberId`, so under normal
 * operation the map's cardinality is bounded by the self-hosted team's real
 * member count (which self-hosters can already scale via
 * `TEAMSPACE_MAX_WS_CONNECTIONS`, whose own documented ceiling is 20,000).
 * This constant exists purely as a backstop against a FUTURE caller
 * regression that mints a fresh, never-repeated key per call (e.g. a bug
 * that passes a per-request id instead of the stable member id) - without
 * it, that class of bug grows these maps without bound for as long as the
 * process runs, a slow OOM with no operator-visible cause. Deliberately a
 * fixed internal constant rather than a `TEAMSPACE_*` env var (same
 * decision as `AMBIENT_TEAMSPACE_HOP_TTL_MS`/`TEAMSPACE_MAX_HOP`): no real
 * self-hosted team is anywhere near this size, so there is nothing for an
 * operator to usefully tune, and hitting it always means "this process is
 * tracking an implausible number of distinct member keys", never "a real
 * team outgrew its own settings." Hitting the cap only REFUSES admitting
 * one more brand-new key (kind: 'process' - this protects the whole
 * process's heap, not any one member's fair share); it never evicts an
 * existing member's live, in-flight reservation to make room.
 */
const HTTP_BODY_BUDGET_MAX_TRACKED_MEMBERS = 50_000

export type HttpBodyBudgetRefuseKind = 'process' | 'member'

export type HttpBodyBudgetReserveResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: HttpBodyBudgetRefuseKind }

export const HTTP_BODY_BUDGET_PROCESS_BUSY =
  'Server is busy handling other uploads. Try again shortly.'

export const HTTP_BODY_BUDGET_MEMBER_SHARE_BUSY =
  'You have too many uploads in progress. Wait for one to finish, then try again.'

export const HTTP_DOWNLOAD_BUDGET_PROCESS_BUSY =
  'Server is busy serving other downloads. Try again shortly.'

export const HTTP_DOWNLOAD_BUDGET_MEMBER_SHARE_BUSY =
  'You have too many downloads in progress. Wait for one to finish, then try again.'

export function httpBodyBudgetRefuseMessage(kind: HttpBodyBudgetRefuseKind): string {
  return kind === 'member'
    ? HTTP_BODY_BUDGET_MEMBER_SHARE_BUSY
    : HTTP_BODY_BUDGET_PROCESS_BUSY
}

export function httpDownloadBudgetRefuseMessage(kind: HttpBodyBudgetRefuseKind): string {
  return kind === 'member'
    ? HTTP_DOWNLOAD_BUDGET_MEMBER_SHARE_BUSY
    : HTTP_DOWNLOAD_BUDGET_PROCESS_BUSY
}

let processUsed = 0
const memberUsed = new Map<string, number>()
let downloadProcessUsed = 0
const downloadMemberUsed = new Map<string, number>()

/**
 * Cumulative net bytes currently reserved via calls with NO memberId (guest
 * reads, unauthenticated JSON bodies - "process-only by design", see module
 * doc). `memberUsed`/`downloadMemberUsed` give every AUTHENTICATED caller's
 * release a per-member clamp (see `releaseMemberTrackedBytes`); before this,
 * the blank path had no equivalent - a caller bug that double-releases or
 * over-releases on the BLANK path flowed straight into the shared
 * `processUsed`/`downloadProcessUsed` counter unclamped except by the final
 * non-negative floor, so it could still zero out (or under-report) bytes
 * that authenticated MEMBERS legitimately still have in flight. These two
 * scalars close that gap with the same clamp discipline, without adding any
 * new ceiling on blank/guest traffic itself (still bounded by the process-wide
 * ceiling alone, never the per-member one - unchanged contract).
 */
let blankBodyUsed = 0
let blankDownloadUsed = 0

function normalizeMemberId(memberId: string | undefined): string | null {
  if (typeof memberId !== 'string') return null
  // See HTTP_BODY_MEMBER_ID_SANITY_MAX doc: reject a pathologically long
  // value before paying for normalizeTeamIdSegment's O(length) work on it.
  if (memberId.length > HTTP_BODY_MEMBER_ID_SANITY_MAX) return null
  const trimmed = normalizeTeamIdSegment(memberId, HTTP_BODY_MEMBER_ID_MAX)
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Reserve `maxBytes` (the route ceiling, not the unknown body size) against
 * the process budget and, when memberId is non-blank, that member's share.
 * Check both ceilings before mutating either counter.
 */
export function tryReserveHttpBodyBudget(
  maxBytes: number,
  memberId?: string,
): HttpBodyBudgetReserveResult {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    return { ok: false, kind: 'process' }
  }
  const bytes = Math.floor(maxBytes)
  if (processUsed + bytes > MAX_INFLIGHT_HTTP_BODY_BYTES) {
    return { ok: false, kind: 'process' }
  }
  const member = normalizeMemberId(memberId)
  if (member) {
    // Defense-in-depth against unbounded Map growth (see
    // HTTP_BODY_BUDGET_MAX_TRACKED_MEMBERS doc): refuse admitting a
    // brand-new distinct member key once at the cap; a member already
    // tracked keeps reserving normally even while the map sits at the cap.
    if (!memberUsed.has(member) && memberUsed.size >= HTTP_BODY_BUDGET_MAX_TRACKED_MEMBERS) {
      return { ok: false, kind: 'process' }
    }
    const used = memberUsed.get(member) ?? 0
    if (used + bytes > MAX_INFLIGHT_HTTP_BODY_BYTES_PER_MEMBER) {
      return { ok: false, kind: 'member' }
    }
  }
  processUsed += bytes
  if (member) {
    memberUsed.set(member, (memberUsed.get(member) ?? 0) + bytes)
  } else {
    blankBodyUsed += bytes
  }
  return { ok: true }
}

/**
 * Decrement `map`'s tracked share for `member` by at most what is actually
 * tracked, and return the amount that was actually refunded (always
 * `<= bytes`, and `0` when this member has nothing tracked at all).
 *
 * A caller is expected to release each reservation exactly once, but this
 * module has no per-call reservation ledger (see the module doc), so it
 * cannot itself detect a double-release or an over-release (a caller
 * regression that releases more bytes than it actually reserved). Without
 * this clamp, either bug would flow straight into the SHARED process-wide
 * counter via a raw `processUsed -= bytes`, permanently under-reporting
 * how much is really in flight and silently eroding the ceiling that
 * protects EVERY OTHER member's uploads/downloads from OOM (BRG-069: "one
 * question answered one way" - the process-wide number must always be
 * trustworthy, not just non-negative). Clamping the refund to
 * `Math.min(bytes, used)` means one member's cumulative releases can never
 * exceed that SAME member's own cumulative net reservations, so a bug in
 * how one member's request is released can never borrow against, corrupt,
 * or falsely inflate the process-wide budget beyond what that member
 * legitimately held - it can only, at worst, zero out that member's own
 * tracked share early. A blank `memberId` (guest/public reads, process-only
 * by design) has no map entry, so it is clamped separately against the
 * `blankBodyUsed`/`blankDownloadUsed` scalars at each call site below with
 * the same discipline (Math.min against cumulative net reservations).
 */
function releaseMemberTrackedBytes(map: Map<string, number>, member: string, bytes: number): number {
  const used = map.get(member)
  if (used === undefined) return 0
  const refund = Math.min(bytes, used)
  const next = used - refund
  if (next <= 0) map.delete(member)
  else map.set(member, next)
  return refund
}

export function releaseHttpBodyBudget(maxBytes: number, memberId?: string): void {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return
  // `bytes` is narrowed to the actual tracked refund (member map, or the
  // blank-bucket scalar - see releaseMemberTrackedBytes / blankBodyUsed
  // doc) before it ever reaches the process-wide counter below, so that
  // counter can never be over-decremented by a caller bug on EITHER path
  // even though it still reads as a plain, unconditional subtract-then-clamp.
  let bytes = Math.floor(maxBytes)
  const member = normalizeMemberId(memberId)
  if (member) {
    bytes = releaseMemberTrackedBytes(memberUsed, member, bytes)
  } else {
    const refund = Math.min(bytes, blankBodyUsed)
    blankBodyUsed -= refund
    bytes = refund
  }
  processUsed = Math.max(0, processUsed - bytes)
}

/** In-memory process reserve (worst-case, not bytes on the wire). */
export function inflightHttpBodyBudgetUsed(): number {
  return processUsed
}

/**
 * Number of distinct members currently holding a non-zero upload share.
 * Exposed so an operator-facing metrics surface can show headroom against
 * `HTTP_BODY_BUDGET_MAX_TRACKED_MEMBERS` - without this, an operator has no
 * way to notice a caller-regression member-key explosion before it starts
 * refusing brand-new members with the generic "server busy" message.
 */
export function trackedHttpBodyBudgetMemberCount(): number {
  return memberUsed.size
}

/**
 * Sanitize an untrusted byte count for the download/exists-skip budget.
 * Non-finite (NaN, +-Infinity), non-number-typed, and non-positive values
 * all collapse to 0 - the same "nothing to charge" outcome as a real zero
 * (HEAD-style / empty verify), never an error.
 *
 * This is not just style parity with `tryReserveHttpBodyBudget`'s explicit
 * `Number.isFinite` guard (which already protects the upload/body side):
 * the previous `Math.max(0, Math.floor(Number(bytes)) || 0)` expression
 * left a real hole on the RELEASE side specifically. `Math.floor(Infinity)`
 * is `Infinity` (truthy, so the `|| 0` fallback never fires), so
 * `releaseHttpDownloadBudget(Infinity, memberId)` reached
 * `downloadProcessUsed = Math.max(0, downloadProcessUsed - Infinity)`,
 * which is `Math.max(0, -Infinity)` = 0 - silently zeroing the ENTIRE
 * shared process-wide download counter regardless of what every OTHER
 * member currently has legitimately in flight. That corrupts cross-member
 * accounting (the process ceiling now reads as "fully free" even while
 * other members' downloads are genuinely still buffered) and defeats the
 * exact OOM protection this budget exists to provide. Reserve already
 * refused an `Infinity` byte count (any finite ceiling comparison against
 * `Infinity` is `true`), so only release was exposed - but both paths are
 * hardened here so this can never regress from either direction.
 */
function sanitizeDownloadByteCount(bytes: number): number {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return 0
  return Math.floor(bytes)
}

/**
 * Download / exists-skip heap. Zero-byte reserve succeeds without charging
 * (HEAD-style / empty verify). Blank memberId is process-only.
 */
export function tryReserveHttpDownloadBudget(
  bytes: number,
  memberId?: string,
): HttpBodyBudgetReserveResult {
  const n = sanitizeDownloadByteCount(bytes)
  if (n <= 0) return { ok: true }
  if (downloadProcessUsed + n > MAX_INFLIGHT_HTTP_DOWNLOAD_BYTES) {
    return { ok: false, kind: 'process' }
  }
  const member = normalizeMemberId(memberId)
  if (member) {
    // Same defense-in-depth as tryReserveHttpBodyBudget - see
    // HTTP_BODY_BUDGET_MAX_TRACKED_MEMBERS doc.
    if (!downloadMemberUsed.has(member) && downloadMemberUsed.size >= HTTP_BODY_BUDGET_MAX_TRACKED_MEMBERS) {
      return { ok: false, kind: 'process' }
    }
    const used = downloadMemberUsed.get(member) ?? 0
    if (used + n > MAX_INFLIGHT_HTTP_DOWNLOAD_BYTES_PER_MEMBER) {
      return { ok: false, kind: 'member' }
    }
  }
  downloadProcessUsed += n
  if (member) {
    downloadMemberUsed.set(member, (downloadMemberUsed.get(member) ?? 0) + n)
  } else {
    blankDownloadUsed += n
  }
  return { ok: true }
}

export function releaseHttpDownloadBudget(bytes: number, memberId?: string): void {
  // Same per-member (or blank-bucket) refund narrowing as
  // releaseHttpBodyBudget - see releaseMemberTrackedBytes / blankDownloadUsed
  // doc - before the process-wide counter below.
  let n = sanitizeDownloadByteCount(bytes)
  if (n <= 0) return
  const member = normalizeMemberId(memberId)
  if (member) {
    n = releaseMemberTrackedBytes(downloadMemberUsed, member, n)
  } else {
    const refund = Math.min(n, blankDownloadUsed)
    blankDownloadUsed -= refund
    n = refund
  }
  downloadProcessUsed = Math.max(0, downloadProcessUsed - n)
}

export function inflightHttpDownloadBudgetUsed(): number {
  return downloadProcessUsed
}

/** Same headroom signal as trackedHttpBodyBudgetMemberCount, download side. */
export function trackedHttpDownloadBudgetMemberCount(): number {
  return downloadMemberUsed.size
}

/** Test isolation only. Production callers never reset the live counters. */
export function resetHttpBodyBudgetForTests(): void {
  processUsed = 0
  memberUsed.clear()
  blankBodyUsed = 0
  downloadProcessUsed = 0
  downloadMemberUsed.clear()
  blankDownloadUsed = 0
}
