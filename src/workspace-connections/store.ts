import type {QuotaControlInput,QuotaControlReply} from './quota-holds.js'
import type {QuotaAllocation,QuotaAllocationReply} from './quota-allocation.js'
/** Durable encrypted self-host storage. Provider contract stays identical to cloud. */
import { MailStore } from '../mail-store.js'
import { join } from 'node:path'
import { chmodSync, lstatSync, mkdirSync } from 'node:fs'
import type { AtRestKey } from '../at-rest.js'
import { fail } from './catalog.js'

export interface Owner { userId: string; projectId: string }
export interface Stored<T> { owner: Owner; value: T; expiresAt: number | null }
export interface StoreSession {
  get<T>(kind: string, id: string, owner: Owner): Promise<T | null>
  put<T>(kind: string, id: string, owner: Owner, value: T, expiresAt?: number): Promise<void>
  remove(kind: string, id: string, owner: Owner): Promise<void>
  list<T>(kind: string, owner: Owner): Promise<T[]>
}
export interface ConnectionStore extends StoreSession {
  /** No implementation here: self-hosted quota coordination stays unconfigured. */
  reserveQuotaAtomic?(input:QuotaAllocation,authorize:()=>Promise<void>,signal?:AbortSignal):Promise<QuotaAllocationReply>
  controlQuotaAtomic?(input:QuotaControlInput,authorize:()=>Promise<void>,signal?:AbortSignal):Promise<QuotaControlReply>
  take<T>(kind: string, id: string): Promise<Stored<T> | null>
  locked<T>(owner: Owner, key: string | readonly string[], work: (store: StoreSession) => Promise<T>): Promise<T>
}
const ownerKey=(owner:Owner)=>JSON.stringify([owner.userId,owner.projectId])
function collection(kind:string){if(!['pending','connection','connection-revocation','approval','receipt','advanced-credential-profile','advanced-credential-token','claims-flow'].includes(kind))throw Error('Unknown connection record');return `workspace_${kind}`}
export class SelfhostConnectionStore implements ConnectionStore {
  private readonly db:MailStore
  private readonly locks=new Set<string>()
  // Reuse the encrypted worker implementation, not its database file. Existing
  // queued mail owns its SQLite worker; two live workers must not share that WAL.
  constructor(dataDir:string,key:AtRestKey){
    const directory=join(dataDir,'workspace-connections')
    mkdirSync(directory,{recursive:true,mode:0o700})
    const stat=lstatSync(directory)
    if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('Private-server connection storage is unavailable')
    chmodSync(directory,0o700)
    this.db=new MailStore({dataDir:directory,key})
  }
  ready(){return this.db.ready()}
  close(){return this.db.close()}
  async get<T>(kind:string,id:string,owner:Owner):Promise<T|null>{
    const row=await this.db.get<Stored<T>>(collection(kind),id)
    if(!row||ownerKey(row.value.owner)!==ownerKey(owner)||row.value.expiresAt!==null&&row.value.expiresAt<=Date.now())return null
    return row.value.value
  }
  async put<T>(kind:string,id:string,owner:Owner,value:T,expiresAt?:number){
    const name=collection(kind),old=await this.db.get<Stored<T>>(name,id)
    if(old&&ownerKey(old.value.owner)!==ownerKey(owner))fail('ownership','This connection belongs to another member, device or project.',403)
    // The target may itself have expired. Preserve its revision until the CAS
    // replacement below instead of deleting it in our own maintenance sweep.
    const expired=(await this.db.list(name,{dueBefore:Date.now(),limit:100})).filter(row=>row.id!==id)
    if(expired.length)await this.db.batch(expired.map(row=>({collection:name,id:row.id,delete:true})),{checks:expired.map(row=>({collection:name,id:row.id,revision:row.revision}))})
    const stored:Stored<T>={owner,value,expiresAt:expiresAt??null}
    const saved=await this.db.batch([{collection:name,id,owner:ownerKey(owner),value:stored,...(expiresAt?{due:expiresAt}:{})}],{
      checks:[{collection:name,id,revision:old?.revision??null}],limits:[{collection:name,max:20000},{collection:name,owner:ownerKey(owner),max:1000}],
    })
    if(!saved)fail('busy','The connection changed. Refresh and retry.',409)
  }
  async remove(kind:string,id:string,owner:Owner){
    const name=collection(kind),row=await this.db.get<Stored<unknown>>(name,id)
    if(!row||ownerKey(row.value.owner)!==ownerKey(owner))return
    if(!await this.db.batch([{collection:name,id,delete:true}],{checks:[{collection:name,id,revision:row.revision}]}))fail('busy','The connection changed. Refresh and retry.',409)
  }
  async take<T>(kind:string,id:string):Promise<Stored<T>|null>{
    const name=collection(kind),row=await this.db.get<Stored<T>>(name,id)
    if(!row)return null
    // CAS deletion is committed before handing the single-use state/receipt out.
    if(!await this.db.batch([{collection:name,id,delete:true}],{checks:[{collection:name,id,revision:row.revision}]}))return null
    return row.value.expiresAt!==null&&row.value.expiresAt<=Date.now()?null:row.value
  }
  async list<T>(kind:string,owner:Owner):Promise<T[]>{
    const values:T[]=[],name=collection(kind),key=ownerKey(owner)
    let after:string|undefined
    // The service's 101-row sentinel counts live records. Expired rows can
    // outlive their deadlines until a write sweeps them; page past those rows
    // rather than hiding current revocation fences behind an expired prefix.
    // Each owner has at most 1,000 stored rows, so ten pages suffice. Unexpected
    // concurrent growth fails closed instead of returning an incomplete list.
    for(let page=0;page<10;page++){
      const rows=await this.db.list<Stored<T>>(name,{owner:key,limit:101,...(after?{after}:{})})
      for(const row of rows){
        if(ownerKey(row.value.owner)===key&&(row.value.expiresAt===null||row.value.expiresAt>Date.now()))values.push(row.value.value)
        if(values.length===101)return values
      }
      if(rows.length<101)return values
      after=rows[rows.length-1]!.id
    }
    return fail('busy','Connections changed while loading. Refresh and retry.',409)
  }
  async locked<T>(owner:Owner,id:string|readonly string[],work:(store:StoreSession)=>Promise<T>):Promise<T>{
    const keys=[...new Set(typeof id==='string'?[id]:id)].map(value=>JSON.stringify([ownerKey(owner),value]))
    // Server data-directory lease excludes another process. No network-spanning
    // SQLite transaction: receipt consumption stays committed after failures.
    if(!keys.length)fail('invalid_request','A connection lock is required.')
    if(this.locks.size+keys.length>32||keys.some(key=>this.locks.has(key)))fail('busy','This connection is busy. Try again shortly.',429)
    for(const key of keys)this.locks.add(key)
    try{return await work(this)}finally{for(const key of keys)this.locks.delete(key)}
  }
}
