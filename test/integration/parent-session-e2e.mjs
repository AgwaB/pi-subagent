#!/usr/bin/env node
// End-to-end: runSubagentTask (the path execute() uses for a single sync run)
// must forward input.parentSessionId all the way into run.json. Skips when the
// inline model/auth path is unavailable, like the other integration checks.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSubagentTask } from "../../src/orchestrate/run.ts";
import { runPaths } from "../../src/artifacts/index.ts";

const tempRoot = await mkdtemp(join(tmpdir(), "pi-subagent-parent-e2e-"));
try {
  const cwd = join(tempRoot, "workspace");
  await mkdir(cwd, { recursive: true });

  const parentSessionId = "session_e2e_999";
  const runId = "run_parent_e2e";

  const result = await runSubagentTask({
    cwd,
    runId,
    input: {
      backend: "inline",
      agent: "check-inline-worker",
      roleContext: "Return only the requested marker. Do not use tools.",
      task: "Reply exactly: parent-session-ok",
      timeoutMs: 60_000,
      parentSessionId,
    },
  });

  // Regardless of model availability, beginRunRecord ran before execution, so
  // run.json must already carry parentSessionId.
  const runJsonPath = runPaths({ cwd, runId }).runJsonPath;
  const record = JSON.parse(await readFile(runJsonPath, "utf8"));
  assert.equal(record.parentSessionId, parentSessionId, "run.json must carry parentSessionId from input");

  const modelUnavailable = result.status !== "completed" && ["model", "spawn", "timeout"].includes(result.failureKind);
  console.log(
    JSON.stringify(
      {
        name: "check-parent-session-e2e",
        status: modelUnavailable ? "completed-record-only" : "completed",
        runId,
        parentSessionId: record.parentSessionId,
        runStatus: result.status,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
