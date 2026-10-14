import type { AtRestKey } from './at-rest.js'
import { MailOAuthService } from './mail-oauth-service.js'

/** Optional feature. Partial configuration is refused, never plaintext fallback. */
export function createConfiguredMailService(dataDir: string, key: AtRestKey | null, env: NodeJS.ProcessEnv = process.env): MailOAuthService | null {
  const names = ['TEAMSPACE_MAIL_PUBLIC_URL', 'TEAMSPACE_MAIL_GOOGLE_CLIENT_ID', 'TEAMSPACE_MAIL_GOOGLE_CLIENT_SECRET',
    'TEAMSPACE_MAIL_MICROSOFT_CLIENT_ID', 'TEAMSPACE_MAIL_MICROSOFT_CLIENT_SECRET', 'TEAMSPACE_MAIL_MICROSOFT_TENANT']
  if (!names.some(name => env[name])) return null
  if (!key) throw new Error('Self-hosted mail requires TEAMSPACE_AT_REST_KEY')
  const publicUrl = env.TEAMSPACE_MAIL_PUBLIC_URL ?? ''
  const url = new URL(publicUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('TEAMSPACE_MAIL_PUBLIC_URL must be an HTTPS origin without path or credentials')
  }
  const provider = (prefix: string) => {
    const clientId = env[`${prefix}_CLIENT_ID`]
    const clientSecret = env[`${prefix}_CLIENT_SECRET`]
    if (!clientId && !clientSecret) return undefined
    if (!clientId?.trim() || !clientSecret?.trim() || clientId.length > 4096 || clientSecret.length > 4096) {
      throw new Error('Incomplete self-hosted mail provider configuration')
    }
    return { clientId, clientSecret }
  }
  const google = provider('TEAMSPACE_MAIL_GOOGLE')
  const ms = provider('TEAMSPACE_MAIL_MICROSOFT')
  const tenant = env.TEAMSPACE_MAIL_MICROSOFT_TENANT || 'common'
  if (!/^(common|organizations|consumers|[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})$/.test(tenant)) {
    throw new Error('Invalid Microsoft mail tenant; use common, organizations, consumers, or a tenant UUID')
  }
  if (!google && !ms) throw new Error('Self-hosted mail needs at least one configured provider')
  const integer = (name: string, fallback: number, min: number, max: number) => {
    if (env[name] === undefined) return fallback
    const value = Number(env[name])
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('Invalid enterprise mail capacity configuration')
    return value
  }
  return new MailOAuthService({ dataDir, key, publicUrl: url.origin, google, microsoft: ms ? { ...ms, tenant } : undefined,
    maxConnections: integer('TEAMSPACE_MAIL_MAX_CONNECTIONS', 20_000, 1000, 100_000),
    maxConnectionsPerScope: integer('TEAMSPACE_MAIL_MAX_CONNECTIONS_PER_SCOPE', 2000, 1000, 20_000),
    workers: integer('TEAMSPACE_MAIL_WORKERS', 8, 1, 32),
    maxQueued: integer('TEAMSPACE_MAIL_MAX_OUTBOX_RECORDS', 1_000_000, 10_000, 5_000_000),
  })
}
