import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {BridgeStore} from '../src/store.js'
function fixture(){const root=mkdtempSync(join(tmpdir(),'invite-additional-'));let store=new BridgeStore(root,21,null,null);assert.ok(store.helloOrBootstrap({memberId:'admin',deviceId:'admin-device',memberEmail:'admin@test.invalid'}).ok);return{root,get store(){return store},restart(){store=new BridgeStore(root,21,null,null)},invite(role:'member'|'viewer'='member'){const r=store.createInvite('admin','same@test.invalid',role);assert.ok(r.ok);return r.invite.token},dispose(){rmSync(root,{recursive:true,force:true})}}}
test('same-role projects retain independent bearers, retry proofs and per-device revocation after restart',async()=>{
 const f=fixture();try{
  const nonce='a'.repeat(64),token=f.invite();const a=await f.store.redeemInvite({token,deviceId:'project-a',redemptionNonce:nonce});assert.ok(a.ok)
  const b=await f.store.redeemInvite({token:f.invite(),deviceId:'project-b'});assert.ok(b.ok);assert.equal(a.member.memberId,b.member.memberId)
  f.restart();for(const r of [a,b])assert.ok(f.store.findBySession(r.sessionToken))
  const retry=await f.store.redeemInvite({token,deviceId:'project-a',redemptionNonce:nonce});assert.ok(retry.ok&&retry.replayed);assert.equal(retry.sessionToken,a.sessionToken)
  const replacement=await f.store.redeemInvite({token:f.invite(),deviceId:'project-a'});assert.ok(replacement.ok)
  assert.equal(f.store.findBySession(a.sessionToken),null);assert.ok(f.store.findBySession(b.sessionToken));assert.ok(f.store.findBySession(replacement.sessionToken))
  f.restart();assert.equal(f.store.findBySession(a.sessionToken),null);assert.ok(f.store.findBySession(b.sessionToken))
  const changed=await f.store.redeemInvite({token:f.invite('viewer'),deviceId:'viewer-project'});assert.ok(changed.ok)
  for(const r of [b,replacement])assert.equal(f.store.findBySession(r.sessionToken),null)
  f.restart();assert.equal(f.store.findBySession(changed.sessionToken)?.member.role,'viewer')
 }finally{f.dispose()}
})
test('device limit refuses before consuming invite and preserves every existing session',async()=>{
 const f=fixture();try{
  const sessions=[];for(let i=0;i<64;i++){const r=await f.store.redeemInvite({token:f.invite(),deviceId:`project-${i}`});assert.ok(r.ok);sessions.push(r.sessionToken)}
  const token=f.invite();const refused=await f.store.redeemInvite({token,deviceId:'overflow'});assert.ok(!refused.ok);assert.match(refused.reason,/too many connected devices/)
  for(const session of sessions)assert.ok(f.store.findBySession(session))
  const replacement=await f.store.redeemInvite({token,deviceId:'project-0'});assert.ok(replacement.ok,'refused invite remains usable for replacing an existing device')
  assert.equal(f.store.findBySession(sessions[0]!),null);for(const session of sessions.slice(1))assert.ok(f.store.findBySession(session))
 }finally{f.dispose()}
})
