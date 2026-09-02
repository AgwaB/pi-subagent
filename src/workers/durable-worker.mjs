#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
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

// Primitive signal handling from the very first statement: a stop that lands
// while the runtime modules are still importing is remembered and replayed
// once the real cancellation path exists, instead of killing the worker
// before it can record anything.
let earlySignal;
const rememberEarlySignal = (signal) => {
	earlySignal ??= signal;
};
process.on("SIGINT", () => rememberEarlySignal("SIGINT"));
process.on("SIGTERM", () => rememberEarlySignal("SIGTERM"));

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

// Keep handling repeated signals: escalation re-sends SIGTERM, and a `once`
// handler would let the second delivery kill the worker before it records a
// terminal result. A signal remembered during module import is replayed now.
process.on("SIGINT", () => requestCancel("SIGINT"));
process.on("SIGTERM", () => requestCancel("SIGTERM"));
if (earlySignal !== undefined) requestCancel(earlySignal);

/**
 * The payload lives at `<runsDir>/<runId>/attempts/<attemptId>/worker.json`
 * and the worker is spawned with the run's cwd, so the run/attempt reference
 * can be recovered from the path alone when the payload itself is unreadable.
 * Returns undefined when the path does not have that shape.
 */
async function referenceFromPayloadPath(path) {
	const attemptDir = dirname(path);
	const attemptsDir = dirname(attemptDir);
	const runDir = dirname(attemptsDir);
	const runsDir = dirname(runDir);
	if (basename(attemptsDir) !== "attempts") return undefined;
	const runId = basename(runDir);
	const attemptId = basename(attemptDir);
	const safe = /^[A-Za-z0-9._-]+$/u;
	if (!safe.test(runId) || !safe.test(attemptId)) return undefined;
	// The registry stores the logical cwd (it may be a symlinked spelling of
	// process.cwd()); use it so the terminal commit matches the record.
	let record;
	try {
		record = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
	} catch {
		record = undefined;
	}
	const cwd =
		typeof record?.cwd === "string" && record.cwd.length > 0 ? record.cwd : process.cwd();
	const runsDirRelative =
		typeof record?.runsDir === "string" && record.runsDir.length > 0
			? record.runsDir
			: relative(cwd, runsDir);
	if (runsDirRelative.startsWith("..") || isAbsolute(runsDirRelative)) return undefined;
	return { cwd, runId, attemptId, runsDir: runsDirRelative };
}

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
	// Prefer the payload's own plain fields; fall back to the reference encoded
	// in the payload path when the payload is unreadable or malformed.
	const fromPath = await referenceFromPayloadPath(payloadPath);
	const cwd = typeof raw?.cwd === "string" ? raw.cwd : fromPath?.cwd;
	const runId = typeof raw?.runId === "string" ? raw.runId : fromPath?.runId;
	const attemptId = typeof raw?.attemptId === "string" ? raw.attemptId : fromPath?.attemptId;
	if (cwd === undefined || runId === undefined || attemptId === undefined) {
		process.exit(1);
	}
	const runsDir =
		typeof raw?.input?.runsDir === "string" ? raw.input.runsDir : fromPath?.runsDir;
	try {
		const worker = await processIdentity.captureProcessIdentity(process.pid);
		const store = await artifacts.createAttemptArtifactStore({ cwd, runId, attemptId, runsDir });
		const stderr = await store.writeTextArtifact("stderr", `${message}\n`);
		const status = executionAbort.signal.aborted ? "cancelled" : "failed";
		await store.writeResult({
			backend: raw?.backend ?? "headless",
			status,
			failureKind: executionAbort.signal.aborted ? "user_cancelled" : "guard_failure",
			cwd,
			startedAt: raw?.startedAt ?? new Date().toISOString(),
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

let payloadBytes;
try {
	payloadBytes = await readFile(payloadPath);
} catch (error) {
	await failUnresolvedPayload(undefined, new Error(`durable worker payload could not be read: ${error instanceof Error ? error.message : String(error)}`));
}
// The launch digest covers the payload file exactly as written. Prompt
// sidecars are bound through the size/SHA-256 references inside it and are
// verified before use, so resolving them here does not weaken the digest.
const launchPayloadSha256 = createHash("sha256").update(payloadBytes).digest("hex");
let rawPayload;
try {
	rawPayload = JSON.parse(payloadBytes.toString("utf8"));
} catch (error) {
	await failUnresolvedPayload(undefined, new Error(`durable worker payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`));
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
