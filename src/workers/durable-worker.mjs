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
const [
	orchestration,
	artifacts,
	launchBarrier,
	constants,
	processIdentity,
	payloadModule,
] = await Promise.all([
	jiti.import("../orchestrate/run.ts"),
	jiti.import("../artifacts/index.ts"),
	jiti.import("../durable-launch-barrier.ts"),
	jiti.import("../core/constants.ts"),
	jiti.import("../process-identity.ts"),
	jiti.import("../durable-worker-payload.ts"),
]);

const executionAbort = new AbortController();

function requestCancel(signal) {
	executionAbort.abort(
		constants.userCancelledAbortReason(`durable worker received ${signal}`),
	);
	process.exitCode = 130;
}

// Install signal handling before anything that can take time (payload and
// sidecar reads included) so an early operator interrupt is recorded instead
// of killing the worker with no terminal result. Keep handling repeated
// signals: escalation re-sends SIGTERM, and a `once` handler would let the
// second delivery kill the worker before it records a terminal result.
process.on("SIGINT", () => requestCancel("SIGINT"));
process.on("SIGTERM", () => requestCancel("SIGTERM"));

function spawnTerminalFinalizer({ ref, attemptId, status, worker, cwd }) {
	const finalizerPath = fileURLToPath(
		new URL("./terminal-finalizer.mjs", import.meta.url),
	);
	const finalizerPayload = Buffer.from(
		JSON.stringify({ ref, attemptId, status, worker }),
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

/**
 * The launcher has already recorded the attempt as running. If the payload
 * cannot be resolved (missing, truncated, or tampered prompt sidecar, or a
 * malformed reference) the attempt must still end in a terminal state, so
 * write a guard failure from the plain fields of the raw payload and hand the
 * commit to the finalizer exactly like a normal failure.
 */
async function failUnresolvedPayload(raw, error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(message);
	const cwd = typeof raw?.cwd === "string" ? raw.cwd : undefined;
	const runId = typeof raw?.runId === "string" ? raw.runId : undefined;
	const attemptId = typeof raw?.attemptId === "string" ? raw.attemptId : undefined;
	if (cwd === undefined || runId === undefined || attemptId === undefined) {
		process.exit(1);
	}
	const runsDir = typeof raw?.input?.runsDir === "string" ? raw.input.runsDir : undefined;
	try {
		const worker = await processIdentity.captureProcessIdentity(process.pid);
		const store = await artifacts.createAttemptArtifactStore({ cwd, runId, attemptId, runsDir });
		const stderr = await store.writeTextArtifact("stderr", `${message}\n`);
		const status = executionAbort.signal.aborted ? "cancelled" : "failed";
		await store.writeResult({
			backend: raw.backend ?? "headless",
			status,
			failureKind: executionAbort.signal.aborted ? "user_cancelled" : "guard_failure",
			cwd,
			startedAt: raw.startedAt ?? new Date().toISOString(),
			completedAt: new Date().toISOString(),
			workspace: { mode: "shared", cwd },
			sandbox: { enabled: Boolean(raw?.input?.sandbox) },
			exitCode: null,
			signal: null,
			artifacts: [store.refFor("worker"), stderr],
			correlationId: raw?.input?.correlationId,
			metadata: { contextLengthExceeded: false },
		});
		spawnTerminalFinalizer({ ref: { cwd, runId, runsDir }, attemptId, status, worker, cwd });
	} catch (writeError) {
		console.error(writeError instanceof Error ? (writeError.stack ?? writeError.message) : String(writeError));
	}
	process.exit(1);
}

const payloadBytes = await readFile(payloadPath);
// The launch digest covers the payload file exactly as written. Prompt
// sidecars are bound through the size/SHA-256 references inside it and are
// verified before use, so resolving them here does not weaken the digest.
const launchPayloadSha256 = createHash("sha256").update(payloadBytes).digest("hex");
let rawPayload;
try {
	rawPayload = JSON.parse(payloadBytes.toString("utf8"));
} catch (error) {
	console.error(`durable worker payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
let payload;
try {
	payload = await payloadModule.resolveDurableWorkerPayload(rawPayload, payloadPath);
} catch (error) {
	await failUnresolvedPayload(rawPayload, error);
}
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
		const barrierV2 =
			input.durableLaunchBarrier.schema ===
			"pi-subagent-durable-launch-barrier-v2";
		const ack = barrierV2
			? await launchBarrier.awaitDurableLaunchBarrierV2({
					descriptor: input.durableLaunchBarrier,
					runId,
					attemptId,
					launchPayloadSha256,
					executionPlanSha256,
					workerProcessGroupId,
					signal: executionAbort.signal,
				})
			: await launchBarrier.awaitDurableLaunchBarrier({
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
		if (barrierV2) {
			if (executionAbort.signal.aborted) {
				const cancelled = new Error(
					"durable worker was cancelled after release acknowledgement",
				);
				cancelled.failureKind = "user_cancelled";
				throw cancelled;
			}
			await launchBarrier.assertDurableLaunchBarrierV2ExecutionAuthorized(
				input.durableLaunchBarrier,
				ack,
			);
			if (executionAbort.signal.aborted) {
				const cancelled = new Error(
					"durable worker was cancelled before prepared execution",
				);
				cancelled.failureKind = "user_cancelled";
				throw cancelled;
			}
		}
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
	const cancelled =
		executionAbort.signal.aborted ||
		launchBarrier.isDurableLaunchBarrierRevokedError?.(error) === true;
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
	spawnTerminalFinalizer({
		ref: runRef,
		attemptId,
		status: terminalResult.status,
		worker: workerIdentity,
		cwd,
	});
}
