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

console.log(JSON.stringify({ name: "check-resolver", status: "completed", cases: cases.length }, null, 2));
