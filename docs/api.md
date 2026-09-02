# Code API reference

`@agwab/pi-subagent/api` is the only public code entry point (ESM). Everything below is exported from it; `src/*` paths are internal. Narrative guidance and examples live in [`usage.md`](./usage.md#code-api).

Shared reference shape (`RunStatusRef`): `{ runId, cwd?, runsDir?, attemptId? }`. When `cwd` is omitted, helpers resolve the run through the global locator index first and fall back to the current cwd for legacy records. `runsDir` must stay inside `cwd`. `taskId` is a deprecated alias for `attemptId`.

## Runs

| Export | Signature | Returns / notes |
|---|---|---|
| `runSubagent` | `(options: RunSubagentOptions) => Promise<ResultEnvelope \| ParallelRunResult>` | Same options as the tool (`agent`/`task` or `tasks`, `backend`, `sandbox`, `worktree`, `model`, `async`, `onComplete`, `durableLaunchBarrier`, …) plus an optional `signal: AbortSignal`. Sync runs resolve with the terminal `ResultEnvelope`; `async: true` resolves once the durable worker is launched. Invalid input rejects with `SubagentValidationError` (`failureKind: "validation"`). |
| `getSubagentStatus` | `(ref: RunStatusRef) => Promise<RunStatusSnapshot \| null>` | `null` when the run is unknown. Snapshot carries `status`, `failureKind`, `backend`, timings, `logs[]`, `resultPath`, `metadata` (usage, model, stream errors), `attempts[]`, `childSummary`, and `eventTail`. |
| `getSubagentLogs` | `(ref: RunStatusRef) => Promise<RunStatusSnapshot \| null>` | Same snapshot with log contents (stdout/stderr/output tails) attached. |
| `waitForSubagent` | `(options: RunStatusRef & { timeoutMs?, pollIntervalMs? }) => Promise<{ status: "completed" \| "timeout"; outcome: "terminal" \| "timeout"; snapshot }>` | `status: "completed"` means the wait reached *any* terminal run status; check `snapshot.status` for the run outcome. |
| `interruptSubagent` | `(options: RunStatusRef & { reason?, signal?: NodeJS.Signals, escalateAfterMs?, killAfterMs? }) => Promise<InterruptRunResult>` | Sends `SIGTERM` (default; graceful stop for a headless Pi child, which also terminates its tool subprocesses) to verified process targets, re-sends `SIGTERM` after `escalateAfterMs` (1 s) and `SIGKILL` after `killAfterMs` (3 s). `status` is `interrupt-requested`, `not-found`, `already-terminal`, or `unsupported` (no interruptable process metadata). Async runs record `failureKind: "user_cancelled"`. |
| `reconcileSubagentRun` | `(options: RunStatusRef & { staleAfterMs?, expectedAttemptId? }) => Promise<ReconcileSubagentRunResult>` | Re-reads durable artifacts and repairs local metadata without relaunching. `status`: `running`, `already-terminal`, `committed-result`, `marked-stale`, `marked-cancelled`, `superseded` (another attempt is active; nothing mutated), `cleanup-blocked` (with `cleanupBlocked.reason` and attempt ids), or `not-found`. |
| `recordSubagentChildEvent` | `(options: RunStatusRef & { event, childRunId, workflowRunId?, childTaskId?, status?, failureKind?, message?, usage? }) => Promise<RunEvent>` | Appends a `child.started/updated/completed/failed/cancelled` event to the parent run for orchestrators; feeds `childSummary` in status and the panel. |
| `pruneSubagentRuns` | `(options?: { cwd?, runsDir?, keep?, olderThanDays?, yes?, now? }) => Promise<PruneSubagentRunsSummary>` | Selects fully terminal runs beyond the newest `keep` (default 50) and, when set, older than `olderThanDays`. Dry run unless `yes: true`. Never deletes runs with a non-terminal run/attempt/task status or unreadable records; re-reads each run before deleting; removes the run's global locator only when it points at the same cwd/runs dir. Summary: `status` (`dry-run`/`pruned`), `selected[]` with bytes, `deletedRunIds`, `deletedBytes`, `skippedActive`, `skippedUnreadable`, `deleteErrors`. |
| `formatPruneSubagentRunsSummary` | `(summary) => string` | Human-readable rendering used by `/subagent prune`. |
| `SubagentValidationError` | `class extends Error { failureKind: "validation"; backend? }` | Thrown by `runSubagent` for invalid input or fail-closed backend resolution. |

## Durable launch barrier (v2)

Use v2 when a caller must decide, after the worker is ready, whether to release or revoke exactly once. All descriptors are plain JSON objects safe to persist. Directories must be absolute, owner-only, and private to one attempt.

| Export | Signature | Notes |
|---|---|---|
| `createDurableLaunchBarrierV2` | `({ directory, subjectSha256, authorityBindingSha256?, challenge?, decisionNonce?, timeoutMs?, pollIntervalMs? }) => Promise<DurableLaunchBarrierV2Descriptor>` | Pass the descriptor as `durableLaunchBarrier` to `runSubagent({ async: true, … })`. |
| `waitForDurableLaunchBarrierV2Ready` | `(descriptor) => Promise<DurableLaunchBarrierV2Ready>` | Resolves when the worker has bound its immutable execution plan. |
| `resolveDurableLaunchBarrierV2Release` | `(descriptor, ready, releasePayloadSha256) => Promise<DurableLaunchBarrierV2Resolution>` | Competes with revocation for the single decision file; `outcome` is `released` or `revoked`. |
| `revokeDurableLaunchBarrierV2` | `(descriptor, { cancellationId, reasonSha256 }) => Promise<DurableLaunchBarrierV2Resolution>` | If release already won, returns `outcome: "released"` instead of rewriting history. |
| `waitForDurableLaunchBarrierV2Ack` | `(descriptor, decision) => Promise<DurableLaunchBarrierV2Ack>` | Worker acknowledgement of a release decision. |
| `readDurableLaunchBarrierV2State` | `(descriptor) => Promise<DurableLaunchBarrierV2State>` | Read-only view of ready/decision/ack files for recovery. |
| `assertDurableLaunchBarrierV2ExecutionAuthorized` | `(descriptor, ack) => Promise<DurableLaunchBarrierV2ReleaseDecision>` | Fails closed unless the persisted decision authorizes exactly this ack. |
| `durableLaunchBarrierDigest` | `(value: unknown) => string` | Canonical SHA-256 over JSON for subject/authority/release payload digests. |
| `isDurableLaunchBarrierError`, `isDurableLaunchBarrierRevokedError` | `(error: unknown) => boolean` | Type guards for `DurableLaunchBarrierError` / `DurableLaunchBarrierRevokedError`. |
| `DurableLaunchBarrierError`, `DurableLaunchBarrierRevokedError` | classes | Thrown on timeout, identity drift, malformed records, or revocation. |

## Durable launch barrier (v1, compatibility)

`createDurableLaunchBarrier`, `waitForDurableLaunchBarrierReady`, `releaseDurableLaunchBarrier`, `waitForDurableLaunchBarrierAck`. v1 has no shared release-or-revoke decision object; do not use it to claim that a concurrent cancellation can prevent release.

## Types

Exported for TypeScript consumers: `RunSubagentOptions`, `RunSubagentResult`, `GetSubagentStatusOptions`, `GetSubagentLogsOptions`, `WaitForSubagentOptions`, `InterruptSubagentOptions`, `ReconcileSubagentOptions`, `RecordSubagentChildEventOptions`, `RunStatusSnapshot`, `WaitForRunResult`, `InterruptRunResult`, `ReconcileSubagentRunResult`, `ParallelRunResult`, `ResultEnvelope`, `PruneSubagentRunsOptions`, `PruneSubagentRunsSummary`, `PruneSubagentRunCandidate`, and the `DurableLaunchBarrier*` descriptor/decision/state types.
