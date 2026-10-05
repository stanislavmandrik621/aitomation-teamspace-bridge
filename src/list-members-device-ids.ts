/**
 * Admin Forget-device directory on list_members_ok.
 * Object.keys(sessions), capped raw keys only. Never hashes or tokens.
 * Cap the stored key (NUL stays). Do not NUL-cut: leftover keys stay
 * distinct so Forget can look each one up (BRG-068).
 */

import { capStr } from './text-cap.js'

/** Wire identity cap. Matches store MEMBER_DEVICE_ID_CAP (128). */
export const LIST_MEMBER_DEVICE_ID_CAP = 128
/** Matches store MAX_SESSIONS_PER_MEMBER. A page of keys, never hashes. */
export const LIST_MEMBER_DEVICE_IDS_MAX = 64

const FORBIDDEN_SESSION_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Admin-only device ids from a member's session map.
 * Non-Admin frames must omit the field entirely (caller).
 */
export function listMemberDeviceIdsForAdmin(sessions: unknown): string[] {
  if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of Object.keys(sessions)) {
    if (FORBIDDEN_SESSION_KEYS.has(raw)) continue
    const id = capStr(raw, LIST_MEMBER_DEVICE_ID_CAP)
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= LIST_MEMBER_DEVICE_IDS_MAX) break
  }
  return out
}
