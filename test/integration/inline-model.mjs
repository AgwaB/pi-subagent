#!/usr/bin/env node
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { runInlineModel } from "../../src/runners/inline.ts";

// Model-backed checks honor the same overrides an operator would pass to the
// tool, so a run can be pinned to a specific provider/model.
const checkModelInput = {
  ...(process.env.PI_SUBAGENT_CHECK_MODEL ? { model: process.env.PI_SUBAGENT_CHECK_MODEL } : {}),
  ...(process.env.PI_SUBAGENT_CHECK_THINKING ? { thinking: process.env.PI_SUBAGENT_CHECK_THINKING } : {}),
};


function artifactByType(result, type) {
  const ref = result.artifacts.find((artifact) => artifact.type === type);
  assert.ok(ref, `missing ${type} artifact`);
  assert.equal(isAbsolute(ref.path), false, `${type} path should be relative`);
  assert.equal(ref.path.split("/").includes(".."), false, `${type} path should not escape cwd`);
  return ref;
}

async function readArtifact(cwd, result, type) {
  const ref = artifactByType(result, type);
  const artifactPath = join(cwd, ref.path);
  await access(artifactPath);
  return await readFile(artifactPath, "utf8");
}

const tempRoot = await mkdtemp(join(tmpdir(), "pi-subagent-inline-model-"));
try {
  const cwd = join(tempRoot, "workspace");
  await mkdir(cwd, { recursive: true });

  const result = await runInlineModel({
    ...checkModelInput,
    cwd,
    runId: "run_check_inline_model",
    taskId: "task-1",
    agent: "check-inline-worker",
    roleContext: "Return only the requested marker. Do not use tools.",
    task: "Reply exactly: inline-model-ok",
    timeoutMs: 60_000,
  });

  assert.equal(result.artifacts.some((artifact) => artifact.type === "stdout"), false, "inline should not store stdout streams by default");
  const stderr = await readArtifact(cwd, result, "stderr");
  const output = await readArtifact(cwd, result, "output");
  await access(join(cwd, artifactByType(result, "result").path));

  if (result.status !== "completed") {
    const modelUnavailable = result.failureKind === "model" || result.failureKind === "spawn" || result.failureKind === "timeout";
    if (modelUnavailable) {
      console.log(
        JSON.stringify(
          {
            name: "check-inline-model",
            status: "skipped",
            reason: "Pi SDK model/auth path unavailable for inline check in this environment.",
            failureKind: result.failureKind,
            stderrBytes: Buffer.byteLength(stderr),
          },
          null,
          2,
        ),
      );
      process.exit(0);
    }
  }

  assert.equal(result.backend, "inline");
  assert.equal(result.status, "completed");
  assert.equal(result.failureKind, null);
  assert.equal(result.exitCode, null);
  assert.match(output, /inline-model-ok/);
  assert.equal(typeof result.metadata.provider, "string", "inline results record the provider");
  assert.equal(typeof result.metadata.model, "string", "inline results record the model");
  assert.ok(result.metadata.usage && typeof result.metadata.usage === "object", "inline results record usage");
  if (checkModelInput.model) {
    assert.equal(`${result.metadata.provider}/${result.metadata.model}`, checkModelInput.model, "pinned model is honored");
  }

  console.log(
    JSON.stringify(
      {
        name: "check-inline-model",
        status: "completed",
        runId: result.runId,
        outputBytes: Buffer.byteLength(output),
        provider: result.metadata.provider,
        model: result.metadata.model,
        usage: result.metadata.usage,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
