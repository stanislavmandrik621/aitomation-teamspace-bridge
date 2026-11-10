import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createReadStream, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { TokenBucketLimiter } from './rate-limit.js'

// Only browser resources of this exact installed version; no CDN or arbitrary paths.
const prefix = '/compose/review-assets/6.3.289/'
const require = createRequire(import.meta.url)
const root = dirname(require.resolve('pdfjs-dist/package.json'))
const limiter = new TokenBucketLimiter()
let streams = 0
export function serveComposeReviewAsset(req: IncomingMessage, res: ServerResponse, path: string, ip: string): boolean {
  if (!path.startsWith('/compose/review-assets/')) return false
  const name = path.slice(prefix.length)
  const allowed = path.startsWith(prefix) && /^(?:build\/pdf(?:\.worker)?\.min\.mjs|cmaps\/[A-Za-z0-9_-]+\.bcmap|standard_fonts\/[A-Za-z0-9_.-]+\.(?:ttf|pfb)|wasm\/[A-Za-z0-9_.-]+\.wasm|iccs\/[A-Za-z0-9_.-]+\.icc)$/.test(name)
  if (!allowed || !['GET', 'HEAD'].includes(req.method || '')) { req.resume(); res.writeHead(404); res.end(); return true }
  if (!limiter.take(ip, 240, 10_000) || streams >= 64) { res.writeHead(503, { 'retry-after': '2' }); res.end(); return true }
  const file = join(root, name)
  try {
    const stat = statSync(file)
    if (!stat.isFile()) throw new Error('Unavailable')
    const etag = `"pdfjs-6.3.289-${stat.size}-${Math.floor(stat.mtimeMs)}"`
    res.setHeader('cache-control', 'public, max-age=31536000, immutable')
    res.setHeader('etag', etag)
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('cross-origin-resource-policy', 'same-origin')
    if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return true }
    res.setHeader('content-type', name.endsWith('.mjs') ? 'text/javascript; charset=utf-8' : name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream')
    res.setHeader('content-length', stat.size)
    if (req.method === 'HEAD') { res.writeHead(200); res.end(); return true }
    streams++
    const source = createReadStream(file)
    let released = false
    const release = () => { if (!released) { released = true; streams--; source.destroy() } }
    res.once('close', release); res.once('finish', release)
    source.once('error', () => { if (!res.headersSent) res.writeHead(404); res.end(); release() })
    res.setTimeout(30_000, () => res.destroy())
    source.pipe(res)
  } catch { res.writeHead(404); res.end() }
  return true
}
