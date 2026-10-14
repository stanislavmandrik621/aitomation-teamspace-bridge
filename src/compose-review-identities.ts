import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import { isPublicSharePasswordHash } from './public-share-store.js'

export type ReviewAuthor = { id: string; name: string; kind: 'guest' | 'named' | 'member'; color: string }
export type ReviewGrant = { id: string; name: string; passwordHash: string; revoked: boolean }
export type ReviewAccess = { mode: 'shared' | 'named'; revision: number; grants: ReviewGrant[] }
export type ReviewPublication = { tokenHash: string; passwordHash: string | null; reviewAccess?: ReviewAccess }
const colors = ['#2563eb', '#7c3aed', '#c026d3', '#be123c', '#c2410c', '#047857', '#0e7490', '#4d7c0f']
export function reviewAuthor(id: string, name: string, kind: ReviewAuthor['kind']): ReviewAuthor {
  return { id, name, kind, color: colors[createHash('sha256').update(id).digest()[0]! % colors.length]! }
}
export function reviewAccess(value: unknown): ReviewAccess {
  if (value === undefined) return { mode: 'shared', revision: 0, grants: [] }
  const a = value as ReviewAccess
  if (!a || !['shared', 'named'].includes(a.mode) || !Number.isSafeInteger(a.revision) || a.revision < 0 || !Array.isArray(a.grants) || a.grants.length > 200) throw new Error('Review access is unavailable.')
  const ids = new Set<string>(), names = new Set<string>()
  for (const g of a.grants) {
    if (!g || typeof g.id !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(g.id) || typeof g.name !== 'string' || !g.name.trim() || g.name.length > 100 || !isPublicSharePasswordHash(g.passwordHash) || typeof g.revoked !== 'boolean' || ids.has(g.id) || (!g.revoked && names.has(g.name.toLocaleLowerCase('en-US')))) throw new Error('Review access is unavailable.')
    ids.add(g.id); if (!g.revoked) names.add(g.name.toLocaleLowerCase('en-US'))
  }
  return a
}
export function reviewAccessMeta(value: unknown) { const a = reviewAccess(value); return { mode: a.mode, revision: a.revision, grants: a.grants.map(({ id, name, revoked }) => ({ id, name, revoked })) } }
const adjectives = ['Curious', 'Bright', 'Calm', 'Clever', 'Kind', 'Sunny', 'Swift', 'Gentle']
const animals = ['Otter', 'Panda', 'Fox', 'Koala', 'Owl', 'Dolphin', 'Raccoon', 'Penguin']
export function randomReviewName() { return `${adjectives[randomInt(adjectives.length)]} ${animals[randomInt(animals.length)]} ${randomInt(1000, 10000)}` }
type Session = { tokenHash: string; publication: string; author: ReviewAuthor; proof: string; expiresAt: number; seenAt: number; page: number; active: boolean }
/** Ephemeral presence never writes the roster or authorizes source-board access. */
export class ComposeReviewSessions {
  private sessions = new Map<string, Session>()
  constructor(private readonly now = Date.now, private readonly memberCanRead: (row: ReviewPublication, memberId: string) => boolean = () => false) {}
  private fingerprint(row: ReviewPublication, author: ReviewAuthor): string | null {
    if (author.kind === 'member') return this.memberCanRead(row, author.id) ? 'member:' + author.id : null
    const access = reviewAccess(row.reviewAccess)
    const password = access.mode === 'shared' && author.kind === 'guest' ? row.passwordHash
      : access.mode === 'named' && author.kind === 'named' ? access.grants.find(g => g.id === author.id && !g.revoked)?.passwordHash : null
    return password ? createHash('sha256').update(access.mode + ':' + password).digest('hex') : null
  }
  private prune() { const now = this.now(); for (const [id, s] of this.sessions) if (s.expiresAt <= now) this.sessions.delete(id) }
  issue(row: ReviewPublication, name: string, grant?: ReviewGrant, member?: ReviewAuthor) {
    this.prune(); if (this.sessions.size >= 5000) throw new Error('Review sessions are busy. Try again later.')
    const author = member || reviewAuthor(grant?.id || randomUUID(), grant?.name || name.trim().slice(0, 100) || randomReviewName(), grant ? 'named' : 'guest')
    if (!grant && !member && [...this.sessions.values()].some(s => s.publication === row.tokenHash && s.expiresAt > this.now() && s.author.name.toLocaleLowerCase('en-US') === author.name.toLocaleLowerCase('en-US'))) author.name = author.name.slice(0, 90) + ' ' + randomInt(1000, 10000)
    const proof = this.fingerprint(row, author); if (!proof) throw new Error('Review access changed. Sign in again.')
    const token = 'cgr_' + randomBytes(32).toString('base64url'), tokenHash = createHash('sha256').update(token).digest('hex'), now = this.now()
    this.sessions.set(tokenHash, { tokenHash, publication: row.tokenHash, author, proof, expiresAt: now + 8 * 3600000, seenAt: now, page: 1, active: true })
    return { viewerToken: token, viewer: author }
  }
  identify(row: ReviewPublication, token: unknown): ReviewAuthor | null {
    const s = this.lookup(token)
    if (!s || s.publication !== row.tokenHash || s.proof !== this.fingerprint(row, s.author)) return null
    return s.author
  }
  private lookup(token: unknown) {
    if (typeof token !== 'string' || !/^cgr_[A-Za-z0-9_-]{43}$/.test(token)) return null
    const s = this.sessions.get(createHash('sha256').update(token).digest('hex'))
    if (!s || s.expiresAt <= this.now()) return null
    return s
  }
  /** A verified bearer can have its own HTTP quota without consuming a team's NAT budget. */
  budgetKey(token: string): string | null { return this.lookup(token)?.tokenHash ?? null }
  pulse(row: ReviewPublication, token: string, page: unknown, active = true) {
    const author = this.identify(row, token), s = this.lookup(token)
    if (!author || !s) throw new Error('Review session ended. Sign in again.')
    s.active = active; s.seenAt = this.now(); if (Number.isSafeInteger(page) && Number(page) > 0) s.page = Number(page)
    this.prune()
    const people = new Map<string, ReviewAuthor & { page: number }>()
    for (const session of this.sessions.values()) if (session.publication === row.tokenHash && session.active && session.seenAt > this.now() - 45_000 && session.proof === this.fingerprint(row, session.author)) people.set(session.author.id, { ...session.author, page: session.page })
    return [...people.values()]
  }
}
