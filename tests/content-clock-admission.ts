import assert from 'node:assert/strict'
import {contentClockAdmissionError, MAX_CONTENT_CLOCK_AHEAD_MS} from '../src/content-clock-admission.js'
import type {ModulesSyncOp} from '../src/index.js'
const now=Date.UTC(2026,8,10,3,0,0)
const op=(wall:number,patch:Record<string,unknown>={}):ModulesSyncOp=>({opId:'clock',kind:'record.update',targetId:'record',targetKind:'record',hlc:`${wall}:0:device`,protocolVersion:2,hopCount:0,patch})
for(const tz of ['Asia/Makassar','America/New_York','Pacific/Honolulu','UTC','Europe/London']) {
  process.env.TZ=tz
  assert.equal(new Date(now).getTime(),now)
  assert.equal(contentClockAdmissionError(op(now),now),null)
}
assert.equal(contentClockAdmissionError(op(now+MAX_CONTENT_CLOCK_AHEAD_MS),now),null)
assert.match(contentClockAdmissionError(op(now+MAX_CONTENT_CLOCK_AHEAD_MS+1),now)!,/date and time/)
for(const field of ['cellHlcs','baseCellHlcs']) assert.ok(contentClockAdmissionError(op(now,{[field]:{title:`${now+86400000}:0:future`}}),now),field+' cannot bypass admission')
assert.ok(contentClockAdmissionError(op(now,{parentHlc:`${now+86400000}:0:future`}),now))
assert.equal(contentClockAdmissionError(op(now-30*86400000),now),null,'old durable edits are not refused merely for age')
console.log('Clock admission: five time zones, boundary, future op/cell/base/parent clocks and old offline stamps passed')
