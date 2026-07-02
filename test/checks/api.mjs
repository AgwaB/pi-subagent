import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import {
  getSubagentLogs,
  getSubagentStatus,
  interruptSubagent,
  reconcileSubagentRun,
  recordSubagentChildEvent,
  runSubagent,
  SubagentValidationError,
  waitForSubagent,
} from "../../api.mjs";
import { createAttemptArtifactStore } from "../../src/artifacts/index.ts";
import { startAsyncSubagentRun } from "../../src/orchestrate/async.ts";

assert.equal(pkg.exports["./api"].default, "./api.mjs");
assert.equal(pkg.exports["./api"].types, "./src/api.ts");
assert.equal(typeof runSubagent, "function");
assert.equal(typeof getSubagentStatus, "function");
assert.equal(typeof getSubagentLogs, "function");
assert.equal(typeof waitForSubagent, "function");
assert.equal(typeof interruptSubagent, "function");
assert.equal(typeof reconcileSubagentRun, "function");
assert.equal(typeof recordSubagentChildEvent, "function");

let cwd;
try {
  await assert.rejects(
    () => runSubagent({ backend: "inline" }),
    (error) => error instanceof SubagentValidationError && error.failureKind === "validation" && /agent\/task input/.test(error.message),
  );

  cwd = await mkdtemp(join(tmpdir(), "pi-subagent-api-check-"));
  const runId = "run_api_check";
  const attemptId = "attempt_api_check";
  const store = await createAttemptArtifactStore({ cwd, runId, attemptId });
  const output = await store.writeTextArtifact("output", "api-ok\n");
  const result = await store.writeResult({
    backend: "inline",
    status: "completed",
    failureKind: null,
    cwd,
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    completedAt: new Date("2026-01-01T00:00:01.000Z"),
    workspace: { mode: "shared", cwd },
    sandbox: { enabled: false },
    exitCode: 0,
    signal: null,
    artifacts: [output],
    metadata: { contextLengthExceeded: false },
  });
  await recordSubagentChildEvent({
    cwd,
    runId,
    event: "failed",
    childRunId: "run_child_api",
    childTaskId: "task-4",
    failureKind: "model",
    message: "child model failed",
  });

  const status = await getSubagentStatus({ cwd, runId, attemptId });
  assert.equal(status?.status, "completed");
  assert.equal(status?.runId, runId);
  assert.equal(status?.attemptId, attemptId);
  assert.equal(status?.resultPath, result.artifacts.find((artifact) => artifact.type === "result")?.path);
  assert.equal(status?.childSummary?.failed, 1);
  assert.equal(status?.childSummary?.latestFailure?.childRunId, "run_child_api");

  const logs = await getSubagentLogs({ cwd, runId, attemptId });
  assert.equal(logs?.logText.output, "api-ok\n");

  const waited = await waitForSubagent({ cwd, runId, attemptId, timeoutMs: 100, pollIntervalMs: 10 });
  assert.equal(waited.status, "completed");
  assert.equal(waited.snapshot?.status, "completed");

  const missingInterrupt = await interruptSubagent({ cwd, runId: "run_missing_api_check" });
  assert.equal(missingInterrupt.status, "not-found");

  const legacyDir = join(cwd, ".pi/agent/runs/run_api_legacy/task-1");
  await mkdir(legacyDir, { recursive: true });
  const legacyOutput = ".pi/agent/runs/run_api_legacy/task-1/output.log";
  const legacyResult = ".pi/agent/runs/run_api_legacy/task-1/result.json";
  await writeFile(join(cwd, legacyOutput), "legacy-ok\n");
  await writeFile(join(cwd, legacyResult), `${JSON.stringify({
    schemaVersion: 1,
    runId: "run_api_legacy",
    taskId: "task-1",
    backend: "inline",
    status: "completed",
    failureKind: null,
    cwd,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1000,
    workspace: { mode: "shared", cwd, worktreePath: null },
    sandbox: { enabled: false },
    exitCode: 0,
    signal: null,
    artifacts: [{ type: "output", path: legacyOutput }, { type: "result", path: legacyResult }],
  }, null, 2)}\n`);
  const legacyStatus = await getSubagentStatus({ cwd, runId: "run_api_legacy", taskId: "task-1" });
  assert.equal(legacyStatus?.attemptId, "task-1");
  assert.equal(legacyStatus?.metadata.contextLengthExceeded, false);

  assert.match(await readFile(join(cwd, ".pi/agent/runs", runId, "attempts", attemptId, "output.log"), "utf8"), /api-ok/);

  let completionCalls = 0;
  const failedStart = await startAsyncSubagentRun({
    cwd,
    backend: "inline",
    input: { onComplete: "notify" },
    onComplete(result, mode) {
      completionCalls += 1;
      assert.equal(mode, "single");
      assert.equal(result.status, "failed");
      return 1;
    },
  });
  const failedWait = await waitForSubagent({ cwd, runId: failedStart.runId, attemptId: failedStart.attemptId, timeoutMs: 3000, pollIntervalMs: 50 });
  assert.equal(failedWait.status, "completed");
  assert.equal(failedWait.snapshot?.status, "failed");
  let failedStatus;
  for (let index = 0; index < 40; index += 1) {
    failedStatus = await getSubagentStatus({ cwd, runId: failedStart.runId, attemptId: failedStart.attemptId });
    if (failedStatus?.completion?.notified) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(failedStatus?.metadata.contextLengthExceeded, false);
  assert.equal(failedStatus?.completion?.notified, true);
  assert.equal(failedStatus?.completion?.updatesSent, 1);
  assert.equal(completionCalls, 1);

  const asyncParallel = await runSubagent({
    cwd,
    backend: "inline",
    async: true,
    timeoutMs: 1000,
    correlationId: "corr_api_async_parallel",
    tasks: [{ task: "async A" }, { task: "async B" }],
  });
  assert.equal(asyncParallel.mode, "parallel");
  assert.equal(asyncParallel.runIds.length, 2);
  assert.equal(new Set(asyncParallel.runIds).size, 2);
  assert.deepEqual(asyncParallel.results.map((item) => item.status), ["running", "running"]);
  for (const item of asyncParallel.results) {
    const waitedParallel = await waitForSubagent({ cwd, runId: item.runId, attemptId: item.attemptId, timeoutMs: 30000, pollIntervalMs: 100 });
    assert.equal(waitedParallel.status, "completed");
    assert.ok(["completed", "failed", "cancelled"].includes(waitedParallel.snapshot?.status ?? ""), "async parallel run should reach a terminal status");
  }

  const reconcileMissing = await reconcileSubagentRun({ cwd, runId: "run_missing_api_check" });
  assert.equal(reconcileMissing.status, "not-found");

  console.log(JSON.stringify({ name: "check-api", status: "completed" }, null, 2));
} finally {
  if (cwd !== undefined) await rm(cwd, { recursive: true, force: true });
}
