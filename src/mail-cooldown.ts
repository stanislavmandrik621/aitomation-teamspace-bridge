import type { MailStore } from './mail-store.js'

/** Concurrent provider responses may extend a cooldown, never shorten it. */
export async function extendMailCooldown(store: MailStore, account: string, until: number): Promise<void> {
  if (!Number.isSafeInteger(until) || until < 0 || until > 8_640_000_000_000_000) throw new Error('Invalid mailbox cooldown')
  for (let attempt = 0; attempt < 16; attempt++) {
    const current = await store.get<{ until: number }>('cooldowns', account)
    if (current && current.value.until >= until) return
    if (await store.batch([{ collection: 'cooldowns', id: account, account, value: { until } }], {
      checks: [{ collection: 'cooldowns', id: account, revision: current?.revision ?? null }],
    })) return
  }
  throw new Error('Mailbox cooldown changed repeatedly')
}
