import { OPS_FRAME_WINDOW_MS } from './throughput.js'
import type {IncomingMessage,ServerResponse} from 'node:http'
import {TeamMemberProfileStore,MemberProfileError,profileId} from './team-member-profile-store.js'
type Auth={member:{memberId:string;role:string};deviceId:string}
export function createTeamMemberProfileHttpHandler(deps:{store:TeamMemberProfileStore;teamId():string;authenticate(req:IncomingMessage):Auth|null;readBody(req:IncomingMessage,max:number,args:{reserveBytes:number;memberId:string}):Promise<unknown>;releaseBody(body:unknown):void;json(res:ServerResponse,status:number,body:unknown):void;drain(req:IncomingMessage):void;takeWrite(memberId:string):boolean;retryAfterSeconds?(memberId:string):number}){
 return async(req:IncomingMessage,res:ServerResponse,url:URL)=>{
  if(!['/api/team-member-profile','/api/team-member-profile/history'].includes(url.pathname))return false
  res.setHeader('Cache-Control','no-store');let body:unknown
  try{
   const auth=deps.authenticate(req);if(!auth)throw new MemberProfileError(401,'Current team session required')
   const teamId=deps.teamId();if(!teamId)throw new MemberProfileError(503,'Team identity is not ready')
   if(req.method==='GET'){
    if(url.searchParams.get('teamId')!==teamId)throw new MemberProfileError(403,'This profile belongs to another team')
    const memberId=profileId(url.searchParams.get('memberId'))
    const data=url.pathname.endsWith('/history')?deps.store.history(teamId,memberId,auth.member.memberId,url.searchParams.has('limit')?Number(url.searchParams.get('limit')):10,url.searchParams.get('cursor')):deps.store.read(teamId,memberId,auth.member.memberId)
    deps.json(res,200,{ok:true,data})
   }else if(req.method==='POST'&&url.pathname==='/api/team-member-profile'&&!url.search){
    if(!deps.takeWrite(auth.member.memberId)){res.setHeader('Retry-After',String(deps.retryAfterSeconds?.(auth.member.memberId) ?? Math.max(1,Math.ceil(OPS_FRAME_WINDOW_MS/1000))));throw new MemberProfileError(429,'Profile request limit reached; retry shortly')}
    body=await deps.readBody(req,24000,{reserveBytes:24000,memberId:auth.member.memberId})
    const fresh=deps.authenticate(req);if(!fresh||fresh.member.memberId!==auth.member.memberId||fresh.deviceId!==auth.deviceId)throw new MemberProfileError(401,'Team session changed')
    if(!body||typeof body!=='object'||(body as any).teamId!==teamId||deps.teamId()!==teamId)throw new MemberProfileError(403,'This profile belongs to another team')
    deps.json(res,200,{ok:true,data:deps.store.save(body,fresh.member.memberId)})
   }else throw new MemberProfileError(405,'Use GET or POST')
  }catch(error){deps.drain(req);deps.json(res,error instanceof MemberProfileError?error.status:503,{ok:false,error:error instanceof MemberProfileError?error.message:'Team profile is unavailable'})}
  finally{deps.releaseBody(body)}return true
 }
}
