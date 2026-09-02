import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
	DURABLE_WORKER_SYSTEM_PROMPT_FILE,
	DURABLE_WORKER_TASK_FILE,
	resolveDurableWorkerPayload,
	writeDurableWorkerPayload,
} from "../../src/durable-worker-payload.ts";
import { startAsyncSubagentRun } from "../../src/orchestrate/async.ts";
import {
	beginRunRecord,
	createAttemptArtifactStore,
	readRunRecord,
	upsertRunAttempt,
} from "../../src/artifacts/index.ts";
import { waitForSubagent } from "../../api.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const root = await mkdtemp(join(tmpdir(), "pi-subagent-payload-"));
// Model-backed scenarios honor the same overrides as an operator would pass to
// the tool, so a check run can be pinned to a specific provider/model.
const checkModel = process.env.PI_SUBAGENT_CHECK_MODEL;
const checkThinking = process.env.PI_SUBAGENT_CHECK_THINKING;
const modelInput = {
	...(checkModel ? { model: checkModel } : {}),
	...(checkThinking ? { thinking: checkThinking } : {}),
};
// Pinned runs use the headless backend (the durable path pi-workflow relies
// on), which records provider/model in the result envelope; the default run
// keeps the inline backend used by the other checks.
const checkBackend = checkModel ? "headless" : "inline";
const launchInput = { ...modelInput, backend: checkBackend };
const workerScript = fileURLToPath(
	new URL("../../src/workers/durable-worker.mjs", import.meta.url),
);

async function assertPinnedModel(resultPath) {
	if (!checkModel) return;
	const result = JSON.parse(await readFile(resultPath, "utf8"));
	const [provider, ...rest] = checkModel.split("/");
	const expectedModel = rest.length > 0 ? rest.join("/") : provider;
	assert.equal(result.metadata?.model, expectedModel, `result must record the pinned model ${expectedModel}`);
	if (rest.length > 0) assert.equal(result.metadata?.provider, provider);
}

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

	// 5b. Provider-free: a real detached worker whose sidecar is missing must
	// still end the attempt in a terminal state (the launcher already recorded
	// it as running), instead of exiting and leaving the run "running" forever.
	const cwd = join(root, "project");
	await (await import("node:fs/promises")).mkdir(cwd, { recursive: true });
	{
		const brokenRunId = "run_payload_broken_sidecar";
		const brokenAttemptId = "attempt_payload_broken";
		const brokenStartedAt = new Date();
		const brokenStore = await createAttemptArtifactStore({ cwd, runId: brokenRunId, attemptId: brokenAttemptId });
		const brokenPayloadPath = brokenStore.pathFor("worker");
		const brokenWritten = await writeDurableWorkerPayload({
			payloadPath: brokenPayloadPath,
			input: { backend: "headless", task: "This prompt will go missing.", onComplete: "detach", sandbox: false },
			cwd,
			backend: "headless",
			runId: brokenRunId,
			attemptId: brokenAttemptId,
			startedAt: brokenStartedAt.toISOString(),
		});
		const brokenRunning = await brokenStore.writeResult({
			backend: "headless",
			status: "running",
			failureKind: null,
			cwd,
			startedAt: brokenStartedAt,
			completedAt: null,
			workspace: { mode: "shared", cwd },
			sandbox: { enabled: false },
			exitCode: null,
			signal: null,
			artifacts: [brokenStore.refFor("worker", brokenWritten.bytes)],
			metadata: { contextLengthExceeded: false },
		});
		await upsertRunAttempt({
			cwd,
			runId: brokenRunId,
			attemptId: brokenAttemptId,
			status: "running",
			backend: "headless",
			startedAt: brokenStartedAt,
			artifactCwd: cwd,
			resultPath: brokenRunning.artifacts.find((artifact) => artifact.type === "result")?.path,
			createOnly: true,
			requireNoActive: true,
			activate: true,
		});
		await beginRunRecord({
			cwd,
			runId: brokenRunId,
			mode: "single",
			backend: "headless",
			startedAt: brokenStartedAt,
			dependency: "unclassified",
			activeAttemptId: brokenAttemptId,
			attempts: [],
		});
		await rm(join(brokenStore.attemptDir, "task.md"));
		const brokenWorker = spawn(process.execPath, [workerScript, brokenPayloadPath], {
			cwd,
			detached: process.platform !== "win32",
			stdio: "ignore",
		});
		brokenWorker.unref();
		const brokenWait = await waitForSubagent({
			cwd,
			runId: brokenRunId,
			attemptId: brokenAttemptId,
			timeoutMs: 60_000,
			pollIntervalMs: 100,
		});
		assert.equal(brokenWait.status, "completed", `worker with a missing sidecar must terminalize: ${JSON.stringify(brokenWait)}`);
		assert.equal(brokenWait.snapshot?.status, "failed");
		assert.equal(brokenWait.snapshot?.failureKind, "guard_failure");
		const brokenRecord = await readRunRecord({ cwd, runId: brokenRunId });
		assert.equal(brokenRecord?.status, "failed");
		assert.equal(brokenRecord?.activeAttemptId, null, "the failed attempt no longer holds active ownership");
		const brokenStderr = await readFile(join(brokenStore.attemptDir, "stderr.log"), "utf8");
		assert.match(brokenStderr, /task\.md|ENOENT|sidecar|reference/iu, `stderr explains the failure: ${brokenStderr}`);
	}

	// 5c. A payload that is not even valid JSON still terminalizes: the worker
	// recovers the run/attempt reference from the payload path.
	{
		const jsonRunId = "run_payload_invalid_json";
		const jsonAttemptId = "attempt_payload_invalid_json";
		const jsonStartedAt = new Date();
		const jsonStore = await createAttemptArtifactStore({ cwd, runId: jsonRunId, attemptId: jsonAttemptId });
		const jsonPayloadPath = jsonStore.pathFor("worker");
		await writeFile(jsonPayloadPath, "{");
		const jsonRunning = await jsonStore.writeResult({
			backend: "headless",
			status: "running",
			failureKind: null,
			cwd,
			startedAt: jsonStartedAt,
			completedAt: null,
			workspace: { mode: "shared", cwd },
			sandbox: { enabled: false },
			exitCode: null,
			signal: null,
			artifacts: [jsonStore.refFor("worker", 1)],
			metadata: { contextLengthExceeded: false },
		});
		await upsertRunAttempt({
			cwd,
			runId: jsonRunId,
			attemptId: jsonAttemptId,
			status: "running",
			backend: "headless",
			startedAt: jsonStartedAt,
			artifactCwd: cwd,
			resultPath: jsonRunning.artifacts.find((artifact) => artifact.type === "result")?.path,
			createOnly: true,
			requireNoActive: true,
			activate: true,
		});
		await beginRunRecord({
			cwd,
			runId: jsonRunId,
			mode: "single",
			backend: "headless",
			startedAt: jsonStartedAt,
			dependency: "unclassified",
			activeAttemptId: jsonAttemptId,
			attempts: [],
		});
		const jsonWorker = spawn(process.execPath, [workerScript, jsonPayloadPath], {
			cwd,
			detached: process.platform !== "win32",
			stdio: "ignore",
		});
		jsonWorker.unref();
		const jsonWait = await waitForSubagent({ cwd, runId: jsonRunId, attemptId: jsonAttemptId, timeoutMs: 60_000, pollIntervalMs: 100 });
		assert.equal(jsonWait.status, "completed", `worker with an unparseable payload must terminalize: ${JSON.stringify(jsonWait)}`);
		assert.equal(jsonWait.snapshot?.status, "failed");
		assert.equal(jsonWait.snapshot?.failureKind, "guard_failure");
		assert.equal((await readRunRecord({ cwd, runId: jsonRunId }))?.activeAttemptId, null);
		assert.match(await readFile(join(jsonStore.attemptDir, "stderr.log"), "utf8"), /not valid JSON/u);
	}

	// 6. End to end: a real detached durable worker launches from the reference payload.
	const launched = await startAsyncSubagentRun({
		cwd,
		backend: checkBackend,
		input: { ...launchInput, task: "Reply with the single word done.", onComplete: "detach", sandbox: false },
	});
	const wait = await waitForSubagent({
		cwd,
		runId: launched.runId,
		attemptId: launched.attemptId,
		timeoutMs: 60_000,
		pollIntervalMs: 50,
	});
	const modelUnavailable =
		wait.snapshot?.status !== "completed" &&
		["model", "spawn", "timeout"].includes(wait.snapshot?.failureKind);
	if (modelUnavailable) {
		// Scenarios 6 and 7 need a live model. Mirror the integration checks:
		// report a skip instead of failing where no provider is configured.
		console.log(
			JSON.stringify({
				name: "check-durable-worker-payload",
				status: "skipped",
				reason: `model-backed scenarios skipped: ${wait.snapshot?.failureKind}`,
			}),
		);
	} else {
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
	await assertPinnedModel(join(workerPath, "..", "result.json"));

	// 7. Compatibility: the current worker binary still launches from a payload
	// written in the pre-reference inline format (as produced by earlier
	// orchestrators), following the same record sequence as startAsyncSubagentRun.
	const legacyRunId = "run_legacy_inline_payload";
	const legacyAttemptId = "attempt_legacy_inline";
	const legacyStartedAt = new Date();
	const legacyStore = await createAttemptArtifactStore({
		cwd,
		runId: legacyRunId,
		attemptId: legacyAttemptId,
	});
	const legacyPayloadPath = legacyStore.pathFor("worker");
	const legacyPayloadText = `${JSON.stringify(
		{
			input: {
				...launchInput,
				task: "Reply with the single word legacy.",
				onComplete: "detach",
				sandbox: false,
			},
			cwd,
			backend: checkBackend,
			runId: legacyRunId,
			attemptId: legacyAttemptId,
			startedAt: legacyStartedAt.toISOString(),
		},
		null,
		2,
	)}\n`;
	await writeFile(legacyPayloadPath, legacyPayloadText);
	const legacyRunning = await legacyStore.writeResult({
		backend: checkBackend,
		status: "running",
		failureKind: null,
		cwd,
		startedAt: legacyStartedAt,
		completedAt: null,
		workspace: { mode: "shared", cwd },
		sandbox: { enabled: false },
		exitCode: null,
		signal: null,
		artifacts: [legacyStore.refFor("worker", Buffer.byteLength(legacyPayloadText, "utf8"))],
		metadata: { contextLengthExceeded: false },
	});
	await upsertRunAttempt({
		cwd,
		runId: legacyRunId,
		attemptId: legacyAttemptId,
		status: "running",
		backend: checkBackend,
		startedAt: legacyStartedAt,
		artifactCwd: cwd,
		resultPath: legacyRunning.artifacts.find((artifact) => artifact.type === "result")?.path,
		createOnly: true,
		requireNoActive: true,
		activate: true,
	});
	await beginRunRecord({
		cwd,
		runId: legacyRunId,
		mode: "single",
		backend: checkBackend,
		startedAt: legacyStartedAt,
		dependency: "unclassified",
		activeAttemptId: legacyAttemptId,
		attempts: [],
	});
	const legacyWorker = spawn(
		process.execPath,
		[workerScript, legacyPayloadPath, "ownership-legacy-check"],
		{ cwd, detached: process.platform !== "win32", stdio: "ignore" },
	);
	legacyWorker.unref();
	const legacyWait = await waitForSubagent({
		cwd,
		runId: legacyRunId,
		attemptId: legacyAttemptId,
		timeoutMs: 120_000,
		pollIntervalMs: 100,
	});
	assert.equal(legacyWait.status, "completed", JSON.stringify(legacyWait));
	assert.equal(legacyWait.snapshot?.status, "completed", JSON.stringify(legacyWait.snapshot));
	const legacyOutput = await readFile(join(legacyStore.attemptDir, "output.log"), "utf8");
	assert.match(legacyOutput, /legacy/iu, `legacy worker output: ${legacyOutput}`);
	const legacyStored = JSON.parse(await readFile(legacyPayloadPath, "utf8"));
	assert.equal(legacyStored.input.task, "Reply with the single word legacy.", "inline payload must stay inline");
	assert.equal(legacyStored.input.taskRef, undefined);
	await assertPinnedModel(join(legacyStore.attemptDir, "result.json"));
	}
} finally {
	await rm(root, { recursive: true, force: true });
}
console.log("durable worker payload checks passed");
