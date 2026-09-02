import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	DURABLE_WORKER_SYSTEM_PROMPT_FILE,
	DURABLE_WORKER_TASK_FILE,
	resolveDurableWorkerPayload,
	writeDurableWorkerPayload,
} from "../../src/durable-worker-payload.ts";
import { startAsyncSubagentRun } from "../../src/orchestrate/async.ts";
import { readRunRecord } from "../../src/artifacts/index.ts";
import { waitForSubagent } from "../../api.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const root = await mkdtemp(join(tmpdir(), "pi-subagent-payload-"));

try {
	// 1. Writer externalizes string prompts and references them by name, size, and digest.
	const attemptDir = join(root, "attempts", "attempt-1");
	await (await import("node:fs/promises")).mkdir(attemptDir, { recursive: true });
	const payloadPath = join(attemptDir, "worker.json");
	const task = "Summarize the repository.\n\nWith a second paragraph and unicode: 안녕 ✓\n";
	const systemPrompt = "You are a careful worker.";
	const written = await writeDurableWorkerPayload({
		payloadPath,
		input: { task, systemPrompt, tools: ["read"], runsDir: ".pi/agent/runs", async: true },
		cwd: root,
		backend: "headless",
		runId: "run_payload_1",
		attemptId: "attempt-1",
		startedAt: "2026-09-02T00:00:00.000Z",
	});
	const stored = JSON.parse(await readFile(payloadPath, "utf8"));
	assert.equal(written.bytes, Buffer.byteLength(await readFile(payloadPath, "utf8"), "utf8"));
	assert.equal(stored.input.task, undefined, "task must not be inlined");
	assert.equal(stored.input.systemPrompt, undefined, "systemPrompt must not be inlined");
	assert.deepEqual(stored.input.tools, ["read"]);
	assert.deepEqual(stored.input.taskRef, {
		path: DURABLE_WORKER_TASK_FILE,
		bytes: Buffer.byteLength(task, "utf8"),
		sha256: sha256(Buffer.from(task, "utf8")),
	});
	assert.deepEqual(stored.input.systemPromptRef, {
		path: DURABLE_WORKER_SYSTEM_PROMPT_FILE,
		bytes: Buffer.byteLength(systemPrompt, "utf8"),
		sha256: sha256(Buffer.from(systemPrompt, "utf8")),
	});
	assert.equal(await readFile(join(attemptDir, DURABLE_WORKER_TASK_FILE), "utf8"), task);
	assert.equal(
		await readFile(join(attemptDir, DURABLE_WORKER_SYSTEM_PROMPT_FILE), "utf8"),
		systemPrompt,
	);
	assert.deepEqual(written.sidecars, [
		join(attemptDir, DURABLE_WORKER_TASK_FILE),
		join(attemptDir, DURABLE_WORKER_SYSTEM_PROMPT_FILE),
	]);
	assert.ok(written.bytes < 800, `payload should be small, got ${written.bytes} bytes`);

	// 2. Resolver restores the exact inline strings and drops the references.
	const resolved = await resolveDurableWorkerPayload(stored, payloadPath);
	assert.equal(resolved.input.task, task);
	assert.equal(resolved.input.systemPrompt, systemPrompt);
	assert.equal(resolved.input.taskRef, undefined);
	assert.equal(resolved.input.systemPromptRef, undefined);
	assert.deepEqual(resolved.input.tools, ["read"]);
	assert.equal(resolved.runId, "run_payload_1");
	assert.equal(stored.input.taskRef.path, DURABLE_WORKER_TASK_FILE, "resolver must not mutate its input");

	// 3. Legacy inline payloads pass through untouched (pre-reference format).
	const legacy = {
		input: { task: "inline task", systemPrompt: "inline system", tools: ["read"] },
		cwd: root,
		backend: "headless",
		runId: "run_legacy",
		attemptId: "attempt-legacy",
		startedAt: "2026-09-02T00:00:00.000Z",
	};
	const legacyResolved = await resolveDurableWorkerPayload(legacy, join(root, "missing", "worker.json"));
	assert.deepEqual(legacyResolved, legacy);
	assert.deepEqual(await resolveDurableWorkerPayload({ input: undefined }, payloadPath), { input: undefined });

	// 4. A payload without systemPrompt externalizes only the task.
	const taskOnlyDir = join(root, "attempts", "attempt-2");
	await (await import("node:fs/promises")).mkdir(taskOnlyDir, { recursive: true });
	await writeDurableWorkerPayload({
		payloadPath: join(taskOnlyDir, "worker.json"),
		input: { task: "only task" },
		cwd: root,
		backend: "inline",
		runId: "run_payload_2",
		attemptId: "attempt-2",
		startedAt: "2026-09-02T00:00:00.000Z",
	});
	const taskOnly = JSON.parse(await readFile(join(taskOnlyDir, "worker.json"), "utf8"));
	assert.equal(taskOnly.input.systemPromptRef, undefined);
	assert.equal(taskOnly.input.taskRef.path, DURABLE_WORKER_TASK_FILE);
	await assert.rejects(stat(join(taskOnlyDir, DURABLE_WORKER_SYSTEM_PROMPT_FILE)));

	// 5. Tampering and unsafe references are rejected before use.
	const tampered = structuredClone(stored);
	await writeFile(join(attemptDir, DURABLE_WORKER_TASK_FILE), `${task}!`);
	await assert.rejects(
		resolveDurableWorkerPayload(tampered, payloadPath),
		/taskRef size mismatch/u,
	);
	await writeFile(join(attemptDir, DURABLE_WORKER_TASK_FILE), task.replace("Summarize", "Summarise"));
	await assert.rejects(
		resolveDurableWorkerPayload(tampered, payloadPath),
		/taskRef digest mismatch/u,
	);
	await writeFile(join(attemptDir, DURABLE_WORKER_TASK_FILE), task);
	for (const badPath of ["../task.md", "/etc/passwd", "sub/task.md", "", ".hidden", "a\\b"]) {
		const unsafe = structuredClone(stored);
		unsafe.input.taskRef.path = badPath;
		await assert.rejects(
			resolveDurableWorkerPayload(unsafe, payloadPath),
			/plain file name/u,
			`path ${JSON.stringify(badPath)} must be rejected`,
		);
	}
	const badDigest = structuredClone(stored);
	badDigest.input.taskRef.sha256 = "not-a-digest";
	await assert.rejects(resolveDurableWorkerPayload(badDigest, payloadPath), /lowercase hex SHA-256/u);
	const ambiguous = structuredClone(stored);
	ambiguous.input.task = "inline and ref";
	await assert.rejects(
		resolveDurableWorkerPayload(ambiguous, payloadPath),
		/both task and taskRef/u,
	);
	await assert.rejects(
		writeDurableWorkerPayload({
			payloadPath: join(taskOnlyDir, "worker.json"),
			input: { task: "x", taskRef: { path: "task.md", bytes: 1, sha256: "0".repeat(64) } },
			cwd: root,
			backend: "inline",
			runId: "run_payload_3",
			attemptId: "attempt-3",
			startedAt: "2026-09-02T00:00:00.000Z",
		}),
		/already declares taskRef/u,
	);

	// 6. End to end: a real detached durable worker launches from the reference payload.
	const cwd = join(root, "project");
	await (await import("node:fs/promises")).mkdir(cwd, { recursive: true });
	const launched = await startAsyncSubagentRun({
		cwd,
		backend: "inline",
		input: { task: "Reply with the single word done.", onComplete: "detach", sandbox: false },
	});
	const wait = await waitForSubagent({
		cwd,
		runId: launched.runId,
		attemptId: launched.attemptId,
		timeoutMs: 20_000,
		pollIntervalMs: 50,
	});
	assert.equal(wait.status, "completed", JSON.stringify(wait));
	const record = await readRunRecord({ cwd, runId: launched.runId });
	const attempt = record?.attempts?.find((entry) => entry.attemptId === launched.attemptId);
	assert.ok(attempt, "attempt record must exist");
	const workerRef = launched.artifacts.find((artifact) => artifact.type === "worker");
	assert.ok(workerRef, "worker artifact must be referenced");
	const workerPath = join(cwd, workerRef.path);
	const liveWorkerPayload = JSON.parse(await readFile(workerPath, "utf8"));
	assert.equal(liveWorkerPayload.input.task, undefined);
	assert.equal(liveWorkerPayload.input.taskRef.path, DURABLE_WORKER_TASK_FILE);
	assert.equal((await stat(workerPath)).size, workerRef.bytes, "recorded worker bytes must match the file");
	assert.equal(
		await readFile(join(workerPath, "..", DURABLE_WORKER_TASK_FILE), "utf8"),
		"Reply with the single word done.",
	);
} finally {
	await rm(root, { recursive: true, force: true });
}
console.log("durable worker payload checks passed");
