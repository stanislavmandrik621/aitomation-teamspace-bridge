/**
 * TS-SHOP-002: resolve caller IP for rate limits without trusting forged
 * X-Forwarded-For from untrusted peers.
 *
 * Trust XFF only when the TCP peer is loopback (local reverse proxy) or in
 * TEAMSPACE_TRUSTED_PROXIES. Otherwise use socket.remoteAddress.
 *
 * BRGPROXY-001: WHICH entry of a trusted chain we take is as load-bearing as
 * whether we trust the header at all. This used to take the LEFTMOST entry,
 * which is always attacker-controlled behind an appending proxy. The standard
 * nginx directive is
 *
 *   proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
 *
 * which expands to "<incoming XFF>, <peer nginx saw>" - it APPENDS. So a client
 * that sends its own `X-Forwarded-For: 9.9.9.9` produces `9.9.9.9, <real ip>`,
 * and on a VPS where nginx runs on the same host (peer is loopback, therefore
 * trusted) the leftmost read handed every rate limiter a fresh attacker-chosen
 * bucket key per request. That silently un-capped every per-IP budget in the
 * process: Admin recovery attempts, hello, guest downloads, public-share anon
 * requests, and portal OTP code requests. The OTP one is the sharpest, because
 * an unlimited request rate mints unlimited fresh 6-digit challenges and each
 * new challenge resets its own 5-wrong-attempts counter.
 *
 * The correct read is right to left: the entry appended by the outermost hop we
 * trust is the only one that hop actually observed. Everything to its left was
 * supplied by whoever called that hop and is unverifiable. How many entries on
 * the right belong to trusted infrastructure is a property of the deployment,
 * not something the header can tell us, so it is explicit configuration
 * (`TEAMSPACE_TRUSTED_PROXY_HOPS`).
 *
 * Deliberately NOT auto-detected by checking whether trailing entries appear in
 * TEAMSPACE_TRUSTED_PROXIES: an attacker can put a known proxy address in their
 * own forged prefix. On a deployment whose proxy overwrites (or with no proxy at
 * all on a loopback peer) the chain is attacker-controlled end to end, so
 * "discard trailing entries that look trusted" would walk right past the real
 * value and land on the forgery again. Counting hops cannot be fooled that way.
 */

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', ''])

/**
 * Trusted hops between a client and this process, i.e. how many entries on the
 * RIGHT of the chain were contributed by infrastructure we control.
 *
 * `1` (the default) is a single reverse proxy in front of the bridge - nginx,
 * Caddy, or a container-network load balancer - which is the topology every
 * documented deployment uses. `0` disables XFF entirely and always uses the
 * socket peer, which is the correct setting when nothing proxies the bridge
 * (a desktop app dialing `ws://127.0.0.1:8788` on the same machine is a
 * loopback peer, so it would otherwise be trusted to describe itself).
 */
export const TRUSTED_PROXY_HOPS_DEFAULT = 1
export const TRUSTED_PROXY_HOPS_MIN = 0
/** More than a handful of chained proxies is a misconfiguration, not a topology. */
export const TRUSTED_PROXY_HOPS_MAX = 8

/** Strip IPv6-mapped IPv4 (`::ffff:1.2.3.4` -> `1.2.3.4`). */
export function normalizeBridgeIp(ip: string): string {
  const s = typeof ip === 'string' ? ip.trim() : ''
  const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  return m ? m[1]! : s
}

export function isLoopbackBridgeIp(ip: string): boolean {
  return LOOPBACK.has(normalizeBridgeIp(ip))
}

/** Parse TEAMSPACE_TRUSTED_PROXIES (comma-separated IPs). */
export function parseTrustedProxies(raw: string | undefined | null): Set<string> {
  const out = new Set<string>()
  if (typeof raw !== 'string' || !raw.trim()) return out
  for (const part of raw.split(',')) {
    const ip = normalizeBridgeIp(part)
    if (ip && !isLoopbackBridgeIp(ip)) out.add(ip)
  }
  return out
}

/**
 * Parse TEAMSPACE_TRUSTED_PROXY_HOPS. Anything unusable (blank, non-numeric,
 * negative, absurd) resolves to the default rather than throwing, because an
 * unparseable value here must not take a running server down - but it is
 * clamped into range so it can never widen trust beyond a real topology.
 */
export function parseTrustedProxyHops(raw: string | undefined | null): number {
  if (typeof raw !== 'string' || !raw.trim()) return TRUSTED_PROXY_HOPS_DEFAULT
  const n = Number(raw.trim())
  if (!Number.isFinite(n)) return TRUSTED_PROXY_HOPS_DEFAULT
  const floored = Math.floor(n)
  if (floored < TRUSTED_PROXY_HOPS_MIN) return TRUSTED_PROXY_HOPS_MIN
  if (floored > TRUSTED_PROXY_HOPS_MAX) return TRUSTED_PROXY_HOPS_MAX
  return floored
}

/**
 * Split an `x-forwarded-for` header into its raw entries, left to right.
 *
 * Repeated headers are concatenated in arrival order rather than taking only
 * the first: a proxy that appends builds its value from the joined incoming
 * header, so joining is the faithful reconstruction of the chain it saw, and
 * reading only the first array element would drop the appended (trusted) tail.
 */
function forwardedChain(xForwardedFor: string | string[] | undefined | null): string[] {
  const joined = Array.isArray(xForwardedFor)
    ? xForwardedFor.filter((v) => typeof v === 'string').join(',')
    : typeof xForwardedFor === 'string'
      ? xForwardedFor
      : ''
  if (!joined.trim()) return []
  return joined.split(',').map((part) => part.trim())
}

/**
 * Normalize one chain entry to a bare address.
 *
 * Some proxies write `1.2.3.4:5678` or `[2001:db8::1]:5678`. Leaving the port on
 * would give every connection from one client its own limiter bucket - the same
 * un-capping this module exists to prevent - so the port is stripped. A bare
 * IPv6 literal keeps its colons untouched. Returns '' for anything that is not
 * a plausible address (`unknown`, `_hidden`, empty), so callers fail closed to
 * the socket peer instead of keying a limiter on junk.
 */
function normalizeChainEntry(entry: string): string {
  const raw = typeof entry === 'string' ? entry.trim() : ''
  if (!raw) return ''
  const bracketed = raw.match(/^\[(.+?)\](?::\d{1,5})?$/)
  const withoutPort = bracketed
    ? bracketed[1]!
    : /^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(raw)
      ? raw.slice(0, raw.lastIndexOf(':'))
      : raw
  const ip = normalizeBridgeIp(withoutPort)
  if (!ip) return ''
  const isIpv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)
  const isIpv6 = ip.includes(':') && /^[0-9a-f:.]+$/i.test(ip)
  return isIpv4 || isIpv6 ? ip : ''
}

/**
 * @param socketRemoteAddress - req.socket.remoteAddress
 * @param xForwardedFor - raw x-forwarded-for header
 * @param trustedProxies - normalized peer IPs allowed to supply XFF
 * @param trustedHops - entries on the RIGHT of the chain contributed by trusted
 *   infrastructure (see `parseTrustedProxyHops`)
 */
export function resolveBridgeClientIp(
  socketRemoteAddress: string | undefined | null,
  xForwardedFor: string | string[] | undefined | null,
  trustedProxies: ReadonlySet<string> = new Set(),
  trustedHops: number = TRUSTED_PROXY_HOPS_DEFAULT,
): string {
  const peer = normalizeBridgeIp(socketRemoteAddress ?? '')
  const fallback = peer || 'unknown'
  const trustXff = isLoopbackBridgeIp(peer) || (peer !== '' && trustedProxies.has(peer))
  if (!trustXff) return fallback

  const hops = parseTrustedProxyHops(String(trustedHops))
  if (hops <= 0) return fallback

  const chain = forwardedChain(xForwardedFor)
  // A chain shorter than the configured hop count means fewer proxies appended
  // than this deployment claims to have, so no entry in it is provably
  // trustworthy. Fall back to the peer rather than accept a client-supplied
  // value - being too strict aggregates honest callers onto one bucket, being
  // too loose hands every caller their own.
  if (chain.length < hops) return fallback

  const claimed = normalizeChainEntry(chain[chain.length - hops] ?? '')
  return claimed || fallback
}
