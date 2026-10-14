/** Original application-authored sample copy. Shared by the standalone server,
 * desktop runtime and AI preview tools; no credentials, network or dependencies.
 * These are disclosed delivery tests, never simulated personal correspondence.
 */
export interface MailWarmupTemplate {
  readonly id: string
  readonly subject: string
  readonly message: string
  readonly reply: string
}
export const MAIL_WARMUP_TEMPLATE_COUNT = 1000
export const MAIL_WARMUP_TEMPLATE_VERSION = 1

const topics = [
  ['plain text', 'A short plain-text sentence is included in this sample.'],
  ['paragraph spacing', 'First sample paragraph.\n\nSecond sample paragraph.'],
  ['numbered lines', '1. Sample entry one\n2. Sample entry two\n3. Sample entry three'],
  ['bullet lines', '- Sample item alpha\n- Sample item beta\n- Sample item gamma'],
  ['punctuation', 'Sample punctuation: commas, periods. Parentheses (sample); colon: test.'],
  ['mixed case', 'Sample case variations: lowercase, UPPERCASE and Title Case.'],
  ['accented letters', 'Sample accented text: cafe, caf\u00e9, r\u00e9sum\u00e9, ma\u00f1ana.'],
  ['quoted text', 'Quoted sample: "This is test content, not a request for work."'],
  ['numeric text', 'Sample numbers: 0, 7, 42, 1000 and 12345.6789.'],
  ['date text', 'Sample date strings: 2030-01-15 and 15 January 2030. These are examples, not appointments.'],
  ['time text', 'Sample time strings: 08:30, 14:45 and 23:59 UTC. No meeting is scheduled.'],
  ['identifier text', 'Sample identifiers: SAMPLE-A1, SAMPLE-B2 and SAMPLE-C3.'],
  ['short lines', 'One short sample line.\nAnother short sample line.\nA final short sample line.'],
  ['long lines', 'This deliberately longer sample sentence contains ordinary words so the mail application can display a line that may wrap according to the available reading width.'],
  ['symbols', 'Sample symbols: + = / % & # @. These characters are inert text.'],
  ['whitespace', 'Sample spacing: one space | two  spaces | three   spaces.'],
  ['international text', 'Sample international text: Hola. Bonjour. Guten Tag. Ciao.'],
  ['key value lines', 'Sample name: Delivery test\nSample mode: Automated\nSample content: Inert'],
  ['section headings', 'SAMPLE START\nThis section contains inert test text.\nSAMPLE END'],
  ['status vocabulary', 'Sample words: queued, accepted, received, paused. These words do not assert a live delivery status.'],
] as const
const observations = [
  'The sample includes a small amount of ordinary text.',
  'The sample can be viewed as plain text in a mail reader.',
  'The sample does not require the recipient to click anything.',
  'The sample does not include a file or an embedded image.',
  'The sample does not contain private business information.',
  'The sample is part of a limited automated exchange.',
  'The sample does not ask a person to perform a task.',
  'The sample carries no marketing offer or advertisement.',
  'The sample is not intended to resemble a personal conversation.',
  'The sample can be identified by its automated-test subject.',
] as const
const variants = [
  ['baseline', 'This is a baseline content sample.', 'This is the baseline reply sample.'],
  ['compact', 'This is a compact content sample.', 'This is the compact reply sample.'],
  ['readable', 'This is a readability content sample.', 'This is the readability reply sample.'],
  ['structured', 'This is a structured content sample.', 'This is the structured reply sample.'],
  ['follow-up', 'This is a follow-up content sample.', 'This is the follow-up reply sample.'],
] as const
const disclosure = 'This is an automated delivery test between mailboxes explicitly enrolled by their owner. It is not a personal message.'
const footer = 'Only a verified receipt can schedule the next finite test reply. No artificial opens, clicks or spam-folder changes are performed. Stop further tests in Communications > Warm-up.'

function templateAt(index: number): MailWarmupTemplate {
  const topic = topics[Math.floor(index / 50)]!
  const observation = observations[Math.floor(index / 5) % 10]!
  const variant = variants[index % 5]!
  const id = `mail-test-v1-${String(index + 1).padStart(4, '0')}`
  return Object.freeze({ id,
    subject: `[Automated mail test] ${topic[0]} - ${variant[0]} - ${String(Math.floor(index / 5) % 10 + 1).padStart(2, '0')}`,
    message: `${disclosure}\n\n${variant[1]}\n${topic[1]}\n\n${observation}\n\nTemplate: ${id}\n${footer}`,
    reply: `${disclosure}\n\nThe preceding test message was verified by the application before this reply was scheduled. ${variant[2]}\n${topic[1]}\n\n${observation}\n\nTemplate: ${id}\n${footer}`,
  })
}
const catalog: readonly MailWarmupTemplate[] = Object.freeze(Array.from({ length: MAIL_WARMUP_TEMPLATE_COUNT }, (_, index) => templateAt(index)))

export function getMailWarmupTemplate(id: string): MailWarmupTemplate | undefined {
  if (typeof id !== 'string' || !/^mail-test-v1-\d{4}$/.test(id)) return undefined
  const index = Number(id.slice(-4)) - 1
  return index >= 0 && index < catalog.length ? catalog[index] : undefined
}

/** Stable selection from a durable job/root ID. Not a random-send policy or a
 * guarantee that all templates will be sent; existing rate/consent rules apply. */
export function getMailWarmupTemplateForJob(jobId: string): MailWarmupTemplate {
  if (typeof jobId !== 'string' || !jobId || jobId.length > 2048) throw new Error('A bounded durable mail test ID is required')
  let value = 2166136261
  for (let index = 0; index < jobId.length; index++) value = Math.imul(value ^ jobId.charCodeAt(index), 16777619) >>> 0
  return catalog[value % catalog.length]!
}

/** Preview-only library. Does not include the per-send cryptographic proof and
 * never enrolls mailboxes, changes consent, queues jobs or sends a message. */
export function queryMailWarmupTemplates(options: { offset?: number; limit?: number; search?: string } = {}) {
  const offset = options.offset ?? 0, limit = options.limit ?? 20, search = options.search ?? ''
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAIL_WARMUP_TEMPLATE_COUNT) throw new Error('Template offset must be from 0 to 1000')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Template page size must be from 1 to 100')
  if (typeof search !== 'string' || search.length > 200) throw new Error('Template search must be at most 200 characters')
  const needle = search.trim().toLowerCase()
  const selected = needle ? catalog.filter(item => `${item.id}\n${item.subject}\n${item.message}\n${item.reply}`.toLowerCase().includes(needle)) : catalog
  const items = selected.slice(offset, offset + limit)
  return { version: MAIL_WARMUP_TEMPLATE_VERSION, total: selected.length, offset, limit,
    nextOffset: offset + items.length < selected.length ? offset + items.length : null, items }
}
