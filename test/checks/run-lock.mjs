#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginRunRecord, readRunRecord, upsertRunAttempt } from "../../src/artifacts/index.ts";

const tempRoot = await mkdtemp(join(tmpdir(), "pi-subagent-run-lock-"));
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

  // 2. A stale lock (dead holder pid) is reclaimed.
  const staleCwd = join(tempRoot, "stale");
  const staleRunId = "run_lock_stale";
  const staleLockDir = join(staleCwd, ".pi/agent/runs", staleRunId);
  await mkdir(staleLockDir, { recursive: true });
  // Spawn a child that exits immediately so its pid is provably dead.
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const deadPid = child.pid;
  await new Promise((resolveExit) => child.on("exit", resolveExit));
  await writeFile(join(staleLockDir, "run.lock"), `${deadPid}\n${new Date().toISOString()}\n`);
  const reclaimStart = Date.now();
  await beginRunRecord({ cwd: staleCwd, runId: staleRunId, mode: "single", backend: "headless" });
  assert.ok(Date.now() - reclaimStart < 2_000, "stale lock with a dead holder must be reclaimed quickly");
  assert.ok(await readRunRecord({ cwd: staleCwd, runId: staleRunId }), "mutation proceeds after reclaiming a stale lock");

  // 3. A lock held by a live process is never stolen; the waiter times out.
  const liveCwd = join(tempRoot, "live");
  const liveRunId = "run_lock_live";
  const liveLockDir = join(liveCwd, ".pi/agent/runs", liveRunId);
  await mkdir(liveLockDir, { recursive: true });
  const liveLockPath = join(liveLockDir, "run.lock");
  await writeFile(liveLockPath, `${process.pid}\n${new Date().toISOString()}\n`);
  await assert.rejects(
    beginRunRecord({ cwd: liveCwd, runId: liveRunId, mode: "single", backend: "headless" }),
    /timed out waiting for run lock/,
    "live-holder lock must not be stolen",
  );
  assert.equal((await readFile(liveLockPath, "utf8")).split("\n")[0], String(process.pid), "live lock file must remain intact after a timed-out waiter");

  // 4. Unreadable lock content falls back to mtime: old file is reclaimed.
  const mtimeCwd = join(tempRoot, "mtime");
  const mtimeRunId = "run_lock_mtime";
  const mtimeLockDir = join(mtimeCwd, ".pi/agent/runs", mtimeRunId);
  await mkdir(mtimeLockDir, { recursive: true });
  const mtimeLockPath = join(mtimeLockDir, "run.lock");
  await writeFile(mtimeLockPath, "not-a-pid\n");
  const old = new Date(Date.now() - 60_000);
  await utimes(mtimeLockPath, old, old);
  await beginRunRecord({ cwd: mtimeCwd, runId: mtimeRunId, mode: "single", backend: "headless" });
  assert.ok(await readRunRecord({ cwd: mtimeCwd, runId: mtimeRunId }), "old unreadable lock is reclaimed via mtime heuristic");

  console.log(JSON.stringify({ name: "check-run-lock", status: "completed" }, null, 2));
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
