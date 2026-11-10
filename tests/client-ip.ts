/**
 * TS-SHOP-002: X-Forwarded-For trust gate for bridge rate-limit keys.
 *
 * BRGPROXY-001: plus WHICH entry of a trusted chain wins. Taking the leftmost
 * entry (the original behaviour, which an earlier revision of this suite pinned
 * as correct) let any caller behind an appending reverse proxy choose their own
 * rate-limit bucket and thereby un-cap every per-IP budget in the process.
 *
 * Every case below states its topology, because the whole bug was reasoning
 * about the header without reasoning about who wrote each part of it. The
 * canonical nginx directive is
 *   proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
 * which expands to "<incoming header>, <peer this hop saw>" - it APPENDS, so the
 * only provably-honest entry is the rightmost one each trusted hop contributed.
 */
import {
  TRUSTED_PROXY_HOPS_DEFAULT,
  TRUSTED_PROXY_HOPS_MAX,
  normalizeBridgeIp,
  parseTrustedProxies,
  parseTrustedProxyHops,
  resolveBridgeClientIp,
} from '../src/client-ip.js'

function must(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}

{
  must(normalizeBridgeIp('::ffff:10.1.2.3') === '10.1.2.3', 'mapped ipv4')
  const trusted = parseTrustedProxies('10.0.0.5, 172.18.0.2')
  must(trusted.has('10.0.0.5') && trusted.has('172.18.0.2'), 'trusted set')

  // Untrusted peer: ignore forged XFF entirely (unchanged pre-existing rule).
  const forged = resolveBridgeClientIp('203.0.113.9', '1.2.3.4', trusted)
  must(forged === '203.0.113.9', `untrusted peer uses socket (${forged})`)

  // Direct connection, no proxy, no XFF: the socket peer, unchanged.
  const direct = resolveBridgeClientIp('203.0.113.9', undefined, trusted)
  must(direct === '203.0.113.9', `direct connection (${direct})`)

  // Loopback peer with no XFF: socket. (Local desktop app, or a proxy that
  // forwards no header at all.)
  const localOnly = resolveBridgeClientIp('127.0.0.1', undefined, new Set())
  must(localOnly === '127.0.0.1', 'loopback no XFF')
}

/**
 * THE SPOOF. nginx on the same VPS host, so the peer is loopback and therefore
 * trusted. The caller sends its own X-Forwarded-For; nginx appends the address
 * it actually saw. The client-supplied entry must never win, or each request
 * gets a fresh limiter bucket of the attacker's choosing.
 */
{
  const attackerReal = '203.0.113.66'
  for (const spoof of ['9.9.9.1', '9.9.9.2', '10.0.0.5', '127.0.0.1', 'not-an-ip']) {
    const got = resolveBridgeClientIp('127.0.0.1', `${spoof}, ${attackerReal}`, new Set())
    must(got === attackerReal, `spoofed leftmost "${spoof}" must not win (got ${got})`)
  }

  // Same attack against a non-loopback trusted proxy peer.
  const trusted = parseTrustedProxies('10.0.0.5')
  const viaTrusted = resolveBridgeClientIp('10.0.0.5', `9.9.9.9, ${attackerReal}`, trusted)
  must(viaTrusted === attackerReal, `spoof behind a trusted proxy (${viaTrusted})`)

  // Deep forged prefix: many attacker entries, one honest appended tail.
  const deep = resolveBridgeClientIp(
    '127.0.0.1',
    `1.1.1.1, 2.2.2.2, 3.3.3.3, 4.4.4.4, ${attackerReal}`,
    new Set(),
  )
  must(deep === attackerReal, `deep forged prefix (${deep})`)

  // The bucket key must be STABLE across requests where only the forged prefix
  // changes - that stability is the whole point of the limiter.
  const keys = new Set(
    ['a', 'b', 'c', 'd'].map((_, i) =>
      resolveBridgeClientIp('127.0.0.1', `9.9.9.${i}, ${attackerReal}`, new Set()),
    ),
  )
  must(keys.size === 1, `one attacker must map to one bucket (got ${keys.size})`)
}

/** Honest single proxy (default 1 hop), both directive styles. */
{
  // Appending proxy, caller sent no header of its own.
  const appended = resolveBridgeClientIp('127.0.0.1', '198.51.100.7', new Set())
  must(appended === '198.51.100.7', `single appending proxy (${appended})`)

  // Overwriting proxy (proxy_set_header X-Forwarded-For $remote_addr).
  // Same shape on the wire; must keep working.
  const overwritten = resolveBridgeClientIp('127.0.0.1', '198.51.100.8', new Set())
  must(overwritten === '198.51.100.8', `overwriting proxy (${overwritten})`)

  // Non-loopback trusted proxy, honest chain.
  const trusted = parseTrustedProxies('10.0.0.5')
  const viaProxy = resolveBridgeClientIp('10.0.0.5', '198.51.100.9', trusted)
  must(viaProxy === '198.51.100.9', `trusted proxy honest chain (${viaProxy})`)
}

/** Two trusted hops (CDN or load balancer in front of our own proxy). */
{
  // Client sent nothing: CDN appended the client, our nginx appended the CDN.
  const honest = resolveBridgeClientIp('127.0.0.1', '198.51.100.7, 172.18.0.2', new Set(), 2)
  must(honest === '198.51.100.7', `two honest hops (${honest})`)

  // Client also forged a prefix: still lands on the entry the CDN observed.
  const spoofed = resolveBridgeClientIp(
    '127.0.0.1',
    '9.9.9.9, 198.51.100.7, 172.18.0.2',
    new Set(),
    2,
  )
  must(spoofed === '198.51.100.7', `two hops with forged prefix (${spoofed})`)

  // Three hops configured, three honest entries.
  const three = resolveBridgeClientIp('127.0.0.1', '198.51.100.7, 10.1.1.1, 10.2.2.2', new Set(), 3)
  must(three === '198.51.100.7', `three hops (${three})`)
}

/**
 * Chain SHORTER than the configured hop count: fewer proxies appended than this
 * deployment claims, so nothing in the chain is provably trustworthy. Must fall
 * back to the socket peer, never to a caller-supplied entry.
 */
{
  const short = resolveBridgeClientIp('127.0.0.1', '9.9.9.9', new Set(), 2)
  must(short === '127.0.0.1', `chain shorter than hops falls back to peer (${short})`)

  const shortTrusted = resolveBridgeClientIp(
    '10.0.0.5',
    '9.9.9.9, 8.8.8.8',
    parseTrustedProxies('10.0.0.5'),
    3,
  )
  must(shortTrusted === '10.0.0.5', `short chain behind trusted proxy (${shortTrusted})`)

  // Trusted peer, hops configured, but no header at all.
  const none = resolveBridgeClientIp('127.0.0.1', '', new Set(), 1)
  must(none === '127.0.0.1', `empty header falls back to peer (${none})`)
}

/** hops=0 disables XFF entirely - the correct setting with no proxy in front. */
{
  const off = resolveBridgeClientIp('127.0.0.1', '9.9.9.9, 8.8.8.8', new Set(), 0)
  must(off === '127.0.0.1', `hops=0 ignores XFF (${off})`)

  const offTrusted = resolveBridgeClientIp(
    '10.0.0.5',
    '9.9.9.9',
    parseTrustedProxies('10.0.0.5'),
    0,
  )
  must(offTrusted === '10.0.0.5', `hops=0 behind trusted proxy (${offTrusted})`)
}

/** Hop-count parsing: clamped, never throws, defaults for junk. */
{
  must(parseTrustedProxyHops(undefined) === TRUSTED_PROXY_HOPS_DEFAULT, 'hops default')
  must(parseTrustedProxyHops('') === TRUSTED_PROXY_HOPS_DEFAULT, 'hops blank -> default')
  must(parseTrustedProxyHops('  ') === TRUSTED_PROXY_HOPS_DEFAULT, 'hops whitespace -> default')
  must(parseTrustedProxyHops('nope') === TRUSTED_PROXY_HOPS_DEFAULT, 'hops junk -> default')
  must(parseTrustedProxyHops('2') === 2, 'hops 2')
  must(parseTrustedProxyHops(' 3 ') === 3, 'hops trims')
  must(parseTrustedProxyHops('2.7') === 2, 'hops floors')
  must(parseTrustedProxyHops('0') === 0, 'hops 0 allowed (XFF off)')
  must(parseTrustedProxyHops('-5') === 0, 'hops negative clamps to 0')
  must(parseTrustedProxyHops('999') === TRUSTED_PROXY_HOPS_MAX, 'hops clamps to max')
  must(parseTrustedProxyHops('Infinity') === TRUSTED_PROXY_HOPS_DEFAULT, 'hops Infinity -> default')
  // An out-of-range value passed directly (not via env) is clamped the same way,
  // so no caller can widen trust by passing a big number.
  const huge = resolveBridgeClientIp('127.0.0.1', '9.9.9.9, 203.0.113.66', new Set(), 999)
  must(huge === '127.0.0.1', `absurd hop count cannot widen trust (${huge})`)
}

/**
 * Entry normalization. A port suffix left on the address would give every
 * connection from one caller its own bucket - the same un-capping this module
 * exists to prevent.
 */
{
  const withPort = resolveBridgeClientIp('127.0.0.1', '198.51.100.7:44321', new Set())
  must(withPort === '198.51.100.7', `ipv4 port stripped (${withPort})`)

  const bracketed = resolveBridgeClientIp('127.0.0.1', '[2001:db8::1]:44321', new Set())
  must(bracketed === '2001:db8::1', `bracketed ipv6 port stripped (${bracketed})`)

  const bareV6 = resolveBridgeClientIp('127.0.0.1', '2001:db8::1', new Set())
  must(bareV6 === '2001:db8::1', `bare ipv6 kept intact (${bareV6})`)

  const mappedV6 = resolveBridgeClientIp('127.0.0.1', '::ffff:198.51.100.7', new Set())
  must(mappedV6 === '198.51.100.7', `mapped ipv4 in chain (${mappedV6})`)

  // Junk in the selected slot must fail closed to the peer, not key on junk.
  for (const junk of ['unknown', '_hidden', 'nonsense']) {
    const got = resolveBridgeClientIp('127.0.0.1', junk, new Set())
    must(got === '127.0.0.1', `junk entry "${junk}" falls back to peer (${got})`)
  }
}

/**
 * Repeated headers arrive as an array. Joining in order reconstructs the chain
 * the appending hop actually built; reading only the first element would drop
 * the honest appended tail and hand the caller their forged prefix again.
 */
{
  const arr = resolveBridgeClientIp('127.0.0.1', ['9.9.9.9', '203.0.113.66'], new Set())
  must(arr === '203.0.113.66', `repeated headers join in order (${arr})`)

  const arrHonest = resolveBridgeClientIp('127.0.0.1', ['198.51.100.7'], new Set())
  must(arrHonest === '198.51.100.7', `single-element array (${arrHonest})`)
}

console.log('client-ip: ok')
