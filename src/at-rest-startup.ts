import {existsSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {decryptJsonFile,type AtRestKey} from './at-rest.js'
import {independentCheckpointPaths} from './independent-authority.js'

/** Check encrypted identity/chat metadata before stores can quarantine or
 * rewrite it. A key configuration error is not evidence of corrupt data.
 * Plaintext legacy files keep their existing store validation behavior.
 */
export function verifyAtRestStartupKey(directory:string,key:AtRestKey|null):void {
 const required=new Set<string>(independentCheckpointPaths(directory))
 for(const relative of new Set([...required].filter(path=>path.endsWith('.json')).concat(['team.json','members.json','acks.json','invites.json','revoked-sessions.json','chat/rooms.json','chat/_meta.json','chat/unread.json','chat/blob-registry.json']))) {
  const path=join(directory,relative)
  if(!existsSync(path))continue
  const raw=readFileSync(path,'utf8')
  let value:unknown
  try{value=JSON.parse(raw)}catch{if(required.has(relative))throw Error(`Retained authorization ${relative} is unreadable; repair its current copy before starting. Existing data has not been changed.`);continue}
  if(required.has(relative)&&(!value||typeof value!=='object'))throw Error(`Retained authorization ${relative} is invalid; existing data has not been changed.`)
  if(!value||typeof value!=='object'||Array.isArray(value)||(value as any).v!==1||typeof(value as any).ciphertext!=='string')continue
  try{decryptJsonFile(key,raw,null)}catch{
   throw Error(`Cannot unlock ${relative}. Set the original TEAMSPACE_AT_REST_KEY before starting this server; existing data has not been changed.`)
  }
 }
}
