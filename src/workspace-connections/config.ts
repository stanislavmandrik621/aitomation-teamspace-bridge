import { createHash } from 'node:crypto'
import type { AtRestKey } from '../at-rest.js'
import { normalizeMailMicrosoftTenant, mailProviderCapabilities } from '../mail-oauth-policy.js'
import { ManagedConnectionService, type Actor } from './service.js'
import type { BrokerConfig } from './crypto.js'
import { fail } from './catalog.js'
import { SelfhostConnectionStore } from './store.js'

export interface WorkspaceConnectionIdentity {teamId:string;memberId:string;deviceId:string;projectId:string;sessionHash:string}
export function workspaceConnectionActor(identity:WorkspaceConnectionIdentity):Actor {
  for(const value of [identity?.teamId,identity?.memberId,identity?.deviceId,identity?.projectId,identity?.sessionHash])if(typeof value!=='string'||!value||value.length>256||/[\u0000-\u001f\u007f]/.test(value))fail('unauthorized','A current Team Space member, device and project are required.',403)
  return {userId:JSON.stringify([identity.teamId,identity.memberId,identity.deviceId]),projectId:identity.projectId,tokenId:identity.sessionHash}
}
export function actorWorkspaceIdentity(actor:Actor):WorkspaceConnectionIdentity {
  try {const owner=JSON.parse(actor.userId);if(!Array.isArray(owner)||owner.length!==3)throw Error('Invalid identity');const [teamId,memberId,deviceId]=owner;const identity={teamId,memberId,deviceId,projectId:actor.projectId,sessionHash:actor.tokenId};workspaceConnectionActor(identity);return identity}
  catch {return fail('unauthorized','The Team Space identity is no longer valid.',403)}
}
export function createConfiguredWorkspaceConnections(dataDir:string,key:AtRestKey|null,isCurrent:(identity:WorkspaceConnectionIdentity)=>boolean,env:NodeJS.ProcessEnv=process.env,fetcher:typeof fetch=fetch){
  const value=(suffix:string)=>env[`TEAMSPACE_CONNECTIONS_${suffix}`]??env[`TEAMSPACE_MAIL_${suffix}`]
  if(!['PUBLIC_URL','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','MICROSOFT_CLIENT_ID','MICROSOFT_CLIENT_SECRET'].some(suffix=>value(suffix)))return null
  if(!key)throw Error('Self-hosted connections require TEAMSPACE_AT_REST_KEY')
  let url:URL
  try{url=new URL(value('PUBLIC_URL')??'')}catch{throw Error('Self-hosted connections need an HTTPS public origin')}
  if(url.protocol!=='https:'||url.pathname!=='/'||url.username||url.password||url.search||url.hash)throw Error('Self-hosted connections need an HTTPS public origin')
  const providers:BrokerConfig['providers']={}
  for(const provider of ['google','microsoft'] as const){
    const prefix=provider.toUpperCase()
    // Credentials form one registration. Never combine a new client ID with a
    // legacy mail secret (or the reverse) when only one new field was supplied.
    const specific=env[`TEAMSPACE_CONNECTIONS_${prefix}_CLIENT_ID`]!==undefined||env[`TEAMSPACE_CONNECTIONS_${prefix}_CLIENT_SECRET`]!==undefined
    const namespace=specific?'TEAMSPACE_CONNECTIONS':'TEAMSPACE_MAIL'
    const clientId=env[`${namespace}_${prefix}_CLIENT_ID`]?.trim(),clientSecret=env[`${namespace}_${prefix}_CLIENT_SECRET`]?.trim()
    if(!clientId&&!clientSecret)continue
    if(!clientId||!clientSecret||clientId.length>4096||clientSecret.length>4096||/[\u0000-\u001f\u007f]/.test(clientId+clientSecret))throw Error('Incomplete or invalid self-hosted provider configuration')
    providers[provider]={clientId,clientSecret,...(provider==='microsoft'?{tenant:normalizeMailMicrosoftTenant(value('MICROSOFT_TENANT')??'common')}:{})}
  }
  const storage=new SelfhostConnectionStore(dataDir,key)
  let closing=false
  // Domain separation from existing mail and any managed-cloud deployment.
  const config:BrokerConfig={key:createHash('sha256').update(key.key).update('selfhost-workspace-connections-v1').digest(),publicUrl:url.origin,providers}
  // BYO registrations are authorized by the private Team Space, independently
  // of managed-cloud subscription entitlement.
  const authorize=async(actor:Actor)=>{if(closing)fail('unavailable','The server is shutting down. Reconnect shortly.',503);if(!isCurrent(actorWorkspaceIdentity(actor)))fail('unauthorized','Your Team Space session changed. Reconnect to your server.',403)}
  const service=new ManagedConnectionService(config,storage,authorize,fetcher,Date.now,{callbackPath:provider=>`/v1/connections/oauth/${provider}/callback`})
  return {service,ready:()=>storage.ready(),beginShutdown:()=>{closing=true},close:()=>{closing=true;return storage.close()},authorize,
    capabilities:()=>{const capability=service.capabilities(true);return {...capability,hosting:'selfhosted',providers:capability.providers.map(row=>({...row,...mailProviderCapabilities(row.provider,!!providers[row.provider],providers[row.provider]?.tenant)}))}}}
}
export type WorkspaceConnections=NonNullable<ReturnType<typeof createConfiguredWorkspaceConnections>>
