#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createAttemptArtifactStore } from "../../src/artifacts/index.ts";
import { finalizeWorktreeResult, resolveWorkspace } from "../../src/workspace/worktree.ts";

const execFileAsync = promisify(execFile);

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function createRepo(root) {
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  await execFileAsync("git", ["init"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "base\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repo });
  await execFileAsync("git", ["-c", "user.name=Pi Check", "-c", "user.email=pi-check@example.invalid", "commit", "-m", "init"], { cwd: repo });
  return repo;
}

async function syntheticResult(cwd, runId, attemptId, status, workspace) {
  const store = await createAttemptArtifactStore({ cwd, runId, attemptId });
  const artifacts = [
    await store.writeTextArtifact("stdout", ""),
    await store.writeTextArtifact("stderr", ""),
    await store.writeTextArtifact("output", "synthetic\n"),
  ];
  return await store.writeResult({
    backend: "headless",
    status,
    failureKind: status === "completed" ? null : "model",
    cwd,
    startedAt: new Date(Date.now() - 1000),
    completedAt: new Date(),
    workspace,
    sandbox: { enabled: false },
    exitCode: status === "completed" ? 0 : null,
    signal: null,
    artifacts,
    metadata: { contextLengthExceeded: false },
  });
}

const tempRoot = await mkdtemp(join(tmpdir(), "pi-subagent-worktree-cleanup-"));
try {
  const repo = await createRepo(tempRoot);

  const completedWorkspace = await resolveWorkspace({ cwd: repo, input: { worktree: true }, mode: "single", runId: "run_check_worktree_removed", taskIndex: 0 });
  await writeFile(join(completedWorkspace.cwd, "README.md"), "base\ncompleted change\n");
  await writeFile(join(completedWorkspace.cwd, "new-file.txt"), "new content\n");
  // Pi runtime state written by the child session inside the worktree must not
  // appear as task output.
  await mkdir(join(completedWorkspace.cwd, ".pi", "agent", "runs", "run_nested", "attempts", "a1"), { recursive: true });
  await writeFile(join(completedWorkspace.cwd, ".pi", "agent", "runs", "run_nested", "run.json"), "{}\n");
  await mkdir(join(completedWorkspace.cwd, ".pi", "workflows"), { recursive: true });
  await writeFile(join(completedWorkspace.cwd, ".pi", "workflows", "index.json"), "{}\n");
  await writeFile(join(completedWorkspace.cwd, ".pi", "workflows", "my-spec.json"), "{\"name\":\"kept\"}\n");
  const completed = await syntheticResult(repo, "run_check_worktree_removed", "attempt-1", "completed", {
    mode: completedWorkspace.mode,
    cwd: completedWorkspace.baseCwd,
    worktreePath: completedWorkspace.worktreePath,
  });
  const finalizedCompleted = await finalizeWorktreeResult(completedWorkspace, completed);
  assert.equal(finalizedCompleted.workspace.worktreeCleanupStatus, "removed");
  assert.equal(await pathExists(completedWorkspace.worktreePath), false, "completed worktree should be removed");
  assert.ok(finalizedCompleted.workspace.worktreeStatusPath);
  assert.ok(finalizedCompleted.workspace.worktreeDiffPath);
  const completedDiff = await readFile(join(repo, finalizedCompleted.workspace.worktreeDiffPath), "utf8");
  assert.match(completedDiff, /completed change/);
  assert.match(completedDiff, /new-file\.txt/);
  assert.match(completedDiff, /my-spec\.json/, "user files under .pi/workflows stay in the diff");
  assert.doesNotMatch(completedDiff, /\.pi\/agent\/runs/, "nested run state is excluded from the diff");
  assert.doesNotMatch(completedDiff, /index\.json/, "workflow index is excluded from the diff");
  const completedStatus = await readFile(join(repo, finalizedCompleted.workspace.worktreeStatusPath), "utf8");
  assert.match(completedStatus, /new-file\.txt/);
  assert.doesNotMatch(completedStatus, /\.pi\/agent\/runs|index\.json/);

  const failedWorkspace = await resolveWorkspace({ cwd: repo, input: { worktree: true }, mode: "single", runId: "run_check_worktree_kept", taskIndex: 1 });
  await writeFile(join(failedWorkspace.cwd, "README.md"), "base\nfailed change\n");
  const failed = await syntheticResult(repo, "run_check_worktree_kept", "attempt-1", "failed", {
    mode: failedWorkspace.mode,
    cwd: failedWorkspace.baseCwd,
    worktreePath: failedWorkspace.worktreePath,
  });
  const finalizedFailed = await finalizeWorktreeResult(failedWorkspace, failed);
  assert.equal(finalizedFailed.workspace.worktreeCleanupStatus, "kept");
  assert.equal(await pathExists(failedWorkspace.worktreePath), true, "failed worktree should be kept");

  console.log(JSON.stringify({ name: "check-worktree-cleanup", status: "completed" }, null, 2));
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
