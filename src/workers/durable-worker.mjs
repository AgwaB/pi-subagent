#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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
const [orchestration, artifacts, launchBarrier, constants] = await Promise.all([
	jiti.import("../orchestrate/run.ts"),
	jiti.import("../artifacts/index.ts"),
	jiti.import("../durable-launch-barrier.ts"),
	jiti.import("../core/constants.ts"),
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
				.finishAttemptFromResult(runRef, result)
				.catch(() => undefined);
			return;
		}
		const committed = await artifacts
			.commitAttemptResultIfActive(runRef, result)
			.catch(() => ({ committed: false }));
		if (!committed.committed) return;
		const terminalType = status === "cancelled" ? "cancelled" : "failed";
		await artifacts
			.appendRunEvent(runRef, {
				type: `attempt.${terminalType}`,
				attemptId,
				status,
				message,
				data: { failureKind, signal, exitCode },
			})
			.catch(() => undefined);
		await artifacts
			.appendRunEvent(runRef, {
				type: `run.${terminalType}`,
				status,
				message,
				data: { failureKind, signal, exitCode },
			})
			.catch(() => undefined);
	} catch (writeError) {
		console.error(
			writeError instanceof Error
				? (writeError.stack ?? writeError.message)
				: String(writeError),
		);
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

await artifacts
	.updateAttemptProcess({
		...runRef,
		attemptId,
		process: {
			pid: process.pid,
			processGroupId: workerProcessGroupId,
			command: "pi-subagent durable-worker",
			workerPid: process.pid,
			workerProcessGroupId,
		},
	})
	.catch(() => undefined);
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
	await orchestration.runPreparedSubagentExecution(preparedExecution, {
		signal: executionAbort.signal,
	});
} catch (error) {
	if (preparedExecution?.ownership?.state === "prepared")
		await orchestration.discardSubagentExecution(preparedExecution).catch(() => undefined);
	const message = error instanceof Error ? error.message : String(error);
	const cancelled = executionAbort.signal.aborted;
	await writeTerminalResult({
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
} finally {
	if (heartbeat !== undefined) clearInterval(heartbeat);
}
