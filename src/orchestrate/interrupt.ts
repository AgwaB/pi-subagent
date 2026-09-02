import {
	appendRunEvent,
	readRunRecord,
	recordInterruptRequest,
	type RunAttemptRecord,
	type RunRecord,
} from "../artifacts/index.ts";
import { resolveRunRef } from "./run-ref.ts";
import { isTerminalStatus } from "./status.ts";
import {
	type ProcessIdentity,
	verifyProcessIdentity,
} from "../process-identity.ts";

export interface InterruptRunOptions {
	cwd?: string;
	runId: string;
	runsDir?: string;
	attemptId?: string;
	/** @deprecated v1 compatibility alias. */
	taskId?: string;
	reason?: string;
	signal?: NodeJS.Signals;
	escalateAfterMs?: number;
	killAfterMs?: number;
}

export interface InterruptRunResult {
	status:
		| "interrupt-requested"
		| "not-found"
		| "already-terminal"
		| "unsupported";
	runId: string;
	signal: NodeJS.Signals;
	interruptedAttempts: string[];
	unsupportedAttempts: string[];
	/** @deprecated v1 compatibility alias. */
	interruptedTasks: string[];
	/** @deprecated v1 compatibility alias. */
	unsupportedTasks: string[];
	record: RunRecord | null;
}

interface VerifiedInterruptTarget {
	identity: ProcessIdentity;
	target: number;
}

function interruptIdentities(attempt: RunAttemptRecord): ProcessIdentity[] {
	const identities: ProcessIdentity[] = [];
	if (
		attempt.process?.pid !== undefined &&
		attempt.process.processGroupId !== undefined &&
		attempt.process.processBirthIdentity !== undefined
	)
		identities.push({
			pid: attempt.process.pid,
			processGroupId: attempt.process.processGroupId,
			birthIdentity: attempt.process.processBirthIdentity,
		});
	if (
		attempt.process?.workerPid !== undefined &&
		attempt.process.workerProcessGroupId !== undefined &&
		attempt.process.workerProcessBirthIdentity !== undefined
	)
		identities.push({
			pid: attempt.process.workerPid,
			processGroupId: attempt.process.workerProcessGroupId,
			birthIdentity: attempt.process.workerProcessBirthIdentity,
		});
	return identities;
}

async function verifyInterruptTargets(
	attempt: RunAttemptRecord,
): Promise<VerifiedInterruptTarget[]> {
	const targets = new Map<number, VerifiedInterruptTarget>();
	for (const identity of interruptIdentities(attempt)) {
		if ((await verifyProcessIdentity(identity)) !== "alive") continue;
		const target =
			process.platform === "win32" ||
			identity.processGroupId !== identity.pid
				? identity.pid
				: -identity.processGroupId;
		targets.set(target, { identity, target });
	}
	return [...targets.values()];
}

async function signalVerifiedTargets(
	targets: readonly VerifiedInterruptTarget[],
	signal: NodeJS.Signals,
): Promise<boolean> {
	let signalled = false;
	for (const { identity, target } of targets) {
		if ((await verifyProcessIdentity(identity)) !== "alive") continue;
		try {
			process.kill(target, signal);
			signalled = true;
		} catch (error) {
			// ESRCH: already gone. EPERM: macOS refuses signals to a group that
			// holds only an unreaped zombie; treat the target as not signalled so
			// escalation and liveness checks decide instead of failing the call.
			const code = (error as NodeJS.ErrnoException)?.code;
			if (code !== "ESRCH" && code !== "EPERM") throw error;
		}
	}
	return signalled;
}

function runningAttempts(
	record: RunRecord,
	targetAttemptId?: string,
): RunAttemptRecord[] {
	return record.attempts.filter((attempt) => {
		if (targetAttemptId !== undefined && attempt.attemptId !== targetAttemptId)
			return false;
		return attempt.status === "running" || attempt.status === "pending";
	});
}

async function escalate(
	options: InterruptRunOptions,
	signal: NodeJS.Signals,
	verifiedTargets: ReadonlyMap<string, readonly VerifiedInterruptTarget[]>,
): Promise<void> {
	const ref = await resolveRunRef(options);
	const record = await readRunRecord(ref).catch(() => null);
	if (record === null || isTerminalStatus(record.status)) return;
	for (const attempt of runningAttempts(
		record,
		options.attemptId ?? options.taskId,
	))
		await signalVerifiedTargets(
			verifiedTargets.get(attempt.attemptId) ?? [],
			signal,
		);
	await appendRunEvent(ref, {
		type: "run.interrupt_requested",
		status: record.status,
		message: `interrupt escalation ${signal}`,
		data: { signal },
	}).catch(() => undefined);
}

function result(
	status: InterruptRunResult["status"],
	runId: string,
	signal: NodeJS.Signals,
	interruptedAttempts: string[],
	unsupportedAttempts: string[],
	record: RunRecord | null,
): InterruptRunResult {
	return {
		status,
		runId,
		signal,
		interruptedAttempts,
		unsupportedAttempts,
		interruptedTasks: interruptedAttempts,
		unsupportedTasks: unsupportedAttempts,
		record,
	};
}

export async function interruptRun(
	options: InterruptRunOptions,
): Promise<InterruptRunResult> {
	// SIGTERM is the graceful stop for a headless Pi child: it aborts the
	// running tool, kills the tool's subprocesses, and exits. SIGINT makes Pi
	// die immediately and orphans tool subprocesses (observed on Pi 0.84).
	const signal = options.signal ?? "SIGTERM";
	const ref = await resolveRunRef(options);
	const record = await readRunRecord(ref);
	if (record === null) {
		return result("not-found", options.runId, signal, [], [], null);
	}
	if (isTerminalStatus(record.status)) {
		return result("already-terminal", options.runId, signal, [], [], record);
	}

	const candidates = runningAttempts(
		record,
		options.attemptId ?? options.taskId,
	);
	const interruptedAttempts: string[] = [];
	const unsupportedAttempts: string[] = [];
	const verifiedTargets = new Map<string, VerifiedInterruptTarget[]>();
	for (const attempt of candidates) {
		const targets = await verifyInterruptTargets(attempt);
		verifiedTargets.set(attempt.attemptId, targets);
		if (await signalVerifiedTargets(targets, signal))
			interruptedAttempts.push(attempt.attemptId);
		else unsupportedAttempts.push(attempt.attemptId);
	}

	if (interruptedAttempts.length === 0) {
		await appendRunEvent(ref, {
			type: "run.interrupt_requested",
			status: record.status,
			message: "interrupt unsupported: no interruptable process metadata",
			data: { signal, unsupportedAttempts },
		});
		return result(
			"unsupported",
			options.runId,
			signal,
			interruptedAttempts,
			unsupportedAttempts,
			record,
		);
	}

	const updated = await recordInterruptRequest(
		ref,
		signal,
		options.reason ?? null,
	);
	await appendRunEvent(ref, {
		type: "run.interrupt_requested",
		status: updated.status,
		message: `interrupt requested with ${signal}`,
		data: {
			signal,
			interruptedAttempts,
			unsupportedAttempts,
			reason: options.reason ?? null,
		},
	});

	const termDelay = options.escalateAfterMs ?? 1_000;
	const killDelay = options.killAfterMs ?? 3_000;
	setTimeout(
		() => void escalate(ref, "SIGTERM", verifiedTargets),
		termDelay,
	).unref?.();
	setTimeout(
		() => void escalate(ref, "SIGKILL", verifiedTargets),
		killDelay,
	).unref?.();

	return result(
		"interrupt-requested",
		options.runId,
		signal,
		interruptedAttempts,
		unsupportedAttempts,
		updated,
	);
}
