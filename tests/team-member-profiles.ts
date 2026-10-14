import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomBytes,createHash} from 'node:crypto'
import {TeamMemberProfileStore,MemberProfileError,type ProfileFields} from '../src/team-member-profile-store.js'
const dir=mkdtempSync(join(tmpdir(),'team-member-profile-')),key={key:randomBytes(32)}
const members=new Map([['admin',{memberId:'admin',displayName:'Admin',role:'admin'}],['bob',{memberId:'bob',displayName:'Bob',role:'member'}],['charlie',{memberId:'charlie',displayName:'Charlie',role:'viewer'}]])
const fields:ProfileFields={firstName:'Bohdan',lastName:'Petrenko',middleName:'',preferredName:'Bob',title:'Engineer',responsibilities:'Existing module records',skills:['Testing'],languages:['English'],availability:'Weekdays',timezone:'Asia/Makassar',workHours:'09:00–17:00'}
const request=(memberId:string,version:number,commandId:string)=>({teamId:'team-a',memberId,expectedVersion:version,commandId,...fields})
const refused=(fn:()=>unknown,status:number)=>assert.throws(fn,(error:unknown)=>error instanceof MemberProfileError&&error.status===status)
try{
 let store=new TeamMemberProfileStore(dir,key,id=>members.get(id)??null)
 assert.equal(store.read('team-a','bob','charlie').profile.version,0)
 const first=store.save(request('bob',0,'command-1'),'bob');assert.equal(first.profile.firstName,'Bohdan');assert.equal(first.profile.version,1);assert.equal(first.displayName,'Bob');assert.equal(first.role,'member');assert.equal(first.profile.updatedBy,'bob')
 assert.equal(store.save(request('bob',0,'command-1'),'bob').profile.version,1,'lost reply retry is idempotent')
 refused(()=>store.save({...request('bob',0,'command-1'),title:'Changed request'},'bob'),409)
 refused(()=>store.save(request('bob',1,'member-cant-edit-other'),'charlie'),403)
 assert.equal(store.save(request('charlie',0,'viewer-self'),'charlie').profile.version,1,'Viewer self-profile editing is allowed without granting module write')
 assert.equal(store.save(request('bob',1,'admin-edit'),'admin').profile.version,2)
 const contest=Array.from({length:100},(_,i)=>{try{store.save({...request('bob',2,'concurrent-'+i),title:'Editor '+i},'bob');return true}catch(error){assert.equal((error as MemberProfileError).status,409);return false}})
 assert.equal(contest.filter(Boolean).length,1,'100 concurrent snapshots yield one CAS winner')
 const page=store.history('team-a','bob','charlie',1);assert.equal(page.entries[0].version,3);assert.ok(page.nextCursor);assert.equal(store.history('team-a','bob','charlie',1,page.nextCursor).entries[0].version,2)
 store.save(request('bob',3,'next-revision'),'bob');refused(()=>store.history('team-a','bob','charlie',1,page.nextCursor),409)
 refused(()=>store.save({...request('bob',4,'forged-author'),updatedBy:'admin',updatedAt:99999999999999},'bob'),400)
 members.delete('charlie');refused(()=>store.read('team-a','bob','charlie'),401);refused(()=>store.read('team-a','charlie','admin'),404)
 store=new TeamMemberProfileStore(dir,key,id=>members.get(id)??null);assert.equal(store.read('team-a','bob','admin').profile.version,4);assert.equal(store.read('team-b','bob','admin').profile.version,0,'same member ID is isolated by team scope')
 const path=join(dir,'team-member-profiles',createHash('sha256').update('team-a\0bob').digest('hex')+'.json'),bytes=readFileSync(path);assert.equal(bytes.includes(Buffer.from('Existing module records')),false,'profile at-rest encryption')
 writeFileSync(path,'corrupt');const unavailable=new TeamMemberProfileStore(dir,key,id=>members.get(id)??null)
 refused(()=>unavailable.read('team-a','bob','admin'),503)
 refused(()=>unavailable.save(request('bob',0,'must-not-replace-corrupt-history'),'bob'),503)
 assert.equal(readFileSync(path,'utf8'),'corrupt');writeFileSync(path,bytes)
 console.log('team-member-profiles: names, self/Admin ACL, Viewer self-edit, 100-way CAS, idempotent retries, paginated/stale history, server attribution, revocation, team isolation, restart, encryption and corrupt-history refusal passed')
}finally{rmSync(dir,{recursive:true,force:true})}
