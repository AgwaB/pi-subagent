#!/usr/bin/env node
import assert from "node:assert/strict";
import { createResultEnvelope } from "../../src/artifacts/index.ts";
import { validateResolveInput } from "../../src/core/validation.ts";
import { createRunStatusSnapshot, isTerminalStatus, statusFailedClosed, statusSucceeded } from "../../src/orchestrate/index.ts";

const plannedInput = {
  backend: "auto",
  agent: "typescript-expert",
  task: "inspect public contracts",
  roleContext: "read-only reviewer",
  agentScope: "project",
  confirmProjectAgents: true,
  mode: "parallel",
  tasks: [
    { agent: "typescript-expert", task: "review schemas", roleContext: "contract checker" },
    { agent: "contract-reader", task: "review schemas", timeoutMs: 1000 },
  ],
  concurrency: 2,
  asyncDependency: "needed-before-final",
  visible: false,
  sandbox: true,
  workspace: { mode: "auto", path: "." },
  worktree: true,
  worktreePolicy: "auto",
  cwd: process.cwd(),
  async: true,
  onComplete: "return",
  timeoutMs: 5000,
  model: "kimi-coding/kimi-for-coding",
  tools: ["read", "grep"],
  reasoningLevel: "xhigh",
};

const validation = validateResolveInput(plannedInput);
assert.equal(validation.ok, true);
assert.equal(validation.input.agent, plannedInput.agent);
assert.equal(validation.input.tasks.length, 2);
assert.equal(validation.input.concurrency, 2);
assert.equal(validation.input.asyncDependency, "needed-before-final");
assert.equal(validation.input.workspace.mode, "auto");
assert.equal(validation.input.model, "kimi-coding/kimi-for-coding");
assert.deepEqual(validation.input.tools, ["read", "grep"]);
assert.equal(validation.input.thinking, "xhigh");

const taskModelValidation = validateResolveInput({
  mode: "parallel",
  tasks: [{ agent: "scout", task: "audit", model: "kimi-coding/kimi-for-coding", thinking: "high", tools: [] }],
});
assert.equal(taskModelValidation.ok, true);
assert.equal(taskModelValidation.input.tasks[0].model, "kimi-coding/kimi-for-coding");
assert.equal(taskModelValidation.input.tasks[0].thinking, "high");
assert.deepEqual(taskModelValidation.input.tasks[0].tools, []);

const invalid = validateResolveInput({ mode: "fanout" });
assert.equal(invalid.ok, false);
assert.equal(invalid.failure.failureKind, "validation");
assert.match(invalid.failure.error, /unsupported mode/);

const chain = validateResolveInput({ chain: [{ task: "summarize findings" }] });
assert.equal(chain.ok, false);
assert.equal(chain.failure.failureKind, "validation");
assert.match(chain.failure.error, /chain mode is not supported/);

const result = createResultEnvelope({
  runId: "run_contracts_001",
  taskId: "task-1",
  backend: "headless",
  status: "failed",
  failureKind: "validation",
  cwd: process.cwd(),
  startedAt: "2026-06-07T00:00:00.000Z",
  completedAt: "2026-06-07T00:00:00.010Z",
  artifacts: [{ type: "result", path: ".pi/agent/runs/run_contracts_001/task-1/result.json" }],
});
const snapshot = createRunStatusSnapshot(result);
assert.equal(snapshot.runId, result.runId);
assert.equal(snapshot.resultPath, ".pi/agent/runs/run_contracts_001/task-1/result.json");
assert.equal(isTerminalStatus("failed"), true);
assert.equal(statusSucceeded("completed"), true);
assert.equal(statusFailedClosed("failed", "validation"), true);

console.log(
  JSON.stringify(
    {
      name: "check-contracts",
      status: "completed",
      plannedKeys: Object.keys(plannedInput).length,
      statusHelpers: 4,
    },
    null,
    2,
  ),
);
