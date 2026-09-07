#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createAttemptArtifactStore } from "../../src/artifacts/index.ts";
import {
  finalizeWorktreeResult,
  resolveWorkspace,
} from "../../src/workspace/worktree.ts";

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
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Pi Check",
      "-c",
      "user.email=pi-check@example.invalid",
      "commit",
      "-m",
      "init",
    ],
    { cwd: repo },
  );
  return repo;
}

async function syntheticResult(
  cwd,
  runId,
  attemptId,
  status,
  workspace,
  runsDir,
) {
  const store = await createAttemptArtifactStore({
    cwd,
    runId,
    attemptId,
    runsDir,
  });
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

  const completedWorkspace = await resolveWorkspace({
    cwd: repo,
    input: { worktree: true },
    mode: "single",
    runId: "run_check_worktree_removed",
    taskIndex: 0,
  });
  await writeFile(
    join(completedWorkspace.cwd, "README.md"),
    "base\nstaged change\n",
  );
  await execFileAsync("git", ["add", "README.md"], {
    cwd: completedWorkspace.cwd,
  });
  await writeFile(
    join(completedWorkspace.cwd, "README.md"),
    "base\nstaged change\nmixed unstaged change\n",
  );
  await writeFile(
    join(completedWorkspace.cwd, "new-file.txt"),
    "new content\n",
  );
  await writeFile(
    join(completedWorkspace.cwd, "staged-only.txt"),
    "STAGED_ONLY_MARKER\n",
  );
  const binary = Buffer.from([0, 255, 128, 0, 1, 2, 3]);
  await writeFile(join(completedWorkspace.cwd, "bytes.bin"), binary);
  await execFileAsync("git", ["add", "staged-only.txt", "bytes.bin"], {
    cwd: completedWorkspace.cwd,
  });
  const largeText = `${"large line\n".repeat(110_000)}FULL-PATCH-TAIL\n`;
  await writeFile(join(completedWorkspace.cwd, "large.txt"), largeText);
  // Pi runtime state written by the child session inside the worktree must not
  // appear as task output.
  await mkdir(
    join(
      completedWorkspace.cwd,
      ".pi",
      "agent",
      "runs",
      "run_nested",
      "attempts",
      "a1",
    ),
    { recursive: true },
  );
  await writeFile(
    join(
      completedWorkspace.cwd,
      ".pi",
      "agent",
      "runs",
      "run_nested",
      "run.json",
    ),
    "{}\n",
  );
  await mkdir(join(completedWorkspace.cwd, ".pi", "workflows"), {
    recursive: true,
  });
  await writeFile(
    join(completedWorkspace.cwd, ".pi", "workflows", "index.json"),
    "{}\n",
  );
  await writeFile(
    join(completedWorkspace.cwd, ".pi", "workflows", "my-spec.json"),
    '{"name":"kept"}\n',
  );
  const completed = await syntheticResult(
    repo,
    "run_check_worktree_removed",
    "attempt-1",
    "completed",
    {
      mode: completedWorkspace.mode,
      cwd: completedWorkspace.baseCwd,
      worktreePath: completedWorkspace.worktreePath,
    },
  );
  const finalizedCompleted = await finalizeWorktreeResult(
    completedWorkspace,
    completed,
  );
  assert.equal(finalizedCompleted.workspace.worktreeCleanupStatus, "removed");
  assert.equal(
    await pathExists(completedWorkspace.worktreePath),
    false,
    "completed worktree should be removed",
  );
  assert.ok(finalizedCompleted.workspace.worktreeStatusPath);
  assert.ok(finalizedCompleted.workspace.worktreeDiffPath);
  const completedDiff = await readFile(
    join(repo, finalizedCompleted.workspace.worktreeDiffPath),
    "utf8",
  );
  assert.match(completedDiff, /staged change/);
  assert.match(completedDiff, /mixed unstaged change/);
  assert.match(completedDiff, /new-file\.txt/);
  assert.match(
    completedDiff,
    /STAGED_ONLY_MARKER/,
    "staged-only content is preserved",
  );
  assert.match(
    completedDiff,
    /GIT binary patch/,
    "staged binary content is preserved",
  );
  assert.match(
    completedDiff,
    /FULL-PATCH-TAIL/,
    "large patches are captured through their tail",
  );
  const diffRef = finalizedCompleted.artifacts.find(
    (artifact) => artifact.type === "worktree-diff",
  );
  assert.equal(
    diffRef.bytes,
    Buffer.byteLength(completedDiff),
    "artifact size counts the complete file exactly once",
  );
  assert.ok(diffRef.bytes > 1024 * 1024);
  const verificationRepo = join(tempRoot, "verify-patch");
  await execFileAsync("git", [
    "clone",
    "--no-hardlinks",
    repo,
    verificationRepo,
  ]);
  const patchPath = join(repo, diffRef.path);
  await execFileAsync("git", ["apply", "--check", patchPath], {
    cwd: verificationRepo,
  });
  await execFileAsync("git", ["apply", patchPath], { cwd: verificationRepo });
  assert.equal(
    await readFile(join(verificationRepo, "README.md"), "utf8"),
    "base\nstaged change\nmixed unstaged change\n",
  );
  assert.equal(
    await readFile(join(verificationRepo, "staged-only.txt"), "utf8"),
    "STAGED_ONLY_MARKER\n",
  );
  assert.equal(
    await readFile(join(verificationRepo, "large.txt"), "utf8"),
    largeText,
  );
  assert.deepEqual(await readFile(join(verificationRepo, "bytes.bin")), binary);
  assert.match(
    completedDiff,
    /my-spec\.json/,
    "user files under .pi/workflows stay in the diff",
  );
  assert.doesNotMatch(
    completedDiff,
    /\.pi\/agent\/runs/,
    "nested run state is excluded from the diff",
  );
  assert.doesNotMatch(
    completedDiff,
    /index\.json/,
    "workflow index is excluded from the diff",
  );
  const completedStatus = await readFile(
    join(repo, finalizedCompleted.workspace.worktreeStatusPath),
    "utf8",
  );
  assert.match(completedStatus, /new-file\.txt/);
  assert.doesNotMatch(completedStatus, /\.pi\/agent\/runs|index\.json/);

  const customRunsDir = ".custom-runs";
  const customWorkspace = await resolveWorkspace({
    cwd: repo,
    input: { worktree: true },
    mode: "single",
    runId: "run_check_worktree_custom",
    taskIndex: 1,
  });
  await writeFile(join(customWorkspace.cwd, "custom.txt"), "custom\n");
  const custom = await syntheticResult(
    repo,
    "run_check_worktree_custom",
    "attempt-1",
    "completed",
    {
      mode: customWorkspace.mode,
      cwd: customWorkspace.baseCwd,
      worktreePath: customWorkspace.worktreePath,
    },
  );
  const finalizedCustom = await finalizeWorktreeResult(customWorkspace, custom);
  assert.match(
    finalizedCustom.artifacts.find((artifact) => artifact.type === "result")
      .path,
    /^\.pi\//,
  );
  // The caller-provided root must be passed through all finalize stores.
  const customRootWorkspace = await resolveWorkspace({
    cwd: repo,
    input: { worktree: true },
    mode: "single",
    runId: "run_check_worktree_custom_root",
    taskIndex: 2,
  });
  await writeFile(
    join(customRootWorkspace.cwd, "custom-root.txt"),
    "custom root\n",
  );
  const customRootResult = await syntheticResult(
    repo,
    "run_check_worktree_custom_root",
    "attempt-1",
    "completed",
    {
      mode: "worktree",
      cwd: repo,
      worktreePath: customRootWorkspace.worktreePath,
    },
    customRunsDir,
  );
  const finalizedCustomRoot = await finalizeWorktreeResult(
    customRootWorkspace,
    customRootResult,
    customRunsDir,
  );
  const resultRefs = finalizedCustomRoot.artifacts.filter(
    (artifact) => artifact.type === "result",
  );
  assert.equal(resultRefs.length, 1);
  for (const artifact of finalizedCustomRoot.artifacts)
    assert.match(artifact.path, /^\.custom-runs\//);
  const canonical = JSON.parse(
    await readFile(join(repo, resultRefs[0].path), "utf8"),
  );
  assert.deepEqual(
    canonical,
    finalizedCustomRoot,
    "canonical result includes final cleanup metadata",
  );
  assert.equal(canonical.workspace.worktreeCleanupStatus, "removed");
  assert.equal(
    await pathExists(
      join(repo, ".pi", "agent", "runs", "run_check_worktree_custom_root"),
    ),
    false,
  );

  const failedWorkspace = await resolveWorkspace({
    cwd: repo,
    input: { worktree: true },
    mode: "single",
    runId: "run_check_worktree_kept",
    taskIndex: 3,
  });
  await writeFile(
    join(failedWorkspace.cwd, "README.md"),
    "base\nfailed change\n",
  );
  const failed = await syntheticResult(
    repo,
    "run_check_worktree_kept",
    "attempt-1",
    "failed",
    {
      mode: failedWorkspace.mode,
      cwd: failedWorkspace.baseCwd,
      worktreePath: failedWorkspace.worktreePath,
    },
  );
  const finalizedFailed = await finalizeWorktreeResult(failedWorkspace, failed);
  assert.equal(finalizedFailed.workspace.worktreeCleanupStatus, "kept");
  assert.equal(
    await pathExists(failedWorkspace.worktreePath),
    true,
    "failed worktree should be kept",
  );

  const captureFailureWorkspace = await resolveWorkspace({
    cwd: repo,
    input: { worktree: true },
    mode: "single",
    runId: "run_check_worktree_capture_failure",
    taskIndex: 4,
  });
  const captureFailureResult = await syntheticResult(
    repo,
    "run_check_worktree_capture_failure",
    "attempt-1",
    "completed",
    {
      mode: "worktree",
      cwd: repo,
      worktreePath: captureFailureWorkspace.worktreePath,
    },
  );
  await writeFile(
    join(captureFailureWorkspace.cwd, "recover-me.txt"),
    "do not discard\n",
  );
  const { stdout: lockPath } = await execFileAsync(
    "git",
    ["rev-parse", "--git-path", "index.lock"],
    { cwd: captureFailureWorkspace.cwd, encoding: "utf8" },
  );
  await writeFile(lockPath.trim(), "test-held index lock\n");
  const finalizedCaptureFailure = await finalizeWorktreeResult(
    captureFailureWorkspace,
    captureFailureResult,
  );
  assert.equal(
    finalizedCaptureFailure.workspace.worktreeCleanupStatus,
    "failed",
  );
  assert.match(
    finalizedCaptureFailure.workspace.worktreeCleanupError,
    /failed to capture worktree artifacts/,
  );
  assert.equal(
    await readFile(join(captureFailureWorkspace.cwd, "recover-me.txt"), "utf8"),
    "do not discard\n",
  );
  assert.equal(
    await pathExists(captureFailureWorkspace.worktreePath),
    true,
    "capture failure must retain worktree",
  );
  await rm(lockPath.trim());

  // Simulate high-cardinality status/stat output without creating 60,000
  // files in every static run. All other commands use the real Git binary.
  const { stdout: gitPath } = await execFileAsync(
    "/bin/sh",
    ["-c", "command -v git"],
    { encoding: "utf8" },
  );
  const bin = join(tempRoot, "large-output-bin");
  await mkdir(bin);
  for (const kind of ["status", "stat"]) {
    const workspace = await resolveWorkspace({
      cwd: repo,
      input: { worktree: true },
      runId: `run_large_${kind}`,
    });
    await writeFile(
      join(workspace.cwd, "README.md"),
      "base\nlarge-output test\n",
    );
    const result = await syntheticResult(
      repo,
      `run_large_${kind}`,
      "attempt-1",
      "completed",
      { mode: "worktree", cwd: repo, worktreePath: workspace.worktreePath },
    );
    await writeFile(
      join(bin, "git"),
      `#!${process.execPath}\nconst {spawnSync}=require("node:child_process");\nconst args=process.argv.slice(2);\nif (${JSON.stringify(kind)} === "status" ? args[0] === "status" : args[0] === "diff" && args.includes("--stat")) {\nprocess.stdout.write("long-path-entry\\n".repeat(80000)+"LARGE-${kind}-TAIL\\n");\n} else { process.exitCode=spawnSync(${JSON.stringify(gitPath.trim())},args,{stdio:"inherit"}).status ?? 1; }\n`,
      { mode: 0o755 },
    );
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = `${bin}:${savedPath}`;
      const finalized = await finalizeWorktreeResult(workspace, result);
      assert.equal(
        finalized.workspace.worktreeCleanupStatus,
        "removed",
        `large ${kind} capture must succeed`,
      );
      const artifact = finalized.artifacts.find(
        (ref) =>
          ref.type ===
          (kind === "status" ? "worktree-status" : "worktree-diff"),
      );
      assert.ok(artifact.bytes > 1024 * 1024);
      const text = await readFile(join(repo, artifact.path), "utf8");
      assert.ok(text.includes(`LARGE-${kind}-TAIL`));
      assert.equal(artifact.bytes, Buffer.byteLength(text));
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
  }

  console.log(
    JSON.stringify(
      { name: "check-worktree-cleanup", status: "completed" },
      null,
      2,
    ),
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
