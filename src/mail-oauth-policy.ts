/** Endpoint eligibility is not proof of an OAuth app's configured audience or
 * an organization's approval. Providers remain authoritative at consent time. */
export type MailAccountType = 'personal' | 'work_school'
type Provider = 'google' | 'microsoft'

const tenantGuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const consumerTenant = '9188040d-6c67-4c5b-b112-36a304b66dad'

export function normalizeMailMicrosoftTenant(raw: string = 'common'): string {
  if (typeof raw !== 'string' || /[\u0000-\u001f\u007f]/.test(raw)) throw new Error('Invalid Microsoft mail tenant; use common, organizations, consumers, or a tenant UUID')
  const value = raw.trim()
  const alias = value.toLowerCase()
  if (['common', 'organizations', 'consumers'].includes(alias)) return alias
  // Preserve an existing GUID's case: registration hashes already include it.
  if (tenantGuid.test(value)) return value
  throw new Error('Invalid Microsoft mail tenant; use common, organizations, consumers, or a tenant UUID')
}

export function mailProviderCapabilities(provider: Provider, configured: boolean, tenant = 'common') {
  const audience = provider === 'microsoft' ? normalizeMailMicrosoftTenant(tenant).toLowerCase() : 'common'
  const accountTypes: MailAccountType[] = !configured ? []
    : audience === 'common' ? ['personal', 'work_school']
      : audience === 'consumers' || audience === consumerTenant ? ['personal'] : ['work_school']
  return { configured, accountTypes, adminApprovalPossible: accountTypes.includes('work_school'),
    accountTypesDependOnAppRegistration: configured }
}

export interface MailOAuthFailure { code: string; message: string; status: number }

/** Classify protocol error names, never untrusted error_description text or
 * AADSTS diagnostic numbers. Provider descriptions may contain private data.
 * https://learn.microsoft.com/entra/identity-platform/reference-error-codes
 * https://developers.google.com/identity/protocols/oauth2/web-server#errors */
export function normalizeMailOAuthFailure(provider: Provider, error: unknown, stage: 'callback' | 'token'): MailOAuthFailure {
  const name = typeof error === 'string' && error.length <= 128 ? error : ''
  if (provider === 'google' && name === 'admin_policy_enforced') return {
    code: 'organization_policy', status: 403,
    message: 'Your Google Workspace organization blocks this mail app or its permissions. Ask your Workspace administrator to approve access, then reconnect.',
  }
  if (provider === 'google' && name === 'org_internal') return {
    code: 'account_type', status: 403,
    message: 'This Google app accepts accounts from its configured organization only. Use an eligible Workspace account or ask the server administrator to review the OAuth app audience.',
  }
  if (name === 'access_denied' || name === 'consent_required') return {
    code: name === 'consent_required' ? 'consent_required' : 'oauth_denied', status: 403,
    message: provider === 'microsoft'
      ? 'Microsoft mail access was not approved. Reconnect and complete consent. For a work or school account, your Microsoft 365 administrator may need to approve this app and its mail permissions.'
      : 'Google mail access was not approved. Reconnect and complete consent. For a Workspace account, your administrator may need to approve this app and its mail permissions.',
  }
  if (['invalid_client', 'unauthorized_client', 'invalid_request', 'redirect_uri_mismatch', 'unsupported_response_type'].includes(name)) return {
    code: 'provider_config', status: 503,
    message: provider === 'microsoft'
      ? 'Microsoft rejected the mail app configuration or account audience. Ask the server administrator to check the app credentials, callback URL, tenant and supported account types, then reconnect.'
      : 'Google rejected the mail app configuration. Ask the server administrator to check the OAuth credentials, callback URL and app audience, then reconnect.',
  }
  if (name === 'invalid_scope') return { code: 'scope', status: 403,
    message: 'The provider rejected the requested mail permissions. Ask the server administrator to review the app permissions and organization policy, then reconnect.' }
  if (['server_error', 'temporarily_unavailable'].includes(name)) return { code: 'provider', status: 503,
    message: 'The mailbox provider is temporarily unavailable. Try connecting again later.' }
  if (provider === 'google' && name === 'disallowed_useragent') return { code: 'oauth_browser', status: 400,
    message: 'Google requires authorization in your system browser. Start a new connection and complete sign-in there.' }
  if (['invalid_grant', 'interaction_required', 'login_required'].includes(name) || stage === 'token') return { code: 'reconnect', status: 401,
    message: 'Mailbox authorization expired or requires a new sign-in. Reconnect and complete any sign-in, consent or organization approval requested by the provider.' }
  return { code: 'oauth_denied', status: 400, message: 'Mailbox authorization was not completed. Start a new connection and complete sign-in and consent.' }
}
