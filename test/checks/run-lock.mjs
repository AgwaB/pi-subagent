#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	beginRunRecord,
	commitAttemptResultIfActive,
	createAttemptArtifactStore,
	readRunRecord,
	runPaths,
	updateAttemptProcess,
	upsertRunAttempt,
} from "../../src/artifacts/index.ts";

const tempRoot = await mkdtemp(join(tmpdir(), "pi-subagent-run-lock-"));
const properLockfile = createRequire(import.meta.url)("proper-lockfile");
try {
  // 1. Concurrent mutations serialize without losing updates.
  const cwd = join(tempRoot, "concurrent");
  await mkdir(cwd, { recursive: true });
  const runId = "run_lock_check";
  await beginRunRecord({ cwd, runId, mode: "single", backend: "headless" });
  const attempts = Array.from({ length: 12 }, (_, index) => `attempt-${String(index + 1).padStart(2, "0")}`);
  await Promise.all(attempts.map((attemptId) => upsertRunAttempt({ cwd, runId, attemptId, status: "running", backend: "headless", activate: false })));
  const record = await readRunRecord({ cwd, runId });
  assert.equal(record.attempts.length, attempts.length, "no attempt updates may be lost under concurrent mutation");
  assert.equal(record.activeAttemptId, null, "activate:false must preserve the active attempt id");
  assert.equal(record.latestAttemptId, null, "activate:false must preserve the latest attempt id");

  const staleAttemptId = attempts[0];
  const successorAttemptId = "attempt-successor";
  await upsertRunAttempt({
    cwd,
    runId,
    attemptId: successorAttemptId,
    status: "running",
    backend: "headless",
  });
  await updateAttemptProcess({
    cwd,
    runId,
    attemptId: staleAttemptId,
    process: { pid: 99999999 },
  });
  const staleWriteRecord = await readRunRecord({ cwd, runId });
  assert.equal(staleWriteRecord.activeAttemptId, successorAttemptId, "a stale onlyIfActive update must not reactivate its attempt");
  assert.equal(staleWriteRecord.attempts.find((attempt) => attempt.attemptId === staleAttemptId)?.process, undefined, "a stale onlyIfActive process update must be a no-op");
  const staleStore = await createAttemptArtifactStore({
    cwd,
    runId,
    attemptId: staleAttemptId,
  });
  const staleResult = await staleStore.writeResult({
    backend: "headless",
    status: "completed",
    failureKind: null,
    cwd,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    workspace: { mode: "shared", cwd, worktreePath: null },
    sandbox: { enabled: false },
    exitCode: 0,
    signal: null,
    artifacts: [],
    metadata: { contextLengthExceeded: false },
  });
  const staleCommit = await commitAttemptResultIfActive(
    { cwd, runId },
    staleResult,
  );
  assert.equal(staleCommit.committed, false, "a stale terminal result must not replace its successor");
  const afterStaleCommit = await readRunRecord({ cwd, runId });
  assert.equal(afterStaleCommit.activeAttemptId, successorAttemptId);
  assert.equal(afterStaleCommit.status, "running");
  const duplicateRunId = "run_atomic_duplicate";
  await beginRunRecord({
    cwd,
    runId: duplicateRunId,
    mode: "single",
    backend: "headless",
  });
  const duplicateReservations = await Promise.allSettled([
    upsertRunAttempt({
      cwd,
      runId: duplicateRunId,
      attemptId: "attempt_same",
      status: "pending",
      backend: "headless",
      createOnly: true,
    }),
    upsertRunAttempt({
      cwd,
      runId: duplicateRunId,
      attemptId: "attempt_same",
      status: "pending",
      backend: "headless",
      createOnly: true,
    }),
  ]);
  assert.equal(
    duplicateReservations.filter((reservation) => reservation.status === "fulfilled").length,
    1,
    "exactly one concurrent creator may reserve an attempt id",
  );
  assert.equal(
    duplicateReservations.filter((reservation) => reservation.status === "rejected").length,
    1,
  );

  // 2. Elapsed wall time alone never steals an atomic lock directory.
  const staleCwd = join(tempRoot, "stale");
  const staleRunId = "run_lock_stale";
  const staleLockPath = runPaths({ cwd: staleCwd, runId: staleRunId }).lockPath;
  await mkdir(dirname(staleLockPath), { recursive: true });
  await mkdir(staleLockPath);
  const staleTime = new Date(Date.now() - 60_000);
  await utimes(staleLockPath, staleTime, staleTime);
  await assert.rejects(
    beginRunRecord({ cwd: staleCwd, runId: staleRunId, mode: "single", backend: "headless" }),
    /Lock file is already being held/,
    "an old lock must fail closed instead of stealing from a possibly paused writer",
  );
  await rm(staleLockPath, { recursive: true, force: true });
  await beginRunRecord({ cwd: staleCwd, runId: staleRunId, mode: "single", backend: "headless" });
  assert.ok(await readRunRecord({ cwd: staleCwd, runId: staleRunId }), "mutation proceeds after explicit stale-lock recovery");

  // 3. A lock held by a live owner is never stolen; the waiter times out.
  const liveCwd = join(tempRoot, "live");
  const liveRunId = "run_lock_live";
  const liveLockPath = runPaths({ cwd: liveCwd, runId: liveRunId }).lockPath;
  await mkdir(dirname(liveLockPath), { recursive: true });
  const releaseLiveLock = await properLockfile.lock(liveLockPath, {
    realpath: false,
    lockfilePath: liveLockPath,
    stale: 10_000,
    update: 5_000,
  });
  try {
    await assert.rejects(
      beginRunRecord({ cwd: liveCwd, runId: liveRunId, mode: "single", backend: "headless" }),
      /Lock file is already being held/,
      "live-holder lock must not be stolen",
    );
  } finally {
    await releaseLiveLock();
  }

  console.log(JSON.stringify({ name: "check-run-lock", status: "completed" }, null, 2));
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
