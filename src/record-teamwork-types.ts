export type ModulePersonReference = { id: string; label: string; kind?: 'agent' } | { id: string; label: string; kind: 'member'; teamId: string }

/** Collaboration belongs to this existing record; it never creates a task. */
export type RecordTeamworkIdentity = { teamId: string | null; moduleId: string; entityId: string; recordId: string }
export type RecordTeamworkScope = 'all' | 'blocked' | 'overdue' | 'pending_review'
export type RecordTeamworkActor = { id: string; name: string; kind: 'member' | 'user' | 'agent'; delegatedBy?: { id: string; name: string; kind: 'member' | 'user' } }
export type RecordTeamworkAction = 'handoff' | 'request_help' | 'resolve_help' | 'submit_result' | 'request_review' | 'approve' | 'request_changes'
export type RecordTeamworkConfig = {
  assigneeFieldId?: string
  statusFieldId?: string
  dueFieldId?: string
  completedStatusValues: string[]
  reviewRequired: boolean
  reviewerMemberIds: string[]
  departmentId?: string
}
export type RecordTeamworkEvent = {
  id: string; revision: number; action: RecordTeamworkAction | 'configure' | 'approval_invalidated'
  actor: RecordTeamworkActor; at: string; note?: string; to?: ModulePersonReference
  /** Absent on older events: never reconstruct historical values from today's record. */
  recordRevision?: number
  changes?: RecordTeamworkChange[]
}
export type RecordTeamworkState = {
  revision: number
  config: RecordTeamworkConfig | null
  review: { state: 'none' | 'pending' | 'approved' | 'changes_requested'; requestedBy?: RecordTeamworkActor; reviewedBy?: RecordTeamworkActor; note?: string; recordRevision?: number }
  handoff?: { to: ModulePersonReference; from: RecordTeamworkActor; note?: string }
  help?: { state: 'open' | 'resolved'; note: string; requestedBy: RecordTeamworkActor }
  result?: { note: string; submittedBy: RecordTeamworkActor }
  recordRevision: number
}
export type RecordTeamworkChange = {
  [K in 'config' | 'review' | 'handoff' | 'help' | 'result']: {
    field: K; before: Exclude<RecordTeamworkState[K], undefined> | null; after: Exclude<RecordTeamworkState[K], undefined> | null
  }
}['config' | 'review' | 'handoff' | 'help' | 'result']
export type RecordTeamworkSnapshot = RecordTeamworkState & {
  identity: RecordTeamworkIdentity
  currentMemberId: string | null
  currentUserId: string | null
  canConfigure: boolean
  allowedActions: RecordTeamworkAction[]
  history: RecordTeamworkEvent[]
  historyTotal: number
}
export type RecordTeamworkCommand =
  | { action: 'configure'; config: RecordTeamworkConfig | null }
  | { action: Exclude<RecordTeamworkAction, 'handoff'>; note?: string }
  | { action: 'handoff'; to: ModulePersonReference; note?: string }
export type RecordTeamworkReadArgs = { recordId: string; limit?: number; offset?: number }
export type RecordTeamworkConfigureArgs = { recordId: string; expectedRevision: number; config: RecordTeamworkConfig | null }
export type RecordTeamworkActArgs = { recordId: string; expectedRevision: number; action: RecordTeamworkAction; note?: string; to?: ModulePersonReference }

/** Authenticated account delegation; does not attest a model or active agent run. */
export type RecordTeamworkAssistantAction = 'handoff' | 'request_help' | 'resolve_help' | 'submit_result' | 'request_review'
export type RecordTeamworkAssistantActArgs = Omit<RecordTeamworkActArgs, 'action'> & { action: RecordTeamworkAssistantAction }
