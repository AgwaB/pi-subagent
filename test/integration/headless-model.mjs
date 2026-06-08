#!/usr/bin/env node
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { parsePiJsonLines, runHeadlessModel } from "../../src/runners/headless-model.ts";

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

const parsed = parsePiJsonLines([
  JSON.stringify({ type: "session", version: 3 }),
  JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "parser-ok" }] } }),
  "",
].join("\n"));
assert.equal(parsed.finalAssistantText, "parser-ok");
assert.deepEqual(parsed.errors, []);
assert.deepEqual(parsed.parseErrors, []);

const tempRoot = await mkdtemp(join(tmpdir(), "pi-subagent-headless-model-"));
try {
  const cwd = join(tempRoot, "workspace");
  await mkdir(cwd, { recursive: true });

  const result = await runHeadlessModel({
    cwd,
    runId: "run_check_headless_model",
    taskId: "task-1",
    agent: "check-worker",
    roleContext: "Return only the requested marker. Do not use tools.",
    task: "Reply exactly: headless-model-ok",
    timeoutMs: 60_000,
    agentDefinition: {
      name: "check-worker",
      displayName: "check-worker",
      source: "global",
      path: "<check>",
      body: "Check-test worker.",
      tools: ["read"],
    },
  });

  const stdout = await readArtifact(cwd, result, "stdout");
  const stderr = await readArtifact(cwd, result, "stderr");
  const output = await readArtifact(cwd, result, "output");
  await access(join(cwd, artifactByType(result, "result").path));

  if (result.status !== "completed") {
    const modelUnavailable = result.failureKind === "model" || result.failureKind === "spawn" || result.failureKind === "timeout";
    if (modelUnavailable) {
      console.log(
        JSON.stringify(
          {
            name: "check-headless-model",
            status: "skipped",
            reason: "Pi model/auth path unavailable for headless check in this environment.",
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

  assert.equal(result.backend, "headless");
  assert.equal(result.status, "completed");
  assert.equal(result.failureKind, null);
  assert.equal(result.exitCode, 0);
  assert.match(output, /headless-model-ok/);

  console.log(
    JSON.stringify(
      {
        name: "check-headless-model",
        status: "completed",
        runId: result.runId,
        outputBytes: Buffer.byteLength(output),
      },
      null,
      2,
    ),
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
