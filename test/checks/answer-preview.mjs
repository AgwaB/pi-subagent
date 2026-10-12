#!/usr/bin/env node
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";
import { createAttemptArtifactStore } from "../../src/artifacts/store.ts";
import { readAnswerPreview } from "../../src/artifacts/preview.ts";

const cwd = await mkdtemp(join(tmpdir(), "pi-subagent-answer-preview-"));
const oldPath = process.env.PATH;
const oldDelay = process.env.PI_SUBAGENT_DURABLE_WORKER_START_DELAY_MS;
try {
	const store = await createAttemptArtifactStore({ cwd, runId: "run_preview", attemptId: "attempt-1" });
	const output = await store.writeTextArtifact("output", "한글🙂".repeat(1000));
	const result = await store.writeResult({ cwd, backend: "headless", status: "completed", artifacts: [output] });
	const preview = await readAnswerPreview(result);
	assert.ok(preview.text.length > 0);
	assert.ok(Buffer.byteLength(preview.text) <= 2048);
	assert.equal(preview.text.includes("�"), false, "UTF-8 boundary stays intact");
	assert.equal(preview.truncated, true);
	assert.equal(preview.partial, false);
	assert.equal((await readAnswerPreview({ ...result, status: "failed" })).partial, true);
	assert.equal((await readAnswerPreview({ ...result, metadata: { ...result.metadata, outputPartial: true } })).partial, true);
	assert.equal(await readAnswerPreview({ ...result, status: "running" }), undefined);
	assert.equal(await readAnswerPreview({ ...result, artifacts: [] }), undefined);
	assert.equal(await readAnswerPreview({ ...result, artifacts: [{ type: "output", path: "../../etc/passwd" }] }), undefined);
	assert.equal(await readAnswerPreview({ ...result, attemptId: "other-attempt" }), undefined);
	const path = resolve(cwd, output.path);
	await writeFile(path, "short answer");
	assert.deepEqual(await readAnswerPreview(result), { text: "short answer", partial: false, truncated: false });
	await writeFile(path, "");
	assert.equal(await readAnswerPreview(result), undefined);
	await rm(path);
	assert.equal(await readAnswerPreview(result), undefined);
	const sibling = join(cwd, "private.txt");
	await writeFile(sibling, "not output");
	await symlink(sibling, path);
	assert.equal(await readAnswerPreview(result), undefined, "do not follow symlinked artifacts");
	await rm(path);
	await mkdir(path);
	assert.equal(await readAnswerPreview(result), undefined, "reject non-regular output");
	await rm(path, { recursive: true });

	// Exercise the real extension response surfaces with a provider-free child.
	const bin = join(cwd, "bin");
	await mkdir(bin);
	const fakePi = join(bin, "pi");
	await writeFile(fakePi, `#!${process.execPath}
const task = process.argv.at(-1);
const text = task.includes("short") ? "short answer" : "한글🙂".repeat(1000);
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } }));
if (task.includes("hang")) {
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "x", name: "read", arguments: {} }], stopReason: "toolUse" } }));
  setInterval(() => {}, 1000);
}
`);
	await chmod(fakePi, 0o700);
	process.env.PATH = `${bin}:${oldPath ?? ""}`;
	const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
	const module = await jiti.import(resolve("src/index.ts"));
	let tool;
	(module.default ?? module)({ registerCommand() {}, registerTool(value) { tool = value; } });
	const updates = [];
	async function execute(args) {
		const response = await tool.execute("preview-test", { cwd, ...args }, new AbortController().signal, update => updates.push(JSON.parse(update.content[0].text)), { cwd });
		return { response, payload: JSON.parse(response.content[0].text) };
	}
	const run = await execute({ backend: "headless", task: "short", timeoutMs: 5000 });
	assert.equal(run.payload.status, "completed");
	assert.deepEqual(run.payload.answerPreview, { text: "short answer", partial: false, truncated: false });
	const ref = { runId: run.payload.runId, attemptId: run.payload.attemptId };
	const waited = await execute({ action: "wait", ...ref });
	assert.deepEqual(waited.payload.answerPreview, run.payload.answerPreview);
	const status = await execute({ action: "status", ...ref });
	assert.equal(JSON.stringify(status.payload).includes("answerPreview"), false, "status polling does not duplicate the answer");
	const parallel = await execute({ backend: "headless", tasks: Array.from({ length: 6 }, () => ({ task: "long" })), concurrency: 2, timeoutMs: 10000 });
	assert.equal(parallel.payload.status, "completed");
	assert.equal(parallel.payload.runs.length, 6);
	assert.ok(parallel.payload.runs.every(run => run.answerPreview?.truncated === true));
	assert.ok(parallel.payload.runs.reduce((sum, run) => sum + Buffer.byteLength(run.answerPreview.text), 0) <= 8192);

	// Worker startup exceeds its model timeout. Notification must wait for the
	// terminal result, not stop observing at that same short timeout.
	process.env.PI_SUBAGENT_DURABLE_WORKER_START_DELAY_MS = "1200";
	const asyncRun = await execute({ backend: "headless", task: "short hang", async: true, onComplete: "notify", timeoutMs: 1000 });
	delete process.env.PI_SUBAGENT_DURABLE_WORKER_START_DELAY_MS;
	assert.equal(asyncRun.payload.status, "running");
	assert.equal(asyncRun.payload.answerPreview, undefined);
	const asyncRef = { runId: asyncRun.payload.runId, attemptId: asyncRun.payload.attemptId };
	const waiting = await execute({ action: "wait", ...asyncRef, timeoutMs: 50, pollIntervalMs: 10 });
	assert.equal(waiting.payload.status, "timeout");
	assert.equal(waiting.payload.answerPreview, undefined);
	const terminal = await execute({ action: "wait", ...asyncRef, timeoutMs: 30000, pollIntervalMs: 50 });
	assert.equal(terminal.payload.status, "completed");
	assert.equal(terminal.payload.snapshot.status, "failed");
	assert.equal(terminal.payload.snapshot.failureKind, "timeout");
	assert.equal(terminal.response.isError, true);
	assert.deepEqual(terminal.payload.answerPreview, { text: "short answer", partial: true, truncated: false });
	let notification;
	for (let index = 0; index < 100; index++) {
		notification = updates.find(update => update.runId === asyncRef.runId && update.event === "complete");
		if (notification) break;
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	assert.ok(notification, "notification survives startup + execution + terminal persistence");
	assert.equal(notification.status, "failed");
	assert.deepEqual(notification.answerPreview, terminal.payload.answerPreview);
	assert.equal(updates.filter(update => update.runId === asyncRef.runId && update.event === "complete").length, 1);
	const persisted = JSON.parse(await readFile(resolve(cwd, terminal.payload.snapshot.resultPath), "utf8"));
	assert.equal(persisted.metadata.outputPartial, true);
	assert.equal(persisted.answerPreview, undefined, "preview is derived, not a second result store");
	console.log(JSON.stringify({ name: "check-answer-preview", status: "completed", providerCalls: 0 }));
} finally {
	if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
	if (oldDelay === undefined) delete process.env.PI_SUBAGENT_DURABLE_WORKER_START_DELAY_MS; else process.env.PI_SUBAGENT_DURABLE_WORKER_START_DELAY_MS = oldDelay;
	await rm(cwd, { recursive: true, force: true });
}
