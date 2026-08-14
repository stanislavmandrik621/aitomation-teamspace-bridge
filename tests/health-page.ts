/**
 * BRG-057: GET / and /health Accept-negotiate HTML for browsers, keep the
 * historic plain body for probes. server.ts cannot be imported (starts
 * HTTP/WS); route pins are source scans.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  HEALTH_ACCEPT_HEADER_MAX,
  HEALTH_PLAIN_BODY,
  HEALTH_PROBE_MAX_BYTES,
  healthPageHtml,
  wantsHealthHtml,
} from '../src/health-page.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const serverSrc = readFileSync(join(root, 'src/server.ts'), 'utf8')

const CHROME_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'

describe('BRG-057 health page', () => {
  it('plain body is the historic probe line', () => {
    assert.equal(HEALTH_PLAIN_BODY, 'AItomation Team Space bridge\n')
  })

  it('wantsHealthHtml only when Accept includes text/html', () => {
    assert.equal(wantsHealthHtml(undefined), false)
    assert.equal(wantsHealthHtml(null), false)
    assert.equal(wantsHealthHtml(''), false)
    assert.equal(wantsHealthHtml('*/*'), false)
    assert.equal(wantsHealthHtml('text/plain'), false)
    assert.equal(wantsHealthHtml('text/plain, */*'), false)
    assert.equal(wantsHealthHtml(CHROME_ACCEPT), true)
    assert.equal(wantsHealthHtml('text/html'), true)
    assert.equal(wantsHealthHtml('TEXT/HTML;q=1'), true)
    assert.equal(wantsHealthHtml('a'.repeat(HEALTH_ACCEPT_HEADER_MAX + 1)), false)
  })

  it('HTML stays under the probe byte cap and still looks like the team server', () => {
    const html = healthPageHtml()
    const bytes = Buffer.byteLength(html, 'utf8')
    assert.ok(bytes < HEALTH_PROBE_MAX_BYTES, `html ${bytes} < ${HEALTH_PROBE_MAX_BYTES}`)
    const lower = html.toLowerCase()
    assert.ok(lower.includes('aitomation'))
    assert.ok(lower.includes('team space'))
    assert.ok(html.includes('Team server is running'))
    assert.ok(html.includes('Up'))
    assert.doesNotMatch(html, /<script/i)
    assert.doesNotMatch(html, /—|–|…/)
    assert.doesNotMatch(html, /\bbridge\b/i)
  })

  it('health stays before takeHttpToken and Accept-negotiates', () => {
    const healthIdx = serverSrc.indexOf('health/root probes must not share')
    const tokenIdx = serverSrc.indexOf('if (!takeHttpToken(ip))')
    assert.ok(healthIdx > 0, 'TCC-R1149-BRG-004 comment present')
    assert.ok(tokenIdx > healthIdx, 'health handler before takeHttpToken')
    assert.match(serverSrc, /wantsHealthHtml\(/)
    assert.match(serverSrc, /HEALTH_PLAIN_BODY/)
    assert.match(serverSrc, /healthPageHtml\(/)
    assert.match(serverSrc, /from '\.\/health-page\.js'/)
  })
})
