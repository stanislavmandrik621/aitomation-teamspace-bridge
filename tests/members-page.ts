import assert from 'node:assert/strict'
import {
  TEAMSPACE_MEMBERS_PAGE_DEFAULT,
  TEAMSPACE_MEMBERS_PAGE_MAX,
  clampMembersPageLimit,
  clampMembersPageOffset,
  pageMembersList,
} from '../src/members-page.js'

assert.equal(TEAMSPACE_MEMBERS_PAGE_DEFAULT, 100)
assert.equal(TEAMSPACE_MEMBERS_PAGE_MAX, 500)
assert.equal(clampMembersPageLimit(undefined), 100)
assert.equal(clampMembersPageLimit(0), 100)
assert.equal(clampMembersPageLimit(50), 50)
assert.equal(clampMembersPageLimit(9999), 500)
assert.equal(clampMembersPageOffset(-3), 0)
assert.equal(clampMembersPageOffset(12), 12)

const all = Array.from({ length: 250 }, (_, i) => ({ id: `m${i}` }))
const p0 = pageMembersList(all, 100, 0)
assert.equal(p0.members.length, 100)
assert.equal(p0.total, 250)
assert.equal(p0.has_more, true)
assert.equal(p0.truncated, true)
assert.equal(p0.members[0]!.id, 'm0')

const p1 = pageMembersList(all, 100, 100)
assert.equal(p1.members.length, 100)
assert.equal(p1.members[0]!.id, 'm100')
assert.equal(p1.has_more, true)

const p2 = pageMembersList(all, 100, 200)
assert.equal(p2.members.length, 50)
assert.equal(p2.has_more, false)
assert.equal(p2.truncated, false)

const over = pageMembersList(all, 100, 999)
assert.equal(over.members.length, 0)
assert.equal(over.offset, 250)
assert.equal(over.has_more, false)

console.log('members-page: ok')
