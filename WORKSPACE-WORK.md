# Self-hosted workspace work and AI review

Workspace work is an explicitly shared server workspace. It is **not** an automatic copy of any desktop project. A bridge administrator registers an exact member audience and workspace managers. An accepted team invitation establishes a bridge session but grants no workspace access until an authorized manager includes that member. Pending invite tokens cannot authenticate these APIs. The existing paid-host/free-invited-member admission remains unchanged; this subsystem does not introduce a paid-member requirement or another licensing identity.

Every member read requires a current bridge session and explicit workspace membership. Every mutation rejects viewers. Workspace managers manage the audience, departments, tasks, and AI-reviewer credentials; self-edited profile requests do not grant department or approval authority. Bridge administrators are not implicitly members of every workspace. Revoking a bridge member or downgrading to viewer takes effect on the next request and again before a body-reading request commits.

## API

All member routes use `Authorization: Bearer <existing bridge session token>`; query tokens are refused. Never put credentials in a URL, console log, source file, or shared document.

- `GET /workspace-work`: visible workspace directory and existing minimal team directory, with independent `cursor` and `memberCursor` numeric offsets, `limit` 1–50. Responses contain `page` and `membersPage`; callers must follow cursors instead of assuming the first page is complete.
- `GET /workspace-work?workspaceId=...`: snapshot, actor permissions, exact workspace member IDs, bounded first pages, and `pages` metadata. `collection=profiles|departments|tasks|events&cursor=revision:offset` fetches further collection pages. Cursors from an older workspace revision return 409. Restart pagination after a conflict. `memberCursor` pages the names of current workspace members.
- Task summaries contain the latest submission and current-revision decisions plus `historyCounts`. `GET /workspace-work?workspaceId=...&taskId=...&history=submissions|decisions&cursor=revision:offset` reads preserved history in bounded pages.
- `GET /workspace-work?workspaceId=...&taskId=...` returns exactly that task without scanning collection pages. Its durable `assignmentVersion` detects release/reassignment changes, including reassigning back to the same person. Consumers waiting on a task must freeze and verify this version, task identity, and review policy before treating a later completion as the same work.
- `POST /workspace-work`: `{workspaceId,commandId,expectedRevision,action,payload}`. Command identifiers are unique UUIDs; retain the same ID/payload when retrying an uncertain response. All existing-workspace mutations require the current revision. Registration uses revision 0. Successful replies are intentionally small first-page snapshots; refresh the relevant collections after a command.

Exact payload types and transitions live in `src/workspace-work.ts`. Actions: `registerWorkspace`, `setWorkspaceMembers`, `updateProfile`, `setDepartment`, `createTask`, `claimTask`, `startTask`, `releaseTask`, `requestHelp`, `submitTask`, `reviewTask`, `reassignTask`, `cancelTask`. Titles, descriptions, evidence and lists are bounded; oversized writes fail without deleting existing evidence. Human task acceptance is explicit, not inferred from module presence or editing. Submission evidence cannot be edited; a new submission produces a new version. Decisions target the exact submitted version, and independent human reviewers cannot review their own submission. Human/AI lists are conjunctive: every designated reviewer in a required list must approve. `ai_then_human` requires all AI decisions first; `both` permits either order but requires both groups.

`setTaskReviewPolicy` is a manager-only recovery action with `{taskId,reviewPolicy}` for work stranded by a revoked/downgraded reviewer. Final tasks cannot change policy. Updating an in-review task requests changes and requires a fresh evidence submission; existing decisions are preserved but cannot be reinterpreted under replacement reviewers. Operational assignments/managers/reviewers must be active non-viewer members. A viewer may still belong to the workspace audience. External bridge role changes can remove the last working workspace manager; an existing bridge administrator must restore appropriate bridge membership/role before that workspace can be administered again. Workspace membership itself never grants bridge roles.

## Optional coordinator monitoring

The Workspace Coordinator panel offers **Enable monitoring** for the signed-in member. This is a private opt-in per server workspace; enabling it does not subscribe another member. It checks shared work for blockers, overdue items, actionable human reviews and requested changes. Workspace managers additionally see unassigned work and unavailable reviewers. It reads shared task facts only. It makes no model calls, sends no messages or notifications to other people, and cannot assign, complete or approve work. AI answers and proposed handoffs remain explicit panel actions.

`GET /workspace-work/coordinator?workspaceId=...` reads the current member's preference, runner status, last check time and attention list. `POST /workspace-work/coordinator` accepts exactly `{workspaceId,enabled}`. Both require the existing member bearer; the server chooses the member from that session. Viewers cannot enable monitoring. Workspace/member revocation and role downgrade remove affected opt-ins when the membership change commits, and are also checked on each read and monitoring pass. Restoring access requires a new opt-in, even when removal and re-admission occur before the next monitoring pass.

The monitor runs inside the existing bridge process while opted-in desktops are closed. The bridge's exclusive data-directory lock provides a single owner; this is not a distributed lease or automatic failover service. Monitoring resumes from encrypted `workspace-coordinator-monitor.json` preferences after restart and rebuilds active attention from durable tasks. Back up that file with `workspace-work.json` and the rest of the stopped bridge data directory. A bridge outage stops monitoring; the desktop reports connection failure instead of asserting the runner is online. Disabling monitoring removes this preference durably. Corrupt preference storage fails closed and is not silently reset.

Operational limits are **100 active member/workspace subscriptions per bridge**, **10,000 tasks scanned per workspace**, and **100 returned attention rows**. The response exposes the total and a truncation flag when more attention exists. Passes are staggered over a nominal **30-second cycle**; synchronous disk work, task history sizes and host load can delay checks, so this is not a 30-second service guarantee. Work-revision and authority checks allow unchanged scans to reuse their results; due dates, reviewer-role changes and AI credential expiry invalidate relevant results. This edition has no durable notification delivery queue, automatic AI execution, external messaging, or enterprise-throughput certification. Measure the intended workload before relying on these bounds at scale.

## AI reviewer authority

A member's renderer cannot submit an AI decision by changing `reviewerKind`. A workspace manager must explicitly issue a dedicated reviewer service credential to a trusted self-hosted runner:

`POST /workspace-work/ai-reviewers` with a member bearer and JSON `{workspaceId,agentId,commandId,expectedRevision,expiresAt}`. `expiresAt` is an epoch-millisecond date within 30 days. The response contains a one-time `token` and the committed revision. Store that token directly in the runner's secret manager; do not send it to AI prompts. The server stores only its hash. Reissuing for the same agent rotates the old credential. `{...,revoke:true}` revokes it. A lost issuance response must be rotated with a new command ID; the original secret cannot be recovered from the server.

For an operator-controlled shell, keep the member token in a secret-backed environment variable and supply JSON over stdin, rather than including a token in shell history:

```sh
# The variables below must already be supplied by your private secret/config system.
curl --fail-with-body --silent --show-error \
  --config /dev/fd/3 --header 'Content-Type: application/json' \
  --data-binary @- "$WORK_REVIEW_BRIDGE_URL/workspace-work/ai-reviewers" \
  3<<<"header = \"Authorization: Bearer $WORKSPACE_MEMBER_TOKEN\""
```

Enter the issuance JSON through stdin. Capture the response into the private runner secret store, **not** a shared terminal recording or diagnostics attachment. This example intentionally supplies no actual token, workspace identifiers, or sample credentials.

The service bearer can only read its assigned pending task/latest evidence at `GET /workspace-work/ai-review?workspaceId=...&taskId=...` and submit `reviewTask` to `POST /workspace-work/ai-review?workspaceId=...`. It cannot read workspace profiles, unrelated tasks, or issue ordinary commands. Credentials expire and become invalid if the issuing manager is removed, loses workspace-manager access, or becomes a viewer. This is service authority, not cryptographic proof that a particular model generated a decision; operate the runner as a trusted service.

Snapshots expose only `aiReviewers:[{agentId,expiresAt,active}]` for selection, never hashes, raw tokens, or issuer secrets. Tasks can only designate AI reviewers with active workspace credentials. Active means the credential is currently authorized, **not** that a runner is online or has completed inference. Rotation/revocation invalidates previously admitted service actors and replay attempts too.

## One-shot local runner

`src/workspace-ai-review-runner.ts` performs a real model request and submits a validated decision. Set:

- `WORK_REVIEW_BRIDGE_URL`: bridge origin, HTTPS remotely or HTTP on loopback.
- `WORK_REVIEW_CREDENTIAL`: scoped service credential from the private secret store.
- `WORK_REVIEW_WORKSPACE_ID`, `WORK_REVIEW_TASK_ID`: the explicit pending task.
- `WORK_REVIEW_MODEL_ENDPOINT`: full OpenAI-compatible Chat Completions URL, e.g. your local inference service's `/v1/chat/completions`. There is **no default provider**. HTTPS is required for remote endpoints; HTTP is allowed only on loopback.
- `WORK_REVIEW_MODEL`: model available on that service.
- `WORK_REVIEW_MODEL_API_KEY`: optional endpoint credential, supplied separately and never sent to the bridge.

Run `node --import tsx src/workspace-ai-review-runner.ts` (or build and run `node dist/workspace-ai-review-runner.js`). The endpoint must support strict `response_format: json_schema`; an incompatible endpoint fails closed rather than silently dropping structured-output validation. No tools are supplied. Task content is marked untrusted. The bridge credential is never included in the model request. Responses are size/time bounded; partial, malformed, refused, and schema-invalid decisions fail. Evidence changes during inference prevent stale approval. A bounded revision retry is allowed only when the same evidence and objective remain current. Uncertain submissions retry the same command ID.

The runner can use a local model, but it does not guarantee the quality of that model's review. High-risk work should require a human approval as well. It is intentionally one-shot: orchestration/scheduling must call it for an assigned task. No automatic background polling, leadership-summary generation, or external workflow-engine resume is claimed. Snapshot capabilities distinguish `aiReviewSubmission:true` from `aiReviewExecution:false` (no connected-runner liveness registry) and `durableWorkflowResume:false`.

Programmatic callers can supply an `AbortSignal`. Cancellation before submission prevents a decision write; cancellation after dispatch reports an uncertain outcome and never automatically retries the cancelled call. A known configured model/service credential reflected into a decision is rejected before permanent storage. Revision retries also verify the unchanged assignment incarnation and review policy, not only the evidence text. Credential revocation accepts only a literal boolean `revoke:true` and does not require manufacturing a new expiry date.

## Durability, bounds and verification

The bridge's existing exclusive data-directory lock ensures one writer process. Synchronous mutations clone, validate, fsync and atomically rename `workspace-work.json` before publishing the new revision. Existing `TEAMSPACE_AT_REST_KEY` encryption applies when configured. Corrupt/unreadable existing data fails closed; it is never silently reset. Audit and evidence history have no application edit/delete command. This is not a tamper-proof external compliance ledger.

Current safety limits: 32 MB persisted snapshot, 1,000 registered workspaces, 10,000 tasks/workspace, 100,000 audit commands/workspace, 1,000 submissions/task, 2,000 members/workspace, 100 reviewers of each type/task. Capacity failures preserve existing records. Large deployments need a storage/archival migration and measured load testing before claiming enterprise-scale throughput; synchronous file persistence is not a distributed database. There is no automatic archive/retention deletion of decision evidence.

Verification commands:

```sh
npm run build
node --import tsx tests/workspace-work-real.ts
node --import tsx tests/workspace-work-hardening-real.ts
node --import tsx tests/workspace-work-http-real.ts
node --import tsx tests/workspace-coordinator-monitor-real.ts
node --import tsx tests/workspace-coordinator-monitor-http-real.ts
```

The first regression uses real disk/encryption/reloads, concurrent revision attempts, revocation and storage failures. The HTTP regression starts an isolated real bridge and real local HTTP protocol fixture, exercises actual invitation redemption/role downgrade/kick, scoped AI authority, and human approval gates. The model protocol fixture is **not** a live-model/provider validation; no inference quality is claimed.

The coordinator regressions use actual encrypted member/work/preference storage and an isolated real bridge process. They exercise opt-in, restart, due-time changes, paging, role/member revocation, storage failures, strict desktop projections and actual HTTP/IPC transport. No model service or generated review decision is used in these coordinator tests.
