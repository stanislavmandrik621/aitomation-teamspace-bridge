/** Shared desktop/provider contracts. Pure text rendering: never evaluates code or sends mail. */
import { queryMailWarmupTemplates } from './mail-warmup-templates.js'

export class WarmupPreparationError extends Error {}
export const WARMUP_STUDIO_VERSION = 1
export const WARMUP_LIBRARY_BYTES = 128 * 1024
export interface WarmupUserTemplate {
  id: string; revision: number; name: string; subject: string; message: string; replies: string[]; weight: number; enabled: boolean
}
export interface WarmupStudioConfig {
  name: string; durationDays: number; includeBuiltIn: boolean; templates: WarmupUserTemplate[]
  variables: Record<string, string[]>; rotation: 'sequential' | 'shuffle' | 'weighted'; exhaustion: 'pause' | 'repeat'
  timeZone: string; weekdays: number[]; startMinute: number; endMinute: number; intervalJitterMinutes: number
  pausedProfileIds: string[]; pairing: 'balanced' | 'cross-domain'
}
export function defaultWarmupStudio(): WarmupStudioConfig {
  return { name: 'Mail warm-up', durationDays: 30, includeBuiltIn: true, templates: [], variables: {}, rotation: 'shuffle', exhaustion: 'pause',
    timeZone: 'UTC', weekdays: [0, 1, 2, 3, 4, 5, 6], startMinute: 0, endMinute: 1440, intervalJitterMinutes: 10,
    pausedProfileIds: [], pairing: 'balanced' }
}
const reserved = new Set(['__proto__', 'prototype', 'constructor'])
export function warmupObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
    || Object.keys(raw).some(key => reserved.has(key))) throw new Error('Invalid warm-up data')
  return raw as Record<string, unknown>
}
function bounded(raw: unknown, name: string, max: number, multiline = false): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > max || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(raw)) throw new Error(`${name} is missing or too long`)
  return raw.trim()
}
function integer(raw: unknown, name: string, min: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < min || raw > max) throw new Error(`${name} must be from ${min} to ${max}`)
  return raw
}
const builtinVariables = ['sender_name', 'sender_email', 'sender_domain', 'recipient_name', 'recipient_email', 'recipient_domain', 'date', 'run_name']
export function parseWarmupStudio(raw: unknown): WarmupStudioConfig {
  const v = warmupObject(raw)
  if (typeof v.includeBuiltIn !== 'boolean') throw new Error('Choose whether to include built-in templates')
  if (!['sequential', 'shuffle', 'weighted'].includes(String(v.rotation)) || !['pause', 'repeat'].includes(String(v.exhaustion))
    || !['balanced', 'cross-domain'].includes(String(v.pairing))) throw new Error('Choose a valid rotation and pairing policy')
  const timeZone = bounded(v.timeZone, 'Timezone', 100)
  try { new Intl.DateTimeFormat('en', { timeZone }).format(0) } catch { throw new Error('Choose a valid timezone') }
  if (!Array.isArray(v.weekdays) || !v.weekdays.length || v.weekdays.length > 7 || new Set(v.weekdays).size !== v.weekdays.length) throw new Error('Choose working days')
  const weekdays = v.weekdays.map(day => integer(day, 'Weekday', 0, 6))
  if (!Array.isArray(v.pausedProfileIds) || v.pausedProfileIds.length > 1000 || new Set(v.pausedProfileIds).size !== v.pausedProfileIds.length
    || v.pausedProfileIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id))) throw new Error('Invalid paused mailbox selection')
  const variables: Record<string, string[]> = {}
  const values = warmupObject(v.variables)
  if (Object.keys(values).length > 50) throw new Error('Use at most 50 variable names per library')
  for (const [key, value] of Object.entries(values)) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(key) || builtinVariables.includes(key)) throw new Error(`Invalid or reserved variable: ${key}`)
    if (!Array.isArray(value) || !value.length || value.length > 100) throw new Error(`Provide 1 to 100 values for ${key}`)
    variables[key] = value.map(item => bounded(item, key, 1000, true))
  }
  if (!Array.isArray(v.templates) || v.templates.length > 1000) throw new Error('A library supports at most 1,000 custom templates')
  const ids = new Set<string>()
  const templates = v.templates.map(rawTemplate => {
    const t = warmupObject(rawTemplate), id = bounded(t.id, 'Template ID', 64)
    if (!/^[A-Za-z0-9_-]+$/.test(id) || id.startsWith('mail-test-') || ids.has(id)) throw new Error('Use distinct custom template IDs')
    ids.add(id)
    if (typeof t.enabled !== 'boolean' || !Array.isArray(t.replies) || t.replies.length > 5) throw new Error('A template supports up to five reply steps')
    const template: WarmupUserTemplate = { id, revision: integer(t.revision, 'Template revision', 1, 1_000_000), name: bounded(t.name, 'Template name', 120),
      subject: bounded(t.subject, 'Subject', 200), message: bounded(t.message, 'Message', 12000, true),
      replies: t.replies.map(reply => bounded(reply, 'Reply', 12000, true)), weight: integer(t.weight, 'Weight', 1, 100), enabled: t.enabled }
    for (const text of [template.subject, template.message, ...template.replies]) validateVariables(text, variables)
    return template
  })
  const result: WarmupStudioConfig = { name: bounded(v.name, 'Run name', 120), durationDays: integer(v.durationDays, 'Run duration in days', 1, 3660),
    includeBuiltIn: v.includeBuiltIn, templates, variables, rotation: v.rotation as WarmupStudioConfig['rotation'], exhaustion: v.exhaustion as WarmupStudioConfig['exhaustion'],
    timeZone, weekdays, startMinute: integer(v.startMinute, 'Start minute', 0, 1439), endMinute: integer(v.endMinute, 'End minute', 0, 1440),
    intervalJitterMinutes: integer(v.intervalJitterMinutes, 'Interval variation in minutes', 0, 1440), pausedProfileIds: [...v.pausedProfileIds] as string[], pairing: v.pairing as WarmupStudioConfig['pairing'] }
  if (result.startMinute === result.endMinute) throw new Error('Working hours must have a nonempty range')
  if (new TextEncoder().encode(JSON.stringify(result)).length > WARMUP_LIBRARY_BYTES) throw new Error('This library exceeds the 128 KiB storage limit. Shorten or split the templates.')
  return result
}
export function validateVariables(text: string, custom: Record<string, string[]>): void {
  const remaining = text.replace(/\{\{([a-z][a-z0-9_]{0,39})\}\}/g, (_, key: string) => {
    if (!builtinVariables.includes(key) && !Object.hasOwn(custom, key)) throw new Error(`Provide a value for {{${key}}}`)
    return ''
  })
  if (remaining.includes('{{') || remaining.includes('}}')) throw new Error('Use variables in the form {{variable_name}}')
}
export function warmupHash(value: string): number {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619) >>> 0
  return hash
}
export interface WarmupContent { templateId: string; revision: number; subject: string; messages: string[] }
export interface WarmupAddress { id: string; email: string; name?: string }
export function warmupTemplatePool(studio: WarmupStudioConfig): WarmupUserTemplate[] {
  const builtins: WarmupUserTemplate[] = []
  if (studio.includeBuiltIn) for (let offset = 0; offset < 1000; offset += 100) {
    for (const t of queryMailWarmupTemplates({ offset, limit: 100 }).items) builtins.push({ id: t.id, revision: 1, name: t.subject, subject: t.subject, message: t.message, replies: [t.reply], weight: 1, enabled: true })
  }
  return [...builtins, ...studio.templates.filter(t => t.enabled)]
}
export function renderWarmupContent(template: WarmupUserTemplate, studio: WarmupStudioConfig, from: WarmupAddress, to: WarmupAddress, seed: string, now: number): WarmupContent {
  const builtin: Record<string, string> = { sender_name: from.name || from.email.split('@')[0], sender_email: from.email, sender_domain: from.email.split('@')[1] || '',
    recipient_name: to.name || to.email.split('@')[0], recipient_email: to.email, recipient_domain: to.email.split('@')[1] || '',
    date: new Intl.DateTimeFormat('en-CA', { timeZone: studio.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now), run_name: studio.name }
  const render = (text: string, subject = false, reverse = false) => {
    validateVariables(text, studio.variables)
    const result = text.replace(/\{\{([a-z][a-z0-9_]{0,39})\}\}/g, (_, key: string) => {
      if (Object.hasOwn(builtin, key)) return builtin[reverse ? key.startsWith('sender_') ? key.replace('sender_', 'recipient_') : key.startsWith('recipient_') ? key.replace('recipient_', 'sender_') : key : key]
      const values = studio.variables[key]
      return values[warmupHash(`${seed}:${key}`) % values.length]
    })
    if (new TextEncoder().encode(result).length > 32 * 1024) throw new Error('Rendered message exceeds 32 KiB. Shorten the template or variable values.')
    return bounded(result, subject ? 'Rendered subject' : 'Rendered message', subject ? 200 : 16000, !subject)
  }
  const content = { templateId: template.id, revision: template.revision, subject: render(template.subject, true), messages: [render(template.message), ...template.replies.map((reply, index) => render(reply, false, index % 2 === 0))] }
  if (new TextEncoder().encode(JSON.stringify(content)).length > 96 * 1024) throw new Error('Rendered conversation exceeds 96 KiB. Shorten its messages or variable values.')
  return content
}
/** Stable permutation per run/pair/cycle. Retries never redraw an already saved message. */
export function orderedWarmupTemplates(studio: WarmupStudioConfig, seed: string): WarmupUserTemplate[] {
  const templates = warmupTemplatePool(studio)
  if (studio.rotation === 'sequential') return templates
  const rank = (t: WarmupUserTemplate) => -Math.log((warmupHash(`${seed}:${t.id}`) + 1) / 4294967297) / (studio.rotation === 'weighted' ? t.weight : 1)
  return templates.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
}
export function warmupWorkingNow(studio: WarmupStudioConfig, now: number): boolean {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: studio.timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  const get = (type: string) => parts.find(p => p.type === type)?.value || ''
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')), minute = Number(get('hour')) * 60 + Number(get('minute'))
  if (studio.startMinute < studio.endMinute) return studio.weekdays.includes(day) && minute >= studio.startMinute && minute < studio.endMinute
  return (minute >= studio.startMinute && studio.weekdays.includes(day)) || (minute < studio.endMinute && studio.weekdays.includes((day + 6) % 7))
}
export function warmupPairAllowed(studio: WarmupStudioConfig | undefined, from: WarmupAddress, to: WarmupAddress): boolean {
  return from.id !== to.id && (!studio || (!studio.pausedProfileIds.includes(from.id) && !studio.pausedProfileIds.includes(to.id)
    && (studio.pairing !== 'cross-domain' || from.email.split('@')[1]?.toLowerCase() !== to.email.split('@')[1]?.toLowerCase())))
}
export function warmupSpacingMinutes(studio: WarmupStudioConfig | undefined, minimum: number, profileId: string, lastSent: number): number {
  return minimum + (studio ? warmupHash(`${profileId}:${lastSent}`) % (studio.intervalJitterMinutes + 1) : 0)
}

export interface WarmupCounters { total: number; attempted: number; accepted: number; received: number; replies: number; failed: number; unknown: number; cancelled: number; queued: number; receiptMilliseconds: number }
export function emptyWarmupCounters(): WarmupCounters { return { total: 0, attempted: 0, accepted: 0, received: 0, replies: 0, failed: 0, unknown: 0, cancelled: 0, queued: 0, receiptMilliseconds: 0 } }
export interface WarmupRun { id: string; name: string; startedAt: number; endedAt: number | null; status: 'running' | 'paused' | 'finished'; reason: string | null; config: unknown; totals: WarmupCounters }
export interface WarmupRunMessage {
  id: string; runId: string; fromProfileId: string; toProfileId: string; from: string; to: string; subject: string; body: string; templateId: string; templateRevision: number
  exchange: number; status: string; dueAt: number; attemptedAt: number | null; sentAt: number | null; receivedAt: number | null; error: string | null
}
export function warmupMessageCounters(job: WarmupRunMessage): WarmupCounters {
  return { total: 1, attempted: Number(job.attemptedAt !== null), accepted: Number(job.sentAt !== null && !['failed', 'unknown', 'dispatching'].includes(job.status)),
    received: Number(job.receivedAt !== null), replies: Number(job.exchange > 1 && job.sentAt !== null && !['failed', 'unknown', 'dispatching'].includes(job.status)),
    failed: Number(job.status === 'failed'), unknown: Number(['unknown', 'unverified'].includes(job.status)), cancelled: Number(job.status === 'cancelled'),
    queued: Number(['queued', 'dispatching'].includes(job.status)), receiptMilliseconds: job.receivedAt !== null && job.sentAt !== null ? Math.max(0, job.receivedAt - job.sentAt) : 0 }
}
export function addWarmupCounters(target: WarmupCounters, value: WarmupCounters, sign = 1): WarmupCounters {
  for (const key of Object.keys(target) as (keyof WarmupCounters)[]) target[key] += sign * value[key]
  return target
}
export type WarmupWorkspaceRequest = { action: 'runs'; after?: string; limit?: number }
  | { action: 'report'; runId: string }
  | { action: 'messages'; runId: string; after?: string; limit?: number }
  | { action: 'finish'; runId: string }
export type WarmupWorkspaceResult = { ok: false; error: string } | { ok: true; runs?: WarmupRun[]; hasMore?: boolean; nextCursor?: string;
  run?: WarmupRun; mailboxes?: { id: string; email?: string; totals: WarmupCounters }[]; days?: { day: string; totals: WarmupCounters }[]; messages?: WarmupRunMessage[] }
export function parseWarmupWorkspaceRequest(raw: unknown): WarmupWorkspaceRequest {
  const v = warmupObject(raw)
  if (!['runs', 'report', 'messages', 'finish'].includes(String(v.action))) throw new Error('Unknown warm-up workspace action')
  if (Object.keys(v).some(key => !['action', 'runId', 'after', 'limit'].includes(key))) throw new Error('Unexpected warm-up workspace fields')
  const runId = v.action === 'runs' ? undefined : bounded(v.runId, 'Run ID', 128)
  if (runId && !/^[A-Za-z0-9_:-]+$/.test(runId)) throw new Error('Invalid run ID')
  if (v.action === 'report' || v.action === 'finish') return { action: v.action, runId: runId! }
  const limit = v.limit === undefined ? 50 : integer(v.limit, 'Page size', 1, 100)
  const after = v.after === undefined ? undefined : bounded(v.after, 'Page cursor', 1024)
  return v.action === 'runs' ? { action: 'runs', limit, ...(after ? { after } : {}) } : { action: 'messages', runId: runId!, limit, ...(after ? { after } : {}) }
}

/** Whitelist public data at the server/native boundary; never return provider proofs or credentials. */
export function parseWarmupWorkspaceResult(raw:unknown):WarmupWorkspaceResult {
  const data=warmupObject(raw)
  if(data.ok!==true) return {ok:false,error:typeof data.error==='string'?data.error.slice(0,500):'Could not read the warm-up workspace'}
  const id=(raw:unknown)=>bounded(raw,'Saved identity',256)
  const timestamp=(raw:unknown)=>integer(raw,'Saved timestamp',0,8_640_000_000_000_000)
  const nullableTime=(raw:unknown)=>raw===null?null:timestamp(raw)
  const counts=(raw:unknown)=>{const v=warmupObject(raw),n=emptyWarmupCounters();for(const key of Object.keys(n) as (keyof WarmupCounters)[])n[key]=integer(v[key],key,0,Number.MAX_SAFE_INTEGER);return n}
  const config=(raw:unknown)=>{
    const v=warmupObject(raw)
    if(typeof v.enabled!=='boolean'||!Array.isArray(v.profileIds)||v.profileIds.length>1000)throw new Error('Invalid saved run configuration')
    return {enabled:v.enabled,profileIds:v.profileIds.map(id),startDailyLimit:integer(v.startDailyLimit,'Daily start',1,100),dailyIncrement:integer(v.dailyIncrement,'Daily increase',0,20),maxDailyLimit:integer(v.maxDailyLimit,'Daily maximum',1,100),
      minIntervalMinutes:integer(v.minIntervalMinutes,'Interval',5,1440),replyDelayMinutes:integer(v.replyDelayMinutes,'Reply interval',5,1440),maxExchanges:integer(v.maxExchanges,'Exchanges',1,6),...(v.studio===undefined?{}:{studio:parseWarmupStudio(v.studio)})}
  }
  const run=(raw:unknown,summary=false):WarmupRun=>{
    const v=warmupObject(raw);if(!['running','paused','finished'].includes(String(v.status)))throw new Error('Invalid saved run status')
    return {id:id(v.id),name:bounded(v.name,'Run name',120),startedAt:timestamp(v.startedAt),endedAt:nullableTime(v.endedAt),status:v.status as WarmupRun['status'],reason:v.reason===null?null:bounded(v.reason,'Pause reason',512),config:summary?undefined:config(v.config),totals:counts(v.totals)}
  }
  const array=<T>(raw:unknown,max:number,project:(item:unknown)=>T):T[]=>{if(!Array.isArray(raw)||raw.length>max)throw new Error('Invalid workspace page');return raw.map(project)}
  const result:Extract<WarmupWorkspaceResult,{ok:true}>={ok:true}
  if(data.runs!==undefined)result.runs=array(data.runs,100,item=>run(item,true))
  if(data.run!==undefined)result.run=run(data.run)
  if(data.mailboxes!==undefined)result.mailboxes=array(data.mailboxes,1000,raw=>{const v=warmupObject(raw);return {id:id(v.id),...(v.email===undefined?{}:{email:bounded(v.email,'Mailbox',320)}),totals:counts(v.totals)}})
  if(data.days!==undefined)result.days=array(data.days,3662,raw=>{const v=warmupObject(raw);const day=bounded(v.day,'Report date',10);if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw new Error('Invalid report date');return {day,totals:counts(v.totals)}})
  if(data.messages!==undefined)result.messages=array(data.messages,100,raw=>{
    const v=warmupObject(raw)
    if(!['queued','dispatching','sent','accepted','accepted_paused','received','unknown','unverified','failed','cancelled'].includes(String(v.status)))throw new Error('Invalid message status')
    return {id:id(v.id),runId:id(v.runId),fromProfileId:id(v.fromProfileId),toProfileId:id(v.toProfileId),from:bounded(v.from,'Sender',320),to:bounded(v.to,'Recipient',320),subject:bounded(v.subject,'Subject',210),
      body:v.body===''?'':bounded(v.body,'Message',16000,true),templateId:id(v.templateId),templateRevision:integer(v.templateRevision,'Template revision',1,1_000_000),exchange:integer(v.exchange,'Exchange',1,6),status:String(v.status),dueAt:timestamp(v.dueAt),attemptedAt:nullableTime(v.attemptedAt),sentAt:nullableTime(v.sentAt),receivedAt:nullableTime(v.receivedAt),error:v.error===null?null:bounded(v.error,'Message status reason',512)}
  })
  if(data.hasMore!==undefined){if(typeof data.hasMore!=='boolean')throw new Error('Invalid page state');result.hasMore=data.hasMore}
  if(data.nextCursor!==undefined)result.nextCursor=bounded(data.nextCursor,'History cursor',1024)
  if(result.hasMore&&!result.nextCursor)throw new Error('Incomplete workspace page')
  return result
}

/** Compare immutable setup independent of object key insertion order across JSON/IPC. */
export function warmupRunSetupKey(config: {enabled:boolean;studio?:WarmupStudioConfig;[key:string]:unknown} | unknown): string {
  const value = warmupObject(config)
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,canonical(v)])) : item
  return JSON.stringify(canonical({...value,enabled:false,studio:value.studio?{...warmupObject(value.studio),pausedProfileIds:[]}:undefined}))
}
