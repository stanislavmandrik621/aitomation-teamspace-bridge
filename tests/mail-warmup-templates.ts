import assert from 'node:assert/strict'
import { MAIL_WARMUP_TEMPLATE_COUNT, queryMailWarmupTemplates, getMailWarmupTemplate,
  getMailWarmupTemplateForJob, type MailWarmupTemplate } from '../src/mail-warmup-templates.js'

const all: MailWarmupTemplate[] = []
let offset: number | null = 0
while (offset !== null) {
  const page = queryMailWarmupTemplates({ offset, limit: 100 })
  assert.equal(page.total, MAIL_WARMUP_TEMPLATE_COUNT)
  assert.equal(page.version, 1)
  assert.ok(page.items.length <= 100)
  all.push(...page.items)
  offset = page.nextOffset
}
assert.equal(all.length, 1000)
for (const key of ['id', 'subject', 'message', 'reply'] as const) {
  assert.equal(new Set(all.map(item => item[key])).size, 1000, `all ${key} entries are distinct`)
}
// Distinct copy is not achieved merely by appending a serial number.
for (const key of ['message', 'reply'] as const) {
  assert.equal(new Set(all.map(item => item[key].replace(/Template: mail-test-v1-\d{4}\n/, ''))).size, 1000)
}
for (const item of all) {
  assert.equal(getMailWarmupTemplate(item.id), item)
  assert.ok(Object.isFrozen(item))
  assert.ok(item.subject.startsWith('[Automated mail test]'))
  for (const content of [item.message, item.reply]) {
    assert.match(content, /automated delivery test/)
    assert.match(content, /explicitly enrolled by their owner/)
    assert.match(content, /not a personal message/)
    assert.match(content, /Stop further tests/)
    assert.doesNotMatch(content, /Test reference:|https?:\/\/|<script|[\u2012-\u2015]/)
    assert.ok(content.length < 2000)
  }
  assert.match(item.reply, /verified by the application/)
}
assert.equal(queryMailWarmupTemplates().items.length, 20)
assert.equal(queryMailWarmupTemplates({ search: 'mail-test-v1-1000' }).items[0]?.id, 'mail-test-v1-1000')
assert.equal(queryMailWarmupTemplates({ search: 'does-not-exist' }).total, 0)
assert.deepEqual(queryMailWarmupTemplates({ offset: 1000 }).items, [])
assert.equal(queryMailWarmupTemplates({ offset: 1000 }).nextOffset, null)
assert.equal(getMailWarmupTemplate('mail-test-v1-0000'), undefined)
assert.equal(getMailWarmupTemplate('mail-test-v1-1001'), undefined)
assert.equal(getMailWarmupTemplate('MAIL-TEST-V1-0001'), undefined)
for (const offset of [-1, 1001, NaN, Infinity, 0.5]) assert.throws(() => queryMailWarmupTemplates({ offset }))
for (const limit of [-1, 0, 101, NaN, Infinity, 0.5]) assert.throws(() => queryMailWarmupTemplates({ limit }))
assert.throws(() => queryMailWarmupTemplates({ search: 'x'.repeat(201) }))
assert.throws(() => getMailWarmupTemplateForJob(''))
assert.throws(() => getMailWarmupTemplateForJob('x'.repeat(2049)))
const selected = new Set<string>()
for (let index = 0; index < 20_000; index++) {
  const key = `durable-job-${index}`
  const item = getMailWarmupTemplateForJob(key)
  assert.equal(getMailWarmupTemplateForJob(key), item, 'repeated selection is deterministic')
  selected.add(item.id)
}
assert.equal(selected.size, 1000, 'selection can reach the entire library')
console.log('mail-warmup-templates: 1000 unique disclosed message/reply pairs, immutable bounded preview and deterministic selection passed')
