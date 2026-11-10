/** STAGED extraction of the existing endpoint-provenance identity helper.
 * Only MailOAuthService.exchange may supply endpoint token responses here. */
import { microsoftContextFromEndpointToken, type MicrosoftAuthorizationContext } from './workspace-connections/microsoft-claims-challenge.js'
import { googleEndpointIdentity } from './workspace-connections/google-endpoint-identity.js'
export interface MailEndpointIdentityReceipt { provider: 'google' | 'microsoft'; providerAccountId: string; accountType: 'personal' | 'work'; accountTypeSource: 'provider_identity'; hostedDomain?: string; cloud?: MicrosoftAuthorizationContext['cloud']; tenantId?: string; authorizationContext?: MicrosoftAuthorizationContext }

/** Exact existing Microsoft endpoint-token helper, with its issuer/client/oid/
 * Graph audience restrictions. No email-domain or tenant-config inference. */
export function microsoftMailEndpointIdentity(accessToken: string, clientId: string, accountId: string): MailEndpointIdentityReceipt | undefined {
  const context = microsoftContextFromEndpointToken(accessToken, clientId, accountId)
  return context ? { provider: 'microsoft', providerAccountId: accountId, accountType: context.tenantId === '9188040d-6c67-4c5b-b112-36a304b66dad' ? 'personal' : 'work', accountTypeSource: 'provider_identity', cloud: context.cloud, tenantId: context.tenantId, authorizationContext: context } : undefined
}
export function googleMailEndpointIdentity(raw: unknown, clientId: string, now: number, nonce?: string): MailEndpointIdentityReceipt | undefined {
  const identity = googleEndpointIdentity(raw, clientId, now, nonce)
  return identity ? { provider: 'google', providerAccountId: identity.accountId, accountType: identity.accountType, accountTypeSource: 'provider_identity', ...(identity.hostedDomain ? { hostedDomain: identity.hostedDomain } : {}) } : undefined
}
