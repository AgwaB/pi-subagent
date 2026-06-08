import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import {
  getSubagentLogs,
  getSubagentStatus,
  interruptSubagent,
  runSubagent,
  SubagentValidationError,
  waitForSubagent,
} from "../../src/api.ts";
import { createTaskArtifactStore } from "../../src/artifacts/index.ts";

assert.equal(pkg.exports["./api"].default, "./api.mjs");
assert.equal(pkg.exports["./api"].types, "./src/api.ts");
assert.equal(typeof runSubagent, "function");
assert.equal(typeof getSubagentStatus, "function");
assert.equal(typeof getSubagentLogs, "function");
assert.equal(typeof waitForSubagent, "function");
assert.equal(typeof interruptSubagent, "function");

await assert.rejects(
  () => runSubagent({ backend: "inline" }),
  (error) => error instanceof SubagentValidationError && error.failureKind === "validation" && /agent\/task input/.test(error.message),
);

const cwd = await mkdtemp(join(tmpdir(), "pi-subagent-api-check-"));
const runId = "run_api_check";
const taskId = "task-1";
const store = await createTaskArtifactStore({ cwd, runId, taskId });
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
});

const status = await getSubagentStatus({ cwd, runId, taskId });
assert.equal(status?.status, "completed");
assert.equal(status?.runId, runId);
assert.equal(status?.taskId, taskId);
assert.equal(status?.resultPath, result.artifacts.find((artifact) => artifact.type === "result")?.path);

const logs = await getSubagentLogs({ cwd, runId, taskId });
assert.equal(logs?.logText.output, "api-ok\n");

const waited = await waitForSubagent({ cwd, runId, taskId, timeoutMs: 100, pollIntervalMs: 10 });
assert.equal(waited.status, "completed");
assert.equal(waited.snapshot?.status, "completed");

const missingInterrupt = await interruptSubagent({ cwd, runId: "run_missing_api_check" });
assert.equal(missingInterrupt.status, "not-found");

assert.match(await readFile(join(cwd, ".pi/agent/runs", runId, taskId, "output.log"), "utf8"), /api-ok/);
console.log(JSON.stringify({ name: "check-api", status: "completed" }, null, 2));
