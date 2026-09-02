#!/usr/bin/env node
import assert from "node:assert/strict";
import { BACKENDS, FAILURE_KINDS, STATUSES } from "../../src/core/constants.ts";
import { resolveBackend } from "../../src/core/resolver.ts";

assert.deepEqual([...BACKENDS], ["inline", "headless", "tmux", "auto"]);
assert.ok(STATUSES.includes("completed"));
assert.ok(FAILURE_KINDS.includes("validation"));

const cases = [
  {
    name: "omitted backend auto-selects inline for normal model runs",
    input: { agent: "worker", task: "inspect" },
    expected: { backend: "inline", status: "completed" },
  },
  {
    name: "omitted backend with sandbox resolves to headless",
    input: { sandbox: true, agent: "worker", task: "inspect" },
    expected: { backend: "headless", status: "completed" },
  },
  {
    name: "auto with visible sandbox resolves to tmux",
    input: { backend: "auto", sandbox: true, visible: true, agent: "worker", task: "inspect" },
    expected: { backend: "tmux", status: "completed" },
  },
  {
    name: "explicit tmux with sandbox resolves to tmux",
    input: { backend: "tmux", sandbox: true, agent: "worker", task: "inspect" },
    expected: { backend: "tmux", status: "completed" },
  },
  {
    name: "explicit headless with visible fails closed",
    input: { backend: "headless", visible: true, agent: "worker", task: "inspect" },
    expected: { backend: "headless", status: "failed", failureKind: "validation" },
    errorIncludes: "visible execution requires backend",
  },
  {
    name: "inline with sandbox fails validation",
    input: { backend: "inline", sandbox: true, agent: "worker", task: "inspect" },
    expected: { backend: "inline", status: "failed", failureKind: "validation" },
    errorIncludes: "inline backend cannot provide",
  },
  {
    name: "unknown backend fails validation",
    input: { backend: "future" },
    expected: { status: "failed", failureKind: "validation" },
    errorIncludes: "unsupported backend",
  },
  {
    name: "auto with worktree:true resolves to headless (inline cannot isolate)",
    input: { worktree: true, agent: "worker", task: "inspect" },
    expected: { backend: "headless", status: "completed" },
  },
  {
    name: "auto with workspace mode worktree resolves to headless",
    input: { workspace: { mode: "worktree" }, agent: "worker", task: "inspect" },
    expected: { backend: "headless", status: "completed" },
  },
  {
    name: "auto with worktreePolicy required resolves to headless",
    input: { worktreePolicy: "required", agent: "worker", task: "inspect" },
    expected: { backend: "headless", status: "completed" },
  },
  {
    name: "auto with a cwd outside the process cwd resolves to headless",
    input: { cwd: process.cwd() === "/" ? "/tmp" : "/", agent: "worker", task: "inspect" },
    expected: { backend: "headless", status: "completed" },
  },
  {
    name: "auto with the process cwd stays inline",
    input: { cwd: process.cwd(), agent: "worker", task: "inspect" },
    expected: { backend: "inline", status: "completed" },
  },
  {
    name: "auto with worktreePolicy never stays inline",
    input: { worktreePolicy: "never", agent: "worker", task: "inspect" },
    expected: { backend: "inline", status: "completed" },
  },
  {
    name: "explicit inline with worktree:true fails closed",
    input: { backend: "inline", worktree: true, agent: "worker", task: "inspect" },
    expected: { backend: "inline", status: "failed", failureKind: "validation" },
    errorIncludes: "inline execution cannot isolate a worktree",
  },
  {
    name: "explicit inline with a different cwd stays inline",
    input: { backend: "inline", cwd: process.cwd() === "/" ? "/tmp" : "/", agent: "worker", task: "inspect" },
    expected: { backend: "inline", status: "completed" },
  },
  {
    name: "explicit headless with worktree stays headless",
    input: { backend: "headless", worktree: true, agent: "worker", task: "inspect" },
    expected: { backend: "headless", status: "completed" },
  },
];

for (const testCase of cases) {
  const actual = resolveBackend(testCase.input);
  for (const [key, value] of Object.entries(testCase.expected)) {
    assert.deepEqual(actual[key], value, `${testCase.name}: ${key}`);
  }
  if (testCase.errorIncludes) {
    assert.ok((actual.error ?? "").includes(testCase.errorIncludes), testCase.name);
  }
}

// Through the tool, the extension context's cwd is the effective cwd even when
// the model omits the `cwd` argument: a foreign context cwd must route away
// from inline exactly like an explicit foreign `cwd` does.
{
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
  const mod = await jiti.import(resolve("src/index.ts"));
  let registeredTool;
  (mod.default ?? mod)({ registerCommand() {}, registerTool(tool) { registeredTool = tool; } });
  const foreignCwd = await mkdtemp(join(tmpdir(), "pi-subagent-foreign-ctx-cwd-"));
  try {
    assert.notEqual(resolve(foreignCwd), resolve(process.cwd()));
    // Provider-free: a validation failure after backend resolution still reports the resolved backend.
    const foreign = await registeredTool.execute(
      "resolver-foreign-ctx",
      { agent: "worker", task: "inspect", tools: ["definitely-not-a-tool"], model: "pi-subagent-missing/provider" },
      new AbortController().signal,
      () => undefined,
      { cwd: foreignCwd },
    );
    assert.equal(foreign.details?.resolved?.backend, "headless", `foreign ctx.cwd without an explicit cwd must not resolve inline: ${JSON.stringify(foreign.details?.resolved)}`);
    const local = await registeredTool.execute(
      "resolver-local-ctx",
      { agent: "worker", task: "inspect", tools: ["definitely-not-a-tool"], model: "pi-subagent-missing/provider" },
      new AbortController().signal,
      () => undefined,
      { cwd: process.cwd() },
    );
    assert.equal(local.details?.resolved?.backend, "inline", "a context cwd equal to the process cwd keeps the inline default");
  } finally {
    await rm(foreignCwd, { recursive: true, force: true });
  }
}

console.log(JSON.stringify({ name: "check-resolver", status: "completed", cases: cases.length }, null, 2));
