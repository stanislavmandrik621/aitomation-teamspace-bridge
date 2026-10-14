import type { RecordTeamworkAction, RecordTeamworkActor, RecordTeamworkCommand, RecordTeamworkConfig, RecordTeamworkEvent, RecordTeamworkState, RecordTeamworkChange } from './record-teamwork-types.js'

export const emptyRecordTeamwork = (): RecordTeamworkState => ({ revision: 0, config: null, review: { state: 'none' }, recordRevision: 0 })
/** Only collaboration state is captured here; ordinary record fields keep their
 * existing field-level history and access checks. Copies cannot change later. */
export function recordTeamworkChanges(before: RecordTeamworkState, after: RecordTeamworkState): RecordTeamworkChange[] {
  return (['config', 'review', 'handoff', 'help', 'result'] as const).flatMap(field => {
    const oldValue = before[field] ?? null, newValue = after[field] ?? null
    return JSON.stringify(oldValue) === JSON.stringify(newValue) ? []
      : [structuredClone({ field, before: oldValue, after: newValue }) as RecordTeamworkChange]
  })
}
export type RecordTeamworkAuthority = {
  actor: RecordTeamworkActor; canConfigure: boolean; canWrite: boolean; teamId: string | null
  /** Must prove current membership plus actual module/record/field access. */
  validateMember: (id: string) => void
  validateConfig: (config: RecordTeamworkConfig) => void
  validateHandoff: (to: NonNullable<RecordTeamworkState['handoff']>['to'], config: RecordTeamworkConfig) => void
}
export function recordTeamworkAllowedActions(state: RecordTeamworkState, authority: RecordTeamworkAuthority): RecordTeamworkAction[] {
  if (!authority.canWrite || !state.config) return []
  const actions: RecordTeamworkAction[] = ['request_help', 'submit_result', 'request_review']
  if (state.config.assigneeFieldId) actions.push('handoff')
  if (state.help?.state === 'open') actions.push('resolve_help')
  if (state.review.state === 'pending' && authority.actor.kind === 'member'
    && state.config.reviewerMemberIds.includes(authority.actor.id)) actions.push('approve', 'request_changes')
  return actions
}
/** Closed assistant action surface, regardless of the delegating person's role. */
export function assertRecordTeamworkAssistantCommand(command: unknown): asserts command is RecordTeamworkCommand {
  if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('Invalid assistant teamwork action')
  const value = command as Record<string, unknown>
  if (!['handoff', 'request_help', 'resolve_help', 'submit_result', 'request_review'].includes(String(value.action))) throw new Error('Assistants cannot configure teamwork or make human review decisions')
  if (Object.keys(value).some(key => !['action', 'note', 'to'].includes(key))) throw new Error('Assistant actor identity is derived from the authenticated account')
  if (value.action !== 'handoff' && value.to !== undefined) throw new Error('Only handoff accepts an assignee')
  if (value.action === 'handoff' && (!value.to || typeof value.to !== 'object' || Array.isArray(value.to) || Object.keys(value.to).some(key => !['id', 'label', 'kind', 'teamId'].includes(key)))) throw new Error('Invalid assistant handoff identity')
}
function cleanNote(value: unknown, required: boolean): string | undefined {
  if (value !== undefined && typeof value !== 'string') throw new Error('Invalid teamwork note')
  const note = typeof value === 'string' ? value.trim() : ''
  if (note.includes('\0') || note.length > 20_000) throw new Error('The teamwork note is too long or invalid')
  if (required && !note) throw new Error('Add a note explaining this action')
  return note || undefined
}
function cleanConfig(raw: RecordTeamworkConfig): RecordTeamworkConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid teamwork configuration')
  const ids = ['assigneeFieldId', 'statusFieldId', 'dueFieldId', 'departmentId'] as const
  for (const key of ids) if (raw[key] !== undefined && (typeof raw[key] !== 'string' || !raw[key] || raw[key]!.length > 200 || raw[key]!.includes('\0'))) throw new Error('Invalid configured identity')
  if (typeof raw.reviewRequired !== 'boolean' || !Array.isArray(raw.completedStatusValues) || raw.completedStatusValues.length > 100
    || raw.completedStatusValues.some(v => typeof v !== 'string' || !v || v.length > 500)) throw new Error('Invalid completion choices')
  if (!Array.isArray(raw.reviewerMemberIds) || raw.reviewerMemberIds.length > 500
    || raw.reviewerMemberIds.some(v => typeof v !== 'string' || !v || v.length > 128 || v.includes('\0'))) throw new Error('Invalid reviewers')
  if (raw.reviewRequired && (!raw.statusFieldId || !raw.completedStatusValues.length || !raw.reviewerMemberIds.length)) throw new Error('Required review needs a status field, completion choices and reviewers')
  return { ...Object.fromEntries(ids.filter(k => raw[k] !== undefined).map(k => [k, raw[k]])), completedStatusValues: [...new Set(raw.completedStatusValues)], reviewRequired: raw.reviewRequired, reviewerMemberIds: [...new Set(raw.reviewerMemberIds)] }
}
/** Pure reducer; caller persists snapshot and attributed event atomically. */
export function applyRecordTeamworkCommand(previous: RecordTeamworkState, expectedRevision: number, command: RecordTeamworkCommand, authority: RecordTeamworkAuthority, eventIdentity: { id: string; at: string }): { state: RecordTeamworkState; event: RecordTeamworkEvent } {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision !== previous.revision) throw new Error('Teamwork changed. Refresh and review the latest state before retrying')
  if (!authority.canWrite) throw new Error('You cannot change teamwork for this record')
  if (!command || typeof command !== 'object') throw new Error('Invalid teamwork action')
  if (authority.actor.delegatedBy) assertRecordTeamworkAssistantCommand(command)
  const state = structuredClone(previous)
  const actor = structuredClone(authority.actor)
  const note = command.action === 'configure' ? undefined : cleanNote(command.note, ['request_help','submit_result','request_changes'].includes(command.action))
  if (command.action === 'configure') {
    if (authority.actor.delegatedBy || !authority.canConfigure) throw new Error('Only a module administrator can configure teamwork')
    const config = command.config === null ? null : cleanConfig(command.config)
    if (config) {
      authority.validateConfig(config)
      for (const member of config.reviewerMemberIds) authority.validateMember(member)
      if (!authority.teamId && config.reviewRequired) throw new Error('Human approval requires this module to be shared with its team')
    }
    state.config = config; state.review = { state: 'none' }
  } else {
    if (!recordTeamworkAllowedActions(previous, authority).includes(command.action)) throw new Error('This action is not allowed in the current review state')
    if (command.action === 'handoff') {
      authority.validateHandoff(command.to, state.config!)
      state.handoff = { to: structuredClone(command.to), from: actor, ...(note ? { note } : {}) }
    } else if (command.action === 'request_help') state.help = { state: 'open', note: note!, requestedBy: actor }
    else if (command.action === 'resolve_help' && state.help) state.help = { ...state.help, state: 'resolved' }
    else if (command.action === 'submit_result') { state.result = { note: note!, submittedBy: actor }; state.review = { state: 'none' } }
    else if (command.action === 'request_review') {
      if (!state.config!.reviewerMemberIds.length) throw new Error('Configure reviewers before requesting a review')
      for (const member of state.config!.reviewerMemberIds) authority.validateMember(member)
      state.review = { state: 'pending', requestedBy: actor, recordRevision: state.recordRevision, ...(note ? { note } : {}) }
    } else if (command.action === 'approve' || command.action === 'request_changes') {
      authority.validateMember(actor.id)
      if (state.review.recordRevision !== state.recordRevision) throw new Error('The record changed after review was requested')
      state.review = { ...state.review, state: command.action === 'approve' ? 'approved' : 'changes_requested', reviewedBy: actor, ...(note ? { note } : {}) }
    }
  }
  state.revision++
  const event: RecordTeamworkEvent = { ...eventIdentity, revision: state.revision, action: command.action, actor, recordRevision: state.recordRevision, changes: recordTeamworkChanges(previous, state), ...(note ? { note } : {}), ...(command.action === 'handoff' ? { to: structuredClone(command.to) } : {}) }
  return { state, event }
}
/** Multi-select cells retain every choice; never join them into an invented status. */
export function recordTeamworkStatusIsCompleted(value: unknown, completed: readonly string[]): boolean {
 const choices = Array.isArray(value) ? value : [value]
 return choices.some(choice => (typeof choice === 'string' || typeof choice === 'number' || typeof choice === 'boolean') && completed.includes(String(choice)))
}
/** Any accepted content change consumes approval, except the sole approved completion transition. */
export function recordTeamworkWriteGate(state: RecordTeamworkState, changed: Record<string, unknown>, statusKeys: string[]): { completion: boolean } {
  if (!state.config) return { completion: false }
  const statuses = Object.keys(changed).filter(key => statusKeys.includes(key))
  const completion = statuses.some(key => recordTeamworkStatusIsCompleted(changed[key], state.config!.completedStatusValues))
  if (completion && state.config.reviewRequired) {
    if (state.review.state !== 'approved' || state.review.recordRevision !== state.recordRevision) throw new Error('This record requires approval of its latest content before completion')
    if (Object.keys(changed).some(key => !statusKeys.includes(key))) throw new Error('Save content changes and request a new review before completing this record')
  }
  return { completion }
}
export function recordTeamworkAfterWrite(previous: RecordTeamworkState, completion: boolean): RecordTeamworkState {
  if (!previous.config) return previous
  return { ...previous, revision: previous.revision + 1, recordRevision: previous.recordRevision + 1,
    review: completion && previous.review.state === 'approved' ? { ...previous.review, recordRevision: previous.recordRevision + 1 } : { state: 'none' } }
}
