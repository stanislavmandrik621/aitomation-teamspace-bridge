/** Actual filesystem failures must roll back room ACL and invite mutations. */
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,rmSync,renameSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ChatRoomsStore,type ChatRoomRow} from '../src/chat-rooms-store'
const root=mkdtempSync(join(tmpdir(),'rooms-persist-'))
let cases=0
const durableView=(store:ChatRoomsStore)=>store.listAllOpenRooms().map(row=>({...row,closedAt:row.closedAt??null,inviteHash:row.inviteHash??null,inviteExpiresAt:row.inviteExpiresAt??null,passwordHash:row.passwordHash??null}))
function run(name:string,setup:(store:ChatRoomsStore,row:ChatRoomRow)=>((store:ChatRoomsStore)=>unknown)){
 const dir=join(root,name);mkdirSync(dir)
 const store=new ChatRoomsStore(dir,null)
 const created=store.createGroup({kind:'private',title:'Private',createdBy:'owner',memberIds:['member','other'],password:'original-password'})
 assert.ok(!('error' in created));const row=created as ChatRoomRow
 const mutate=setup(store,row)
 const path=join(dir,'chat','rooms.json'),before=readFileSync(path,'utf8')
 const old=structuredClone(store.get(row.id)),retained=store.get(row.id)!
 const blocker=`${path}.${process.pid}.tmp`;mkdirSync(blocker)
 const result=mutate(store) as any
 assert.ok(result && 'error' in result,`${name}: must refuse failure`)
 assert.equal(readFileSync(path,'utf8'),before,`${name}: durable registry unchanged`)
 assert.deepEqual(store.get(row.id),old,`${name}: live ACL restored`)
 assert.deepEqual(retained,old,`${name}: previously retained row restored`)
 assert.deepEqual(durableView(store),durableView(new ChatRoomsStore(dir,null)),`${name}: restart agrees with running state`)
 rmSync(blocker,{recursive:true})
 assert.ok(!('error' in (mutate(store) as object)),`${name}: retry after disk recovery succeeds`)
 assert.deepEqual(durableView(store),durableView(new ChatRoomsStore(dir,null)),`${name}: successful retry persisted`)
 cases++
}
try{
 run('create',(s,r)=>store=>store.createGroup({kind:'group',title:'New',createdBy:'owner',memberIds:[]}))
 run('dm',(s,r)=>store=>store.getOrCreateDm('one','two'))
 run('admit',(s,r)=>store=>store.admitMember(r.id,'joining'))
 run('add',(s,r)=>store=>store.addMembers(r.id,['joining'],'owner'))
 run('remove',(s,r)=>store=>store.removeMembers(r.id,['member'],'owner'))
 run('promote',(s,r)=>store=>store.promoteOwner(r.id,'member'))
 run('demote',(s,r)=>{s.promoteOwner(r.id,'member');return store=>store.demoteOwner(r.id,'member')})
 run('ban',(s,r)=>store=>store.banMember(r.id,'member','owner'))
 run('unban',(s,r)=>{s.banMember(r.id,'member','owner');return store=>store.unbanMember(r.id,'member')})
 run('leave',(s,r)=>store=>store.leave(r.id,'member'))
 run('close',(s,r)=>store=>store.closeRoom(r.id))
 run('title',(s,r)=>store=>store.setTitle(r.id,'Changed'))
 run('description',(s,r)=>store=>store.setDescription(r.id,'Changed'))
 run('icon',(s,r)=>store=>store.setIcon(r.id,'preset','blue'))
 run('permission',(s,r)=>store=>store.setPermissions(r.id,{addMembers:'owner_admin'}))
 run('password',(s,r)=>store=>store.setPassword(r.id,'new-password'))
 run('invite',(s,r)=>store=>store.mintInviteToken(r.id))
 run('redeem',(s,r)=>{const invite=s.mintInviteToken(r.id);assert.ok(!('error' in invite));return store=>store.redeemInvite(invite.token,'joining')})
 run('emoji',(s,r)=>store=>store.setAllowedReactionEmojis(r.id,['👍']))
 run('trim',(s,r)=>store=>store.trimMembersToCap(r.id,2))
 // Also exercise rename failure after a complete temp file was written.
 const renameDir=join(root,'rename-failure');mkdirSync(renameDir)
 const renameStore=new ChatRoomsStore(renameDir,null)
 const renameRoom=renameStore.createGroup({kind:'group',title:'Original',createdBy:'owner',memberIds:['member']})
 assert.ok(!('error' in renameRoom))
 const registry=join(renameDir,'chat','rooms.json'),parked=registry+'.parked'
 const beforeRename=readFileSync(registry,'utf8'),held=renameStore.get(renameRoom.id)!
 renameSync(registry,parked);mkdirSync(registry)
 assert.ok('error' in renameStore.setTitle(renameRoom.id,'Undurable'))
 assert.equal(held.title,'Original');assert.equal(renameStore.get(renameRoom.id)!.title,'Original')
 assert.equal(readFileSync(parked,'utf8'),beforeRename)
 rmSync(registry,{recursive:true});renameSync(parked,registry)
 assert.ok(!('error' in renameStore.setTitle(renameRoom.id,'Durable')))
 assert.equal(new ChatRoomsStore(renameDir,null).get(renameRoom.id)!.title,'Durable')
 console.log(`chat room persistence: ${cases} real disk failures refuse acknowledgment, restore memory/retained ACL rows, preserve disk, and retry/restart consistently; nested ban/redeem atomic`)
}finally{rmSync(root,{recursive:true,force:true})}
