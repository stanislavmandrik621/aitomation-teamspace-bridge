/** Keep publication provenance in the same atomic file as its guest payload.
 * Never trust a marker nested in a caller payload; only the authenticated HTTP
 * boundary supplies the validated hash. The marker is stripped before serving.
 */
const KEY = '__teamspaceFieldAclBaseHash'
export type GuestFieldAclGuard = (hash: unknown) => boolean
export function stampGuestFieldAclPayload(payload: unknown, hash?: string): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload
  const { [KEY]: _claimed, ...rest } = payload as Record<string, unknown>
  return { ...rest, ...(hash !== undefined ? { [KEY]: hash } : {}) }
}
export function readGuestFieldAclPayload(payload: unknown, guard: GuestFieldAclGuard): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const { [KEY]: hash, ...rest } = payload as Record<string, unknown>
  return guard(hash) ? rest : null
}
