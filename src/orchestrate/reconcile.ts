import { readFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import {
	appendRunEvent,
	commitAttemptResultIfActive,
	readRunRecord,
	upsertRunAttempt,
	type ResultEnvelope,
	type RunAttemptRecord,
	type RunRef,
	type RunRecord,
} from "../artifacts/index.ts";
import { resolveRunRef } from "./run-ref.ts";
import { isTerminalStatus } from "./status.ts";

export interface ReconcileSubagentRunOptions extends RunRef {
	staleAfterMs?: number;
}

export interface ReconcileSubagentRunResult {
	status:
		| "not-found"
		| "already-terminal"
		| "running"
		| "committed-result"
		| "marked-stale";
	runId: string;
	record: RunRecord | null;
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
): Promise<ResultEnvelope | null> {
	const path = safeArtifactPath(attempt);
	if (path === null) return null;
	try {
		return JSON.parse(await readFile(path, "utf8")) as ResultEnvelope;
	} catch {
		return null;
	}
}

function pidAlive(pid: number | undefined): boolean {
	if (pid === undefined) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function processAlive(attempt: RunAttemptRecord): boolean {
	return pidAlive(attempt.process?.pid) || pidAlive(attempt.process?.workerPid);
}

function heartbeatFresh(
	attempt: RunAttemptRecord,
	staleAfterMs: number,
): boolean {
	if (attempt.heartbeatAt === undefined) return false;
	const time = Date.parse(attempt.heartbeatAt);
	return Number.isFinite(time) && Date.now() - time <= staleAfterMs;
}

function activeAttempt(record: RunRecord): RunAttemptRecord | undefined {
	const activeId =
		record.activeAttemptId ?? record.latestAttemptId ?? undefined;
	return activeId === undefined
		? record.attempts.at(-1)
		: (record.attempts.find((attempt) => attempt.attemptId === activeId) ??
				record.attempts.at(-1));
}

export async function reconcileSubagentRun(
	options: ReconcileSubagentRunOptions,
): Promise<ReconcileSubagentRunResult> {
	const staleAfterMs = options.staleAfterMs ?? 30_000;
	const ref = await resolveRunRef(options);
	const record = await readRunRecord(ref);
	if (record === null)
		return { status: "not-found", runId: options.runId, record: null };
	if (isTerminalStatus(record.status))
		return { status: "already-terminal", runId: options.runId, record };

	const attempt = activeAttempt(record);
	if (attempt === undefined)
		return { status: "running", runId: options.runId, record };

	const result = await readAttemptResult(attempt);
	if (
		result !== null &&
		result.attemptId === attempt.attemptId &&
		isTerminalStatus(result.status)
	) {
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

	if (processAlive(attempt) || heartbeatFresh(attempt, staleAfterMs)) {
		return { status: "running", runId: options.runId, record };
	}

	const updated = await upsertRunAttempt({
		...ref,
		attemptId: attempt.attemptId,
		status: "failed",
		backend: attempt.backend,
		failureKind: "stale",
		startedAt: attempt.startedAt,
		completedAt: new Date(),
		activate: true,
	});
	await appendRunEvent(ref, {
		type: "reconcile.failed",
		attemptId: attempt.attemptId,
		status: "failed",
		message: "active attempt is stale/orphaned",
	}).catch(() => undefined);
	return { status: "marked-stale", runId: options.runId, record: updated };
}
