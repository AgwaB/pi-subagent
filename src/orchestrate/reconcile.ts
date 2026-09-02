import { readFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import {
	appendRunEvent,
	commitAttemptResultIfActive,
	createAttemptArtifactStore,
	readRunRecord,
	RESULT_SCHEMA_VERSION,
	type ResultEnvelope,
	type RunAttemptRecord,
	type RunRef,
	type RunRecord,
} from "../artifacts/index.ts";
import { resolveRunRef } from "./run-ref.ts";
import { terminatePrivateTmuxServer } from "../runners/tmux-control.ts";
import {
	inspectProcessGroup,
	type ProcessIdentity,
	verifyProcessIdentity,
} from "../process-identity.ts";
import { isTerminalStatus } from "./status.ts";

export interface ReconcileSubagentRunOptions extends RunRef {
	staleAfterMs?: number;
	/** Refuse every mutation unless this is still the selected attempt. */
	expectedAttemptId?: string;
}

export interface ReconcileSubagentRunResult {
	status:
		| "not-found"
		| "already-terminal"
		| "running"
		| "superseded"
		| "cleanup-blocked"
		| "committed-result"
		| "marked-stale"
		| "marked-cancelled";
	runId: string;
	record: RunRecord | null;
	superseded?: {
		expectedAttemptId: string;
		currentAttemptId: string | null;
	};
	cleanupBlocked?: {
		reason:
			| "terminal-record-active-attempt"
			| "terminal-attempt-ownership"
			| "missing-active-attempt"
			| "inactive-attempt-ownership"
			| "terminal-result-ownership"
			| "stale-attempt-ownership";
		attemptIds: string[];
	};
}

function cleanupBlockedResult(
	runId: string,
	record: RunRecord,
	reason: NonNullable<
		ReconcileSubagentRunResult["cleanupBlocked"]
	>["reason"],
	attemptIds: readonly string[],
): ReconcileSubagentRunResult {
	return {
		status: "cleanup-blocked",
		runId,
		record,
		cleanupBlocked: {
			reason,
			attemptIds: [...new Set(attemptIds)],
		},
	};
}

export async function cleanupInactiveAttemptOwnership(
	options: ReconcileSubagentRunOptions,
	activeAttemptId: string,
): Promise<boolean> {
	const ref = await resolveRunRef(options);
	const record = await readRunRecord(ref);
	if (record === null || record.activeAttemptId !== activeAttemptId) return false;
	let safe = true;
	for (const attempt of record.attempts) {
		if (attempt.attemptId === activeAttemptId) continue;
		safe = (await terminateAttemptOwnership(attempt)) && safe;
	}
	const current = await readRunRecord(ref);
	return safe && current?.activeAttemptId === activeAttemptId;
}

function safeArtifactPath(attempt: RunAttemptRecord): string | null {
	if (attempt.resultPath === undefined || attempt.artifactCwd === undefined)
		return null;
	if (
		isAbsolute(attempt.resultPath) ||
		attempt.resultPath.split("/").includes("..")
	)
		return null;
	return resolve(attempt.artifactCwd, attempt.resultPath.split("/").join(sep));
}

async function readAttemptResult(
	attempt: RunAttemptRecord,
	runId: string,
): Promise<ResultEnvelope | null> {
	const path = safeArtifactPath(attempt);
	if (path === null) return null;
	try {
		const result = JSON.parse(await readFile(path, "utf8")) as Partial<ResultEnvelope>;
		if (
			result.schemaVersion !== RESULT_SCHEMA_VERSION ||
			result.runId !== runId ||
			result.attemptId !== attempt.attemptId ||
			typeof result.cwd !== "string" ||
			typeof result.backend !== "string" ||
			typeof result.status !== "string" ||
			typeof result.startedAt !== "string"
		)
			return null;
		return result as ResultEnvelope;
	} catch {
		return null;
	}
}

function processErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

interface OwnedProcessIdentitySet {
	identities: ProcessIdentity[];
	incomplete: boolean;
}

function ownedProcessIdentities(
	attempt: RunAttemptRecord,
): OwnedProcessIdentitySet {
	const candidates = [
		{
			pid: attempt.process?.workerPid,
			processGroupId: attempt.process?.workerProcessGroupId,
			birthIdentity: attempt.process?.workerProcessBirthIdentity,
		},
		{
			pid: attempt.process?.pid,
			processGroupId: attempt.process?.processGroupId,
			birthIdentity: attempt.process?.processBirthIdentity,
		},
		{
			pid: attempt.tmux?.launchPid ?? undefined,
			processGroupId: attempt.tmux?.launchProcessGroupId ?? undefined,
			birthIdentity: attempt.tmux?.launchProcessBirthIdentity ?? undefined,
		},
	];
	const identities = new Map<string, ProcessIdentity>();
	const identityKeysByPid = new Map<number, string>();
	let incomplete = false;
	for (const candidate of candidates) {
		const values = [
			candidate.pid,
			candidate.processGroupId,
			candidate.birthIdentity,
		];
		if (values.every((value) => value === undefined)) continue;
		if (
			typeof candidate.pid !== "number" ||
			!Number.isSafeInteger(candidate.pid) ||
			candidate.pid <= 0 ||
			typeof candidate.processGroupId !== "number" ||
			!Number.isSafeInteger(candidate.processGroupId) ||
			candidate.processGroupId <= 0 ||
			typeof candidate.birthIdentity !== "string" ||
			candidate.birthIdentity.length === 0
		) {
			incomplete = true;
			continue;
		}
		const key = `${candidate.pid}:${candidate.processGroupId}:${candidate.birthIdentity}`;
		const priorKey = identityKeysByPid.get(candidate.pid);
		if (priorKey !== undefined && priorKey !== key) incomplete = true;
		identityKeysByPid.set(candidate.pid, key);
		identities.set(key, {
			pid: candidate.pid,
			processGroupId: candidate.processGroupId,
			birthIdentity: candidate.birthIdentity,
		});
	}
	return { identities: [...identities.values()], incomplete };
}

function signalOwnedProcess(
	identity: ProcessIdentity,
	signal: NodeJS.Signals,
): void {
	const target =
		process.platform === "win32" ||
		identity.pid !== identity.processGroupId
			? identity.pid
			: -identity.processGroupId;
	try {
		process.kill(target, signal);
	} catch (error) {
		if (processErrorCode(error) !== "ESRCH") throw error;
	}
}

async function ownerProcessAlive(attempt: RunAttemptRecord): Promise<boolean> {
	const { identities } = ownedProcessIdentities(attempt);
	const ownerPid = attempt.process?.workerPid ?? attempt.process?.pid;
	const owner = identities.find((identity) => identity.pid === ownerPid);
	return owner !== undefined && (await verifyProcessIdentity(owner)) === "alive";
}

async function terminateOwnedProcesses(
	attempt: RunAttemptRecord,
): Promise<boolean> {
	const identitySet = ownedProcessIdentities(attempt);
	const { identities } = identitySet;
	if (identities.length === 0) return !identitySet.incomplete;
	const verifiedIdentities = identities;
	const authorizedGroups = new Set<number>();
	const recordedLeaderGroups = new Set(
		verifiedIdentities
			.filter((identity) => identity.pid === identity.processGroupId)
			.map((identity) => identity.processGroupId),
	);

	async function inspectIdentities(): Promise<{
		alive: ProcessIdentity[];
		unsafe: boolean;
	}> {
		const alive: ProcessIdentity[] = [];
		let unsafe = false;
		for (const identity of verifiedIdentities) {
			const status = await verifyProcessIdentity(identity);
			if (status === "mismatch" || status === "unknown") unsafe = true;
			if (status === "alive") {
				alive.push(identity);
				if (
					process.platform !== "win32" &&
					identity.pid === identity.processGroupId
				)
					authorizedGroups.add(identity.processGroupId);
			}
		}
		return { alive, unsafe };
	}

	function groupsDrained(): boolean | undefined {
		let unknown = false;
		for (const processGroupId of recordedLeaderGroups) {
			const status = inspectProcessGroup(processGroupId);
			if (status === "alive") return false;
			if (status === "unknown") unknown = true;
		}
		return unknown ? undefined : true;
	}

	function signalAuthorizedGroups(signal: NodeJS.Signals): void {
		for (const processGroupId of authorizedGroups) {
			try {
				process.kill(-processGroupId, signal);
			} catch (error) {
				// EPERM (macOS, zombie-only group) is not proof the group survived;
				// the liveness loop that follows decides whether cleanup is blocked.
				const code = processErrorCode(error);
				if (code !== "ESRCH" && code !== "EPERM") throw error;
			}
		}
	}

	let unsafe = identitySet.incomplete;
	const initiallyInspected = await inspectIdentities();
	unsafe ||= initiallyInspected.unsafe;
	for (const identity of initiallyInspected.alive)
		signalOwnedProcess(identity, "SIGTERM");
	for (let attemptIndex = 0; attemptIndex < 10; attemptIndex += 1) {
		const inspected = await inspectIdentities();
		unsafe ||= inspected.unsafe;
		const drained = groupsDrained();
		if (inspected.alive.length === 0 && drained === true) return !unsafe;
		if (drained === undefined) unsafe = true;
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
	}
	const beforeKill = await inspectIdentities();
	unsafe ||= beforeKill.unsafe;
	for (const identity of beforeKill.alive)
		signalOwnedProcess(identity, "SIGKILL");
	signalAuthorizedGroups("SIGKILL");
	for (let attemptIndex = 0; attemptIndex < 10; attemptIndex += 1) {
		const inspected = await inspectIdentities();
		unsafe ||= inspected.unsafe;
		const drained = groupsDrained();
		if (inspected.alive.length === 0 && drained === true) return !unsafe;
		if (drained === undefined) unsafe = true;
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
	}
	const remaining = await inspectIdentities();
	return (
		remaining.alive.length === 0 &&
		groupsDrained() === true &&
		!unsafe &&
		!remaining.unsafe
	);
}

function heartbeatFresh(
	attempt: RunAttemptRecord,
	staleAfterMs: number,
): boolean {
	if (attempt.heartbeatAt === undefined) return false;
	const time = Date.parse(attempt.heartbeatAt);
	return Number.isFinite(time) && Date.now() - time <= staleAfterMs;
}

async function terminateTmuxServer(
	tmux: RunAttemptRecord["tmux"],
): Promise<boolean> {
	if (tmux?.socketPath === undefined) return true;
	try {
		return await terminatePrivateTmuxServer(tmux);
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"terminalBlocked" in error &&
			(error as { terminalBlocked?: unknown }).terminalBlocked === true
		)
			return false;
		throw error;
	}
}

async function terminateAttemptOwnership(
	attempt: RunAttemptRecord,
	tmuxFallback?: RunAttemptRecord["tmux"],
): Promise<boolean> {
	const processSafe = await terminateOwnedProcesses(attempt);
	const tmuxSafe = await terminateTmuxServer(attempt.tmux ?? tmuxFallback);
	return processSafe && tmuxSafe;
}

function activeAttempt(record: RunRecord): RunAttemptRecord | undefined {
	if (record.activeAttemptId !== null)
		return record.attempts.find(
			(attempt) => attempt.attemptId === record.activeAttemptId,
		);
	if (record.latestAttemptId !== null)
		return record.attempts.find(
			(attempt) => attempt.attemptId === record.latestAttemptId,
		);
	return record.attempts.at(-1);
}

export async function reconcileSubagentRun(
	options: ReconcileSubagentRunOptions,
): Promise<ReconcileSubagentRunResult> {
	const staleAfterMs = options.staleAfterMs ?? 30_000;
	const ref = await resolveRunRef(options);
	const record = await readRunRecord(ref);
	if (record === null)
		return { status: "not-found", runId: options.runId, record: null };
	if (options.expectedAttemptId !== undefined) {
		const currentAttemptId =
			record.activeAttemptId ?? record.latestAttemptId;
		if (currentAttemptId !== options.expectedAttemptId)
			return {
				status: "superseded",
				runId: options.runId,
				record,
				superseded: {
					expectedAttemptId: options.expectedAttemptId,
					currentAttemptId,
				},
			};
	}
	if (isTerminalStatus(record.status)) {
		if (record.activeAttemptId !== null) {
			const inconsistentActiveAttempt = record.attempts.find(
				(attempt) => attempt.attemptId === record.activeAttemptId,
			);
			const ownerPid =
				inconsistentActiveAttempt?.process?.workerPid ??
				inconsistentActiveAttempt?.process?.pid;
			if (
				inconsistentActiveAttempt !== undefined &&
				((await ownerProcessAlive(inconsistentActiveAttempt)) ||
					(ownerPid === undefined &&
						heartbeatFresh(inconsistentActiveAttempt, staleAfterMs)))
			)
				return { status: "running", runId: options.runId, record };
			return cleanupBlockedResult(
				options.runId,
				record,
				"terminal-record-active-attempt",
				[record.activeAttemptId],
			);
		}
		let terminalSafe = true;
		const blockedAttemptIds: string[] = [];
		for (const terminalAttempt of record.attempts)
			if (!(await terminateAttemptOwnership(terminalAttempt))) {
				terminalSafe = false;
				blockedAttemptIds.push(terminalAttempt.attemptId);
			}
		if (!terminalSafe)
			return cleanupBlockedResult(
				options.runId,
				record,
				"terminal-attempt-ownership",
				blockedAttemptIds,
			);
		return { status: "already-terminal", runId: options.runId, record };
	}

	const attempt = activeAttempt(record);
	if (attempt === undefined)
		return cleanupBlockedResult(
			options.runId,
			record,
			"missing-active-attempt",
			record.activeAttemptId !== null
				? [record.activeAttemptId]
				: record.latestAttemptId !== null
					? [record.latestAttemptId]
					: [],
		);
	let inactiveSafe = true;
	const blockedInactiveAttemptIds: string[] = [];
	for (const inactiveAttempt of record.attempts) {
		if (inactiveAttempt.attemptId === attempt.attemptId) continue;
		if (!(await terminateAttemptOwnership(inactiveAttempt))) {
			inactiveSafe = false;
			blockedInactiveAttemptIds.push(inactiveAttempt.attemptId);
		}
	}
	if (!inactiveSafe)
		return cleanupBlockedResult(
			options.runId,
			record,
			"inactive-attempt-ownership",
			blockedInactiveAttemptIds,
		);

	const result = await readAttemptResult(attempt, options.runId);
	if (
		result !== null &&
		result.attemptId === attempt.attemptId &&
		isTerminalStatus(result.status)
	) {
		if (await ownerProcessAlive(attempt))
			return { status: "running", runId: options.runId, record };
		if (!(await terminateAttemptOwnership(attempt, result.tmux)))
			return cleanupBlockedResult(
				options.runId,
				record,
				"terminal-result-ownership",
				[attempt.attemptId],
			);
		const committed = await commitAttemptResultIfActive(ref, result);
		await appendRunEvent(ref, {
			type: "reconcile.completed",
			attemptId: attempt.attemptId,
			status: result.status,
			message: committed.committed
				? "committed terminal attempt result"
				: "terminal attempt result was stale",
		}).catch(() => undefined);
		return {
			status: committed.committed ? "committed-result" : "running",
			runId: options.runId,
			record: committed.record,
		};
	}

	const ownerPid = attempt.process?.workerPid ?? attempt.process?.pid;
	if (
		(await ownerProcessAlive(attempt)) ||
		(ownerPid === undefined && heartbeatFresh(attempt, staleAfterMs))
	)
		return { status: "running", runId: options.runId, record };

	if (!(await terminateAttemptOwnership(attempt)))
		return cleanupBlockedResult(
			options.runId,
			record,
			"stale-attempt-ownership",
			[attempt.attemptId],
		);

	const interrupted = record.interrupt !== undefined;
	const cleanupStatus =
		attempt.workspace?.mode === "worktree" ? "kept" : "not-needed";
	const completedAt = new Date();
	const artifactCwd = attempt.artifactCwd ?? record.cwd;
	const store = await createAttemptArtifactStore({
		...ref,
		cwd: artifactCwd,
		attemptId: attempt.attemptId,
	});
	const stderr = await store.writeTextArtifact(
		"stderr",
		interrupted
			? "interrupted attempt exited without a result; marked cancelled\n"
			: "active attempt is stale/orphaned\n",
	);
	const terminalResult = await store.writeResult({
		backend: attempt.backend ?? record.backend ?? "headless",
		status: interrupted ? "cancelled" : "failed",
		failureKind: interrupted ? "user_cancelled" : "stale",
		cwd: artifactCwd,
		startedAt: attempt.startedAt,
		completedAt,
		workspace: {
			...(attempt.workspace ?? {
				mode: "shared",
				cwd: artifactCwd,
				worktreePath: null,
			}),
			worktreeCleanupStatus: cleanupStatus,
		},
		sandbox: result?.sandbox ?? { enabled: false },
		exitCode: null,
		signal: interrupted ? (record.interrupt?.signal ?? null) : null,
		artifacts: [...(result?.artifacts ?? []), stderr],
		...(attempt.tmux === undefined ? {} : { tmux: attempt.tmux }),
		metadata: result?.metadata ?? { contextLengthExceeded: false },
	});
	const committed = await commitAttemptResultIfActive(ref, terminalResult);
	if (!committed.committed)
		return {
			status: "running",
			runId: options.runId,
			record: committed.record,
		};
	const updated = committed.record;
	await appendRunEvent(ref, {
		type: interrupted ? "reconcile.completed" : "reconcile.failed",
		attemptId: attempt.attemptId,
		status: interrupted ? "cancelled" : "failed",
		message: interrupted
			? "interrupted attempt exited without a result; marked cancelled"
			: "active attempt is stale/orphaned",
		data: interrupted
			? { failureKind: "user_cancelled", interrupt: record.interrupt }
			: { failureKind: "stale" },
	}).catch(() => undefined);
	return {
		status: interrupted ? "marked-cancelled" : "marked-stale",
		runId: options.runId,
		record: updated,
	};
}
