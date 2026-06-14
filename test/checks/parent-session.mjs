#!/usr/bin/env node
// Verifies parentSessionId is persisted into run.json by beginRunRecord and
// preserved across subsequent attempt upserts. This is the session-ownership
// signal pi-panel uses to scope footer subagent rows to the launching session.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beginRunRecord, upsertRunAttempt, runPaths } from "../../src/artifacts/index.ts";

const tempRoot = await mkdtemp(join(tmpdir(), "pi-subagent-parent-session-"));

try {
  const cwd = join(tempRoot, "workspace");
  await mkdir(cwd, { recursive: true });

  const runId = "run_parent_001";
  const attemptId = "attempt_parent_001";
  const parentSessionId = "session_abc123";

  await beginRunRecord({
    cwd,
    runId,
    mode: "single",
    backend: "headless",
    startedAt: "2026-06-15T00:00:00.000Z",
    dependency: null,
    parentSessionId,
    activeAttemptId: attemptId,
    attempts: [{ attemptId, status: "running", backend: "headless", startedAt: "2026-06-15T00:00:00.000Z" }],
  });

  const runJsonPath = runPaths({ cwd, runId }).runJsonPath;
  const afterBegin = JSON.parse(await readFile(runJsonPath, "utf8"));
  assert.equal(afterBegin.parentSessionId, parentSessionId, "parentSessionId should be written by beginRunRecord");

  // Subsequent attempt update (as durable workers / finishers do) must not drop it.
  await upsertRunAttempt({
    cwd,
    runId,
    attemptId,
    status: "completed",
    backend: "headless",
    completedAt: "2026-06-15T00:00:05.000Z",
  });

  const afterUpsert = JSON.parse(await readFile(runJsonPath, "utf8"));
  assert.equal(afterUpsert.parentSessionId, parentSessionId, "parentSessionId should survive upsertRunAttempt");
  assert.equal(afterUpsert.status, "completed");

  // A run begun WITHOUT a parentSessionId must omit the field (back-compat:
  // pre-patch records have no field; panel treats missing as unowned).
  const runId2 = "run_parent_002";
  await beginRunRecord({
    cwd,
    runId: runId2,
    mode: "single",
    backend: "headless",
    startedAt: "2026-06-15T00:00:00.000Z",
    dependency: null,
    activeAttemptId: "attempt_x",
    attempts: [{ attemptId: "attempt_x", status: "running", backend: "headless", startedAt: "2026-06-15T00:00:00.000Z" }],
  });
  const noParent = JSON.parse(await readFile(runPaths({ cwd, runId: runId2 }).runJsonPath, "utf8"));
  assert.equal("parentSessionId" in noParent, false, "records without a parent session must omit the field");

  console.log(JSON.stringify({ name: "check-parent-session", status: "completed", parentSessionId }, null, 2));
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
