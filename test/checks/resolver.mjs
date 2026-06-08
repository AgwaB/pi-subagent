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
