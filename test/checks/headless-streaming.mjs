#!/usr/bin/env node
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHeadlessModel } from "../../src/runners/headless-model.ts";

function artifactByType(result, type) {
  const artifact = result.artifacts.find((candidate) => candidate.type === type);
  assert.ok(artifact, `missing ${type} artifact`);
  return artifact;
}

function maybeArtifactByType(result, type) {
  return result.artifacts.find((candidate) => candidate.type === type);
}

const tempRoot = await mkdtemp(join(tmpdir(), "pi-subagent-headless-streaming-"));
try {
  const cwd = join(tempRoot, "workspace");
  await mkdir(cwd, { recursive: true });
  const fakePi = join(tempRoot, "fake-pi.mjs");
  await writeFile(fakePi, `#!/usr/bin/env node
const filler = "x".repeat(4096);
for (let index = 0; index < 768; index += 1) {
  process.stdout.write(JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: filler + index }] } }) + "\\n");
}
process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "fetch_content", args: { url: "https://user:pass@docs.example.test/a/b?token=secret#fragment", headers: { Authorization: "Bearer secret-token", Cookie: "cookie-secret" }, nested: { apiKey: "api-key-secret" }, prompt: "summarize this page" } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "tool_execution_update", toolCallId: "tool-1", toolName: "fetch_content", args: {}, partialResult: { text: "should-not-appear-update-secret" } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "fetch_content", result: { content: [{ type: "text", text: "result-body-secret" + filler }], url: "https://docs.example.test/a/b?token=secret#fragment" }, isError: false }) + "\\n");
process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "stream-parser-ok" }], provider: "fake", model: "fake/model", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end" } }) + "\\n");
`, "utf8");
  await chmod(fakePi, 0o700);

  const result = await runHeadlessModel({
    cwd,
    runId: "run_check_headless_streaming",
    attemptId: "attempt-streaming",
    piCommand: fakePi,
    agent: "stream-worker",
    task: "emit a large event stream",
    timeoutMs: 30_000,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.failureKind, null);
  assert.equal(result.metadata.contextLengthExceeded, false);
  assert.equal(result.metadata.provider, "fake");
  assert.equal(result.metadata.model, "fake/model");

  const outputPath = join(cwd, artifactByType(result, "output").path);
  assert.equal(await readFile(outputPath, "utf8"), "stream-parser-ok");

  assert.equal(result.artifacts.some((artifact) => artifact.type === "stdout"), false, "stdout event streams should not be stored by default");
  assert.equal(maybeArtifactByType(result, "tool-calls"), undefined, "tool call telemetry should be off by default");
  assert.equal(maybeArtifactByType(result, "tool-calls-summary"), undefined, "tool call telemetry summary should be off by default");

  const captured = await runHeadlessModel({
    cwd,
    runId: "run_check_headless_tool_calls",
    attemptId: "attempt-tool-calls",
    piCommand: fakePi,
    agent: "stream-worker",
    task: "emit a tool call stream",
    timeoutMs: 30_000,
    captureToolCalls: true,
  });
  assert.equal(captured.status, "completed");
  const callsText = await readFile(join(cwd, artifactByType(captured, "tool-calls").path), "utf8");
  const summary = JSON.parse(await readFile(join(cwd, artifactByType(captured, "tool-calls-summary").path), "utf8"));
  const callRecords = callsText.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(callRecords.length, 1);
  assert.equal(callRecords[0].toolCallId, "tool-1");
  assert.equal(callRecords[0].toolName, "fetch_content");
  assert.equal(callRecords[0].category, "network");
  assert.equal(callRecords[0].status, "completed");
  assert.equal(callRecords[0].isError, false);
  assert.ok(callRecords[0].durationMs >= 0);
  assert.deepEqual(summary.callsByTool, { fetch_content: 1 });
  assert.equal(summary.callsByCategory.network, 1);
  assert.equal(summary.totalCalls, 1);
  assert.equal(summary.limits.updatesCaptured, false);
  assert.equal(summary.limits.fullArgsStored, false);
  assert.equal(summary.limits.fullResultsStored, false);
  assert.ok(summary.resources.urls.includes("https://docs.example.test/a/b"));
  assert.ok(summary.resources.hosts.includes("docs.example.test"));
  assert.match(callsText, /"redactedKeys":\["headers"\]/);
  assert.doesNotMatch(callsText, /Bearer secret-token|cookie-secret|api-key-secret|result-body-secret|should-not-appear-update-secret|token=secret|#fragment/);

  console.log(JSON.stringify({ name: "check-headless-streaming", status: "completed" }, null, 2));
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
