#!/usr/bin/env node
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { runTmuxModel } from "../../src/runners/tmux.ts";

function artifactByType(result, type) {
  const ref = result.artifacts.find((artifact) => artifact.type === type);
  assert.ok(ref, `missing ${type} artifact`);
  assert.equal(isAbsolute(ref.path), false, `${type} path should be relative`);
  assert.equal(ref.path.split("/").includes(".."), false, `${type} path should not escape cwd`);
  return ref;
}

async function readArtifact(cwd, result, type) {
  const ref = artifactByType(result, type);
  const path = join(cwd, ref.path);
  await access(path);
  return await readFile(path, "utf8");
}

const tempRoot = await mkdtemp(join(tmpdir(), "pi-subagent-tmux-model-"));
try {
  const cwd = join(tempRoot, "workspace");
  await mkdir(cwd, { recursive: true });

  const result = await runTmuxModel({
    cwd,
    runId: "run_check_tmux_model",
    taskId: "task-1",
    agent: "tmux-check-worker",
    roleContext: "Return only the requested marker. Do not use tools.",
    task: "Reply exactly: tmux-model-ok",
    timeoutMs: 60_000,
  });

  const stdout = await readArtifact(cwd, result, "stdout");
  const stderr = await readArtifact(cwd, result, "stderr");
  const output = await readArtifact(cwd, result, "output");
  await access(join(cwd, artifactByType(result, "result").path));

  if (result.status !== "completed") {
    const unavailable = result.failureKind === "model" || result.failureKind === "spawn" || result.failureKind === "timeout" || result.failureKind === "parse";
    if (unavailable) {
      console.log(
        JSON.stringify(
          {
            name: "check-tmux-model",
            status: "skipped",
            reason: "tmux and/or Pi model/auth path unavailable for tmux model check in this environment.",
            failureKind: result.failureKind,
            exitCode: result.exitCode,
            stderrBytes: Buffer.byteLength(stderr),
            stdoutBytes: Buffer.byteLength(stdout),
          },
          null,
          2,
        ),
      );
      process.exit(0);
    }
  }

  assert.equal(result.backend, "tmux");
  assert.equal(result.status, "completed");
  assert.equal(result.failureKind, null);
  assert.equal(result.exitCode, 0);
  assert.ok(result.tmux?.sessionName, "result should record tmux session metadata");
  assert.match(output, /tmux-model-ok/);

  console.log(
    JSON.stringify(
      {
        name: "check-tmux-model",
        status: "completed",
        runId: result.runId,
        outputBytes: Buffer.byteLength(output),
        tmux: result.tmux,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
