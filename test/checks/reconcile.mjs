#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { beginRunRecord, createAttemptArtifactStore } from "../../src/artifacts/index.ts";
import { reconcileSubagentRun } from "../../src/orchestrate/reconcile.ts";
import { getSubagentStatus, waitForSubagent } from "../../api.mjs";

const execFileAsync = promisify(execFile);
const tempRoot = await mkdtemp(join(tmpdir(), "pi-subagent-reconcile-"));

async function createRunningAttempt(cwd, runId, attemptId, options = {}) {
  await mkdir(cwd, { recursive: true });
  const store = await createAttemptArtifactStore({ cwd, runId, attemptId });
  const startedAt = options.startedAt ?? new Date(Date.now() - 60_000).toISOString();
  const result = await store.writeResult({
    backend: options.backend ?? "inline",
    status: "running",
    failureKind: null,
    cwd,
    startedAt,
    completedAt: null,
    workspace: { mode: "shared", cwd, worktreePath: null },
    sandbox: { enabled: false },
    exitCode: null,
    signal: null,
    artifacts: [],
    metadata: { contextLengthExceeded: false },
  });
  const resultPath = result.artifacts.find((artifact) => artifact.type === "result")?.path;
  await beginRunRecord({
    cwd,
    runId,
    mode: "single",
    backend: options.backend ?? "inline",
    startedAt,
    activeAttemptId: attemptId,
    attempts: [
      {
        attemptId,
        status: "running",
        backend: options.backend ?? "inline",
        startedAt,
        artifactCwd: cwd,
        resultPath,
        process: options.process,
        heartbeatAt: options.heartbeatAt,
      },
    ],
  });
  return result;
}

try {
  const apiUrl = pathToFileURL(resolve("api.mjs")).href;

  const parentDeathCwd = join(tempRoot, "parent-death");
  await mkdir(parentDeathCwd, { recursive: true });
  const launcher = `
    const { runSubagent } = await import(process.env.API_URL);
    const run = await runSubagent({ cwd: process.env.RUN_CWD, backend: "inline", task: "Reply with PARENT_DEATH_OK.", async: true });
    console.log(JSON.stringify({ runId: run.runId, attemptId: run.attemptId }));
  `;
  const launched = await execFileAsync(process.execPath, ["--input-type=module", "-e", launcher], {
    cwd: resolve("."),
    env: { ...process.env, API_URL: apiUrl, RUN_CWD: parentDeathCwd, PI_SUBAGENT_HEARTBEAT_MS: "50" },
  });
  const launchedRef = JSON.parse(launched.stdout.trim());
  const waited = await waitForSubagent({ cwd: parentDeathCwd, runId: launchedRef.runId, attemptId: launchedRef.attemptId, timeoutMs: 15_000, pollIntervalMs: 100 });
  assert.equal(waited.status, "completed", "detached durable worker should finalize after launcher exits");
  assert.ok(["completed", "failed", "cancelled"].includes(waited.snapshot?.status ?? ""), "detached durable worker should reach a terminal run status");
  const parentDeathStatus = await getSubagentStatus({ cwd: parentDeathCwd, runId: launchedRef.runId, attemptId: launchedRef.attemptId });
  assert.equal(typeof parentDeathStatus?.attempts?.[0]?.workerPid, "number", "durable worker pid should be recorded");
  await access(join(parentDeathCwd, ".pi/agent/runs", launchedRef.runId, "attempts", launchedRef.attemptId, "worker.log"));

  const staleCwd = join(tempRoot, "stale");
  await createRunningAttempt(staleCwd, "run_reconcile_stale", "attempt_stale", {
    process: { pid: 99999999 },
    heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const stale = await reconcileSubagentRun({ cwd: staleCwd, runId: "run_reconcile_stale", staleAfterMs: 1 });
  assert.equal(stale.status, "marked-stale");
  assert.equal(stale.record?.status, "failed");
  assert.equal(stale.record?.failureKind, "stale");

  const liveCwd = join(tempRoot, "live-worker");
  await createRunningAttempt(liveCwd, "run_reconcile_live", "attempt_live", {
    process: { pid: 99999999, workerPid: process.pid },
    heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const live = await reconcileSubagentRun({ cwd: liveCwd, runId: "run_reconcile_live", staleAfterMs: 1 });
  assert.equal(live.status, "running", "live worker pid should keep attempt running");

  const heartbeatCwd = join(tempRoot, "fresh-heartbeat");
  await createRunningAttempt(heartbeatCwd, "run_reconcile_heartbeat", "attempt_heartbeat", {
    process: { pid: 99999999 },
    heartbeatAt: new Date().toISOString(),
  });
  const heartbeat = await reconcileSubagentRun({ cwd: heartbeatCwd, runId: "run_reconcile_heartbeat", staleAfterMs: 30_000 });
  assert.equal(heartbeat.status, "running", "fresh heartbeat should keep attempt running");

  console.log(JSON.stringify({ name: "check-reconcile", status: "completed" }, null, 2));
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
