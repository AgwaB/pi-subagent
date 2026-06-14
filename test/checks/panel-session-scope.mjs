#!/usr/bin/env node
// Cross-component contract test: the engine writes parentSessionId into run.json,
// and pi-panel scopes its footer to runs whose parentSessionId matches the
// reading session. This reproduces the reported bug (session A's run leaking
// into session B's footer) against REAL engine-written records and asserts the
// panel's ownership predicate isolates them. Mirrors panel index.ts predicates;
// if the writer field name drifts from the reader, this fails.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginRunRecord, runPaths } from "../../src/artifacts/index.ts";

// ---- panel-side logic copied verbatim from extensions/pi-panel/index.ts ----
function parseParentSessionId(record) {
  return typeof record?.parentSessionId === "string" && record.parentSessionId.length > 0 ? record.parentSessionId : undefined;
}
function ownedByCurrentSession(run, currentSessionId) {
  if (currentSessionId === undefined) return true;
  if (run.parentSessionId === undefined) return true;
  return run.parentSessionId === currentSessionId;
}
// ---------------------------------------------------------------------------

const tempRoot = await mkdtemp(join(tmpdir(), "pi-subagent-panel-scope-"));
try {
  const cwd = join(tempRoot, "workspace"); // shared cwd => shared runs dir
  await mkdir(cwd, { recursive: true });

  const sessionA = "session_A";
  const sessionB = "session_B";

  async function writeRun(runId, parentSessionId) {
    await beginRunRecord({
      cwd,
      runId,
      mode: "single",
      backend: "headless",
      ...(parentSessionId ? { parentSessionId } : {}),
      activeAttemptId: "a1",
      attempts: [{ attemptId: "a1", status: "running", backend: "headless", startedAt: new Date().toISOString() }],
    });
    const record = JSON.parse(await readFile(runPaths({ cwd, runId }).runJsonPath, "utf8"));
    return { runId, parentSessionId: parseParentSessionId(record) };
  }

  const runA = await writeRun("run_from_A", sessionA);
  const runB = await writeRun("run_from_B", sessionB);
  const runLegacy = await writeRun("run_legacy", undefined); // pre-patch style

  const all = [runA, runB, runLegacy];

  const visibleToA = all.filter((r) => ownedByCurrentSession(r, sessionA)).map((r) => r.runId);
  const visibleToB = all.filter((r) => ownedByCurrentSession(r, sessionB)).map((r) => r.runId);

  // The bug: B used to see run_from_A. Now it must not.
  assert.deepEqual(visibleToA.sort(), ["run_from_A", "run_legacy"], "session A sees its own run + legacy, not B's");
  assert.deepEqual(visibleToB.sort(), ["run_from_B", "run_legacy"], "session B sees its own run + legacy, not A's");
  assert.equal(visibleToB.includes("run_from_A"), false, "REGRESSION: session A's run leaked into session B");

  // Fail-open when reader cannot determine its own session id.
  const visibleUnknown = all.filter((r) => ownedByCurrentSession(r, undefined)).map((r) => r.runId);
  assert.equal(visibleUnknown.length, 3, "unknown reader session sees all runs (fail-open)");

  console.log(JSON.stringify({ name: "check-panel-session-scope", status: "completed", visibleToA, visibleToB }, null, 2));
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
