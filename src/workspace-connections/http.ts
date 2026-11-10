import type {IncomingMessage,ServerResponse} from 'node:http'
import {TokenBucketLimiter} from '../rate-limit.js'
import {normalizeBridgeIp} from '../client-ip.js'
import {hashSessionToken} from '../store.js'
import {workspaceConnectionActor,type WorkspaceConnections} from './config.js'
import {ConnectionError,object,services,text,provider} from './catalog.js'

type Auth={member:{memberId:string;role:string};deviceId:string}
export interface WorkspaceConnectionsHttpDeps {
  connections:WorkspaceConnections|null;authenticate(req:IncomingMessage):Auth|null;teamId():string
  /** Host-owned trusted-proxy resolver. Without one, only the socket peer is used. */
  clientIp?(req:IncomingMessage):string
  readBody(req:IncomingMessage,max:number,opts:{reserveBytes:number;memberId:string}):Promise<unknown>;releaseBody(body:unknown):void
  json(res:ServerResponse,status:number,body:unknown):void;drain(req:IncomingMessage):void
}
const operations=['capabilities','start','list','update','disconnect','lease','claims.start','claims.status','claims.cancel','advanced.create','advanced.list','advanced.remove','advanced.rotate','prepare','approve','action'] as const
export function createWorkspaceConnectionsHttpHandler(deps:WorkspaceConnectionsHttpDeps){
  const limiter=new TokenBucketLimiter(),callbackLimiter=new TokenBucketLimiter(),inflight=new Map<string,number>();let callbacks=0
  return async(req:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean>=>{
    if(!url.pathname.startsWith('/v1/connections/'))return false
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff')
    const callback=/^\/v1\/connections\/oauth\/(google|microsoft)\/callback$/.exec(url.pathname)
    if(callback&&req.method==='GET'){
      res.setHeader('Content-Type','text/plain; charset=utf-8')
      const source=normalizeBridgeIp(deps.clientIp?deps.clientIp(req):req.socket.remoteAddress??'')||'unknown'
      if(callbacks>=16||!callbackLimiter.take(`callback:${source}`,60,60000)){res.statusCode=429;res.end('Too many sign-in attempts. Start again later.');return true}
      callbacks++
      try {if(!deps.connections||url.search.length>16000)throw Error('Unavailable');await deps.connections.service.callback(provider(callback[1]),url.searchParams);res.statusCode=200;res.end('Account connected to your own server. Return to AItomation and refresh Connections.')}
      catch(error){res.statusCode=error instanceof ConnectionError?error.status:503;res.end(error instanceof ConnectionError?error.message:'Connection could not complete. Return to the app and start sign-in again.')}
      finally{callbacks--}return true
    }
    const operation=url.pathname.slice('/v1/connections/'.length)
    if(req.method!=='POST'||url.search||!operations.includes(operation as typeof operations[number])){deps.drain(req);deps.json(res,404,{ok:false,error:'Unknown connection route'});return true}
    // These endpoints must never accept document bytes or message bodies. All
    // provider operations run in the signed-in desktop process after local review.
    if(['prepare','approve','action'].includes(operation)){deps.drain(req);deps.json(res,409,{ok:false,error:'Use the updated desktop app to run this action directly.',error_code:'connections.native_required'});return true}
    const auth=deps.authenticate(req),teamId=deps.teamId()
    if(!auth||!teamId||auth.member.role==='viewer'){deps.drain(req);deps.json(res,403,{ok:false,error:'An active Team Space member session is required',error_code:'connections.unauthorized'});return true}
    const memberId=auth.member.memberId
    if(!limiter.take(memberId,300,60000)||(inflight.get(memberId)??0)>=16){deps.drain(req);deps.json(res,429,{ok:false,error:'Connections are busy. Retry later.',error_code:'connections.busy'});return true}
    inflight.set(memberId,(inflight.get(memberId)??0)+1);let raw:unknown
    try {
      raw=await deps.readBody(req,16*1024,{reserveBytes:16*1024,memberId})
      const body=object(raw),projectId=text(body.projectId,160),bearer=String(req.headers.authorization??'').replace(/^Bearer /i,'').trim()
      const fresh=deps.authenticate(req)
      if(!fresh||fresh.member.memberId!==memberId||fresh.deviceId!==auth.deviceId||fresh.member.role==='viewer'||teamId!==deps.teamId())throw new ConnectionError('unauthorized','Your Team Space session changed.',403)
      const actor=workspaceConnectionActor({teamId,memberId,deviceId:auth.deviceId,projectId,sessionHash:hashSessionToken(bearer)})
      const connection=deps.connections
      if(!connection){deps.json(res,503,{ok:false,error:'Ask your server administrator to configure Google or Microsoft connections.',error_code:'connections.unconfigured'});return true}
      await connection.ready();await connection.authorize(actor)
      const allowed:Record<string,string[]>={capabilities:['projectId'],list:['projectId'],start:['projectId','provider','services','connectionId','workResources','optionalPermissionIds','expectedGeneration'],update:['projectId','connectionId','services','expectedGeneration'],disconnect:['projectId','connectionId'],lease:['projectId','connectionId'],'advanced.create':['projectId','profile'],'advanced.list':['projectId'],'advanced.remove':['projectId','connectionId'],'advanced.rotate':['projectId','connectionId','profile','expectedGeneration']}
      Object.assign(allowed,{'claims.start':['projectId','connectionId','expectedGeneration','accessEpoch','operationKey','challenge'],'claims.status':['projectId','flowId','operationKey'],'claims.cancel':['projectId','flowId','operationKey']})
      if(Object.keys(body).some(key=>!allowed[operation].includes(key)))throw new ConnectionError('invalid_params','Unexpected connection fields.',400)
      const service=connection.service;let result:unknown
      if(operation==='capabilities')result=connection.capabilities()
      else if(operation==='list')result=await service.list(actor)
      else if(operation==='start')result=await service.start(actor,body)
      else if(operation==='claims.start')result=await service.claimsStart(actor,body)
      else if(operation==='claims.status'||operation==='claims.cancel')result=await service.claimsStatus(actor,text(body.flowId,128),text(body.operationKey,128),operation==='claims.cancel')
      else if(operation==='advanced.create')result=await service.advancedCreate(actor,body.profile)
      else if(operation==='advanced.list')result=await service.advancedList(actor)
      else if(operation==='advanced.remove')result=await service.advancedRemove(actor,text(body.connectionId,160))
      else if(operation==='advanced.rotate')result=await service.advancedRotate(actor,text(body.connectionId,160),body.profile,text(body.expectedGeneration,128))
      else if(operation==='update')result=await service.update(actor,text(body.connectionId,160),services(body.services,true),text(body.expectedGeneration,128))
      else if(operation==='disconnect')result=await service.disconnect(actor,text(body.connectionId,160))
      else if(operation==='lease')result=await service.lease(actor,text(body.connectionId,160))
      deps.json(res,200,result)
    } catch(error){deps.drain(req);deps.json(res,error instanceof ConnectionError?error.status:503,{ok:false,error:error instanceof ConnectionError?error.message:'Connections could not complete. No automatic write retry was performed.',error_code:error instanceof ConnectionError?`connections.${error.code}`:'connections.unavailable'})}
    finally {deps.releaseBody(raw);const count=(inflight.get(memberId)??1)-1;if(count)inflight.set(memberId,count);else inflight.delete(memberId)}
    return true
  }
}
