import type { IncomingMessage, ServerResponse } from 'node:http'
import { OfficeObjectError, type OfficeObjectCommand, type OfficeObjectStore } from './office-objects.js'
type Auth={member:{memberId:string;role:string};deviceId:string}
type Deps={store:OfficeObjectStore;authenticate(req:IncomingMessage):Auth|null;readBody(req:IncomingMessage,max:number,options:{reserveBytes:number;memberId:string}):Promise<unknown>;releaseBody(body:unknown):void;json(res:ServerResponse,status:number,body:unknown):void;drain(req:IncomingMessage):void}
export function createOfficeObjectsHttpHandler(deps:Deps) {
 return async(req:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean>=>{
  if(!['/office-objects','/office-objects/history','/office-objects/receipt'].includes(url.pathname))return false
  res.setHeader('Cache-Control','no-store');let body:unknown
  try {
   const auth=deps.authenticate(req);if(!auth)throw new OfficeObjectError(401,'Active team membership required')
   if(req.method==='GET') {
    const teamId=url.searchParams.get('teamId')??'',offset=Number(url.searchParams.get('offset')??0),limit=Number(url.searchParams.get('limit')??100)
    const data=url.pathname.endsWith('/receipt')?deps.store.receipt(auth.member,teamId,url.searchParams.get('commandId')??''):url.pathname.endsWith('/history')?deps.store.history(auth.member,teamId,url.searchParams.get('kind')??'',url.searchParams.get('id')??'',offset,limit):deps.store.list(auth.member,teamId,offset,limit,url.searchParams.has('revision')?Number(url.searchParams.get('revision')):undefined)
    deps.json(res,200,{ok:true,data})
   }else if(req.method==='POST'&&url.pathname==='/office-objects'&&!url.search){
    body=await deps.readBody(req,128_000,{reserveBytes:128_000,memberId:auth.member.memberId})
    const fresh=deps.authenticate(req);if(!fresh||fresh.member.memberId!==auth.member.memberId||fresh.deviceId!==auth.deviceId)throw new OfficeObjectError(401,'The team session changed')
    deps.json(res,200,{ok:true,data:deps.store.command(body as OfficeObjectCommand,fresh.member)})
   }else throw new OfficeObjectError(405,'Use GET or POST')
  }catch(error){deps.drain(req);deps.json(res,error instanceof OfficeObjectError?error.status:503,{ok:false,error:error instanceof OfficeObjectError?error.message:'Shared Office is unavailable'})}finally{deps.releaseBody(body)}
  return true
 }
}
