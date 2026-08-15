#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

import {
	executionInputAfterDurableLaunch,
	installDurableWorkerBinding,
	isDurableWorkerGuardError,
	prepareDurableWorkerBinding,
} from "./durable-worker-binding.mjs";

const payloadPath = process.argv[2];
if (!payloadPath) {
	console.error("durable worker missing payload path");
	process.exit(2);
}

const jiti = createJiti(import.meta.url, { interopDefault: false });
const [orchestration, artifacts, launchBarrier, constants, processIdentity] =
	await Promise.all([
	jiti.import("../orchestrate/run.ts"),
	jiti.import("../artifacts/index.ts"),
	jiti.import("../durable-launch-barrier.ts"),
	jiti.import("../core/constants.ts"),
	jiti.import("../process-identity.ts"),
	]);

const payloadBytes = await readFile(payloadPath);
const launchPayloadSha256 = createHash("sha256").update(payloadBytes).digest("hex");
const payload = JSON.parse(payloadBytes.toString("utf8"));
const { input, cwd, runId, attemptId } = payload;
const heartbeatMs = Math.max(
	50,
	Number.parseInt(process.env.PI_SUBAGENT_HEARTBEAT_MS ?? "5000", 10) || 5000,
);
const runRef = { cwd, runId, runsDir: input?.runsDir };
const workerProcessGroupId =
	process.platform === "win32" ? undefined : process.pid;
let terminalWritePromise;
let heartbeat;
let preparedExecution;
let terminalResult;
const executionAbort = new AbortController();

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function maybeDelayTerminalWriteForTests() {
	const delayMs = Number.parseInt(
		process.env.PI_SUBAGENT_DURABLE_WORKER_TERMINAL_WRITE_DELAY_MS ?? "0",
		10,
	);
	if (Number.isFinite(delayMs) && delayMs > 0) await sleep(delayMs);
}

async function readExistingAttempt() {
	const record = await artifacts.readRunRecord(runRef).catch(() => null);
	return record?.attempts?.find(
		(candidate) => candidate.attemptId === attemptId,
	);
}

async function writeTerminalResultOnce({
	status,
	failureKind,
	message,
	signal = null,
	exitCode = null,
}) {
	if (heartbeat !== undefined) clearInterval(heartbeat);
	try {
		const existingAttempt = await readExistingAttempt();
		const existingAttemptTerminal = TERMINAL_STATUSES.has(
			existingAttempt?.status,
		);
		const shouldBackfillDuplicateResult =
			existingAttemptTerminal &&
			existingAttempt?.status === status &&
			(existingAttempt.failureKind ?? null) === failureKind;
		if (existingAttemptTerminal && !shouldBackfillDuplicateResult) return;
		await maybeDelayTerminalWriteForTests();
		const store = await artifacts.createAttemptArtifactStore({
			cwd,
			runId,
			attemptId,
			runsDir: input?.runsDir,
		});
		const stderr = await store.writeTextArtifact("stderr", `${message}\n`);
		const worker = store.refFor("worker");
		const preparedWorkspace = preparedExecution?.workspaceResult;
		const retainedWorkspace =
			preparedWorkspace?.mode === "worktree"
				? {
						...preparedWorkspace,
						worktreeCleanupStatus:
							preparedExecution?.ownership?.cleanupStatus ?? "kept",
					}
				: (preparedWorkspace ?? { mode: "shared", cwd });
		const result = await store.writeResult({
			backend: payload.backend ?? "headless",
			status,
			failureKind,
			cwd,
			startedAt: payload.startedAt ?? new Date().toISOString(),
			completedAt: new Date().toISOString(),
			workspace: retainedWorkspace,
			sandbox: { enabled: Boolean(input?.sandbox) },
			exitCode,
			signal,
			artifacts: [worker, stderr],
			correlationId: input?.correlationId,
			metadata: { contextLengthExceeded: false },
		});
		if (shouldBackfillDuplicateResult) {
			await artifacts
				.refreshTerminalAttemptResultIfCurrent(runRef, result)
				.catch(() => undefined);
			return undefined;
		}
		return result;
	} catch (writeError) {
		console.error(
			writeError instanceof Error
				? (writeError.stack ?? writeError.message)
				: String(writeError),
		);
		return undefined;
	}
}

function writeTerminalResult(options) {
	terminalWritePromise ??= writeTerminalResultOnce(options);
	return terminalWritePromise;
}

async function maybeDelayStartForTests() {
	const delayMs = Number.parseInt(
		process.env.PI_SUBAGENT_DURABLE_WORKER_START_DELAY_MS ?? "0",
		10,
	);
	if (!Number.isFinite(delayMs) || delayMs <= 0) return;
	await Promise.race([
		sleep(delayMs),
		new Promise((resolveAbort) =>
			executionAbort.signal.addEventListener("abort", resolveAbort, {
				once: true,
			}),
		),
	]);
}

function failureKindFromError(error) {
	const kind = error?.failureKind;
	return constants.isFailureKind(kind) ? kind : "internal";
}

function requestCancel(signal) {
	executionAbort.abort(new Error(`durable worker received ${signal}`));
	process.exitCode = 130;
}

process.once("SIGINT", () => requestCancel("SIGINT"));
process.once("SIGTERM", () => requestCancel("SIGTERM"));

const workerIdentity = await processIdentity.captureProcessIdentity(process.pid);
const workerProcessMetadata = {
	command: "pi-subagent durable-worker",
	workerPid: workerIdentity.pid,
	workerProcessGroupId: workerIdentity.processGroupId,
	workerProcessBirthIdentity: workerIdentity.birthIdentity,
};
const workerRecord = await artifacts.updateAttemptWorkerProcess({
		...runRef,
		attemptId,
		process: workerProcessMetadata,
	});
const persistedWorker = workerRecord.attempts.find(
	(candidate) => candidate.attemptId === attemptId,
);
if (
	workerRecord.activeAttemptId !== attemptId ||
	persistedWorker?.process?.workerPid !== workerIdentity.pid ||
	persistedWorker.process.workerProcessGroupId !== workerIdentity.processGroupId ||
	persistedWorker.process.workerProcessBirthIdentity !==
		workerIdentity.birthIdentity
)
	throw new Error(
		"durable worker ownership metadata was not committed to the active attempt",
	);
heartbeat = setInterval(() => {
	void artifacts
		.recordAttemptHeartbeat({ ...runRef, attemptId })
		.catch(() => undefined);
}, heartbeatMs);
heartbeat.unref?.();
try {
	await maybeDelayStartForTests();
	if (executionAbort.signal.aborted) {
		const cancelled = new Error("durable worker was cancelled before execution");
		cancelled.failureKind = "user_cancelled";
		throw cancelled;
	}
	const executionInput = input?.durableLaunchBarrier
		? executionInputAfterDurableLaunch(input)
		: { ...input, async: false, onComplete: undefined };
	preparedExecution = await orchestration.prepareSubagentExecution({
		input: executionInput,
		cwd,
		runId,
		attemptId,
		resumeExistingAttempt: true,
		requiresDurableWorkerBinding: Boolean(input?.durableLaunchBarrier),
	});
	if (input?.durableLaunchBarrier) {
		const executionPlan = {
			schema: "pi-subagent-durable-execution-plan-v1",
			backend: preparedExecution.backend,
			runId,
			attemptId,
			cwd: preparedExecution.workspace.cwd,
			workspace: preparedExecution.workspaceResult,
			agent: preparedExecution.requestedAgent,
			tools: preparedExecution.effectiveTools,
		};
		const executionPlanSha256 = createHash("sha256")
			.update(JSON.stringify(executionPlan))
			.digest("hex");
		const preflight = prepareDurableWorkerBinding({
			payload,
			launchPayloadSha256,
			executionPlanSha256,
			executionCwd: preparedExecution.workspace.cwd,
		});
		const ack = await launchBarrier.awaitDurableLaunchBarrier({
			descriptor: input.durableLaunchBarrier,
			runId,
			attemptId,
			launchPayloadSha256,
			executionPlanSha256,
			workerProcessGroupId,
			signal: executionAbort.signal,
		});
		const binding = installDurableWorkerBinding({
			payload,
			launchPayloadSha256,
			executionPlanSha256,
			ack,
			preflight,
		});
		preparedExecution.durableWorkerBinding = JSON.stringify(binding);
	}
	terminalResult = await orchestration.runPreparedSubagentExecution(preparedExecution, {
		signal: executionAbort.signal,
		deferTerminalCommit: true,
	});
} catch (error) {
	if (error?.terminalBlocked === true) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	} else {
	if (preparedExecution?.ownership?.state === "prepared")
		await orchestration.discardSubagentExecution(preparedExecution).catch(() => undefined);
	const message = error instanceof Error ? error.message : String(error);
	const cancelled = executionAbort.signal.aborted;
	terminalResult = await writeTerminalResult({
		status: cancelled ? "cancelled" : "failed",
		failureKind: cancelled
			? "user_cancelled"
			: isDurableWorkerGuardError(error) ||
				launchBarrier.isDurableLaunchBarrierError?.(error)
					? "guard_failure"
					: failureKindFromError(error),
		message,
		exitCode: null,
	});
	process.exitCode = 1;
	}
} finally {
	if (heartbeat !== undefined) clearInterval(heartbeat);
}
if (terminalResult !== undefined) {
	const finalizerPath = fileURLToPath(
		new URL("./terminal-finalizer.mjs", import.meta.url),
	);
	const finalizerPayload = Buffer.from(
		JSON.stringify({
			ref: runRef,
			attemptId,
			status: terminalResult.status,
			worker: workerIdentity,
		}),
	).toString("base64url");
	const finalizer = spawn(process.execPath, [finalizerPath, finalizerPayload], {
		cwd,
		detached: true,
		stdio: "ignore",
		env: {
			PATH: "/usr/bin:/bin",
			LC_ALL: "C",
			LANG: "C",
		},
	});
	finalizer.unref();
}
