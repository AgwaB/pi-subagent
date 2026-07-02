import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	readRunEvents,
	readRunRecord,
	relativeRunEventsPath,
	relativeRunRecordPath,
	type ArtifactRef,
	type CompletionMetadata,
	type ResultEnvelope,
	type ResultMetadata,
	type RunAttemptRecord,
	type RunEvent,
	type RunRecord,
} from "../artifacts/index.ts";
import {
	STATUSES,
	type AsyncDependency,
	type ExecutionMode,
	type FailureKind,
	type ResolvedBackend,
	type Status,
} from "../core/constants.ts";
import { resolveRunRef } from "./run-ref.ts";

const DEFAULT_RUNS_DIR = ".pi/agent/runs";
const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const EVENT_TAIL_LIMIT = 20;
const CHILD_EVENT_SCAN_LIMIT = Number.POSITIVE_INFINITY;

export interface RunStatusRef {
	runId: string;
	attemptId?: string;
	/** @deprecated v1 compatibility only. */
	taskId?: string;
	cwd?: string;
	runsDir?: string;
}

export interface RunLogRef extends ArtifactRef {
	type: "stdout" | "stderr" | "output" | "result";
	artifactCwd?: string;
}

export interface RunAttemptStatusSnapshot {
	attemptId: string;
	status: Status;
	backend: ResolvedBackend | null;
	failureKind: FailureKind | null;
	startedAt: string;
	completedAt: string | null;
	heartbeatAt?: string;
	resultPath: string | null;
	outputPath: string | null;
	stdoutPath: string | null;
	stderrPath: string | null;
	artifactCwd?: string;
	pid?: number;
	processGroupId?: number;
	workerPid?: number;
	workerProcessGroupId?: number;
}

export type RunTaskStatusSnapshot = RunAttemptStatusSnapshot & {
	taskId?: string;
};

export interface RunChildFailureSummary {
	childRunId: string;
	workflowRunId?: string;
	taskId?: string;
	status: Status;
	failureKind: FailureKind | string | null;
	message?: string;
	timestamp: string;
}

export interface RunChildSummary {
	total: number;
	pending: number;
	running: number;
	completed: number;
	failed: number;
	cancelled: number;
	activeChildRunIds: string[];
	latestFailure: RunChildFailureSummary | null;
	worstDescendantStatus: Status | null;
}

export interface RunStatusSnapshot {
	runId: string;
	attemptId: string;
	/** @deprecated v1 compatibility only. */
	taskId?: string;
	correlationId?: string;
	backend: ResolvedBackend;
	status: Status;
	failureKind: FailureKind | null;
	startedAt: string;
	completedAt: string | null;
	durationMs: number | null;
	logs: RunLogRef[];
	resultPath: string | null;
	completion?: CompletionMetadata;
	metadata: ResultMetadata;
	mode?: ExecutionMode;
	dependency?: AsyncDependency | null;
	registryPath?: string;
	eventsPath?: string;
	eventTail?: RunEvent[];
	childSummary?: RunChildSummary;
	attempts?: RunAttemptStatusSnapshot[];
	/** @deprecated v1 compatibility only. */
	tasks?: RunTaskStatusSnapshot[];
}

export interface RunLogsSnapshot extends RunStatusSnapshot {
	logText: Partial<Record<RunLogRef["type"] | "events", string>>;
}

export interface WaitForRunOptions extends RunStatusRef {
	timeoutMs?: number;
	pollIntervalMs?: number;
}

export interface WaitForRunResult {
	status: "completed" | "timeout";
	snapshot: RunStatusSnapshot | null;
}

function assertSafeId(name: string, value: string): void {
	if (!SAFE_ID_PATTERN.test(value)) {
		throw new Error(
			`${name} must contain only letters, numbers, dots, underscores, or dashes.`,
		);
	}
}

function isInsideOrEqual(parent: string, child: string): boolean {
	const childRelative = relative(parent, child);
	return (
		childRelative === "" ||
		(!childRelative.startsWith("..") && !isAbsolute(childRelative))
	);
}

function pathsFor(ref: RunStatusRef): {
	cwd: string;
	runsDir: string;
	runDir: string;
} {
	assertSafeId("runId", ref.runId);
	if (ref.attemptId !== undefined) assertSafeId("attemptId", ref.attemptId);
	if (ref.taskId !== undefined) assertSafeId("taskId", ref.taskId);
	const cwd = resolve(ref.cwd ?? process.cwd());
	const runsDir = resolve(cwd, ref.runsDir ?? DEFAULT_RUNS_DIR);
	if (!isInsideOrEqual(cwd, runsDir)) {
		throw new Error(
			"runsDir must be inside cwd so lifecycle refs remain relative and safe.",
		);
	}
	return { cwd, runsDir, runDir: join(runsDir, ref.runId) };
}

function safeArtifactPath(
	cwd: string,
	artifact: Pick<RunLogRef, "path" | "artifactCwd">,
): string {
	if (isAbsolute(artifact.path) || artifact.path.split("/").includes(".."))
		throw new Error("artifact path must be a safe relative path.");
	const artifactCwd = resolve(artifact.artifactCwd ?? cwd);
	const path = resolve(artifactCwd, artifact.path.split("/").join(sep));
	if (!isInsideOrEqual(artifactCwd, path))
		throw new Error("artifact path must stay inside its artifact cwd.");
	return path;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function artifactFromAttempt(
	attempt: RunAttemptRecord,
	type: RunLogRef["type"],
	path: string | undefined,
): RunLogRef | null {
	if (path === undefined) return null;
	return { type, path, artifactCwd: attempt.artifactCwd };
}

function attemptSnapshot(attempt: RunAttemptRecord): RunAttemptStatusSnapshot {
	return {
		attemptId: attempt.attemptId,
		status: attempt.status,
		backend: attempt.backend ?? null,
		failureKind: attempt.failureKind,
		startedAt: attempt.startedAt,
		completedAt: attempt.completedAt,
		...(attempt.heartbeatAt === undefined
			? {}
			: { heartbeatAt: attempt.heartbeatAt }),
		resultPath: attempt.resultPath ?? null,
		outputPath: attempt.outputPath ?? null,
		stdoutPath: attempt.stdoutPath ?? null,
		stderrPath: attempt.stderrPath ?? null,
		...(attempt.artifactCwd === undefined
			? {}
			: { artifactCwd: attempt.artifactCwd }),
		...(attempt.process?.pid === undefined ? {} : { pid: attempt.process.pid }),
		...(attempt.process?.processGroupId === undefined
			? {}
			: { processGroupId: attempt.process.processGroupId }),
		...(attempt.process?.workerPid === undefined
			? {}
			: { workerPid: attempt.process.workerPid }),
		...(attempt.process?.workerProcessGroupId === undefined
			? {}
			: { workerProcessGroupId: attempt.process.workerProcessGroupId }),
	};
}

function resultLogs(result: ResultEnvelope): RunLogRef[] {
	return result.artifacts
		.filter(
			(artifact): artifact is RunLogRef =>
				artifact.type === "stdout" ||
				artifact.type === "stderr" ||
				artifact.type === "output" ||
				artifact.type === "result",
		)
		.map((artifact) => ({ ...artifact, artifactCwd: result.cwd }));
}

export function isStatus(value: unknown): value is Status {
	return (
		typeof value === "string" && (STATUSES as readonly string[]).includes(value)
	);
}

export function isTerminalStatus(status: Status): boolean {
	return (
		status === "completed" || status === "failed" || status === "cancelled"
	);
}

export function statusSucceeded(status: Status): boolean {
	return status === "completed";
}

export function statusFailedClosed(
	status: Status,
	failureKind: FailureKind | null,
): boolean {
	return (
		(status === "failed" || status === "cancelled") && failureKind !== null
	);
}

function dataString(
	data: Record<string, unknown> | undefined,
	key: string,
): string | undefined {
	const value = data?.[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function statusFromChildEvent(event: RunEvent): Status | undefined {
	if (isStatus(event.status)) return event.status;
	if (event.type === "child.started" || event.type === "child.updated")
		return "running";
	if (event.type === "child.completed") return "completed";
	if (event.type === "child.failed") return "failed";
	if (event.type === "child.cancelled") return "cancelled";
	return undefined;
}

export function summarizeChildEvents(
	events: readonly RunEvent[],
): RunChildSummary | undefined {
	const children = new Map<
		string,
		{
			status: Status;
			failureKind: FailureKind | string | null;
			workflowRunId?: string;
			taskId?: string;
			message?: string;
			timestamp: string;
		}
	>();
	let latestFailure: RunChildFailureSummary | null = null;
	let anonymous = 0;

	for (const event of events) {
		if (!event.type.startsWith("child.")) continue;
		const status = statusFromChildEvent(event);
		if (status === undefined) continue;
		const data = event.data;
		const childRunId =
			dataString(data, "childRunId") ??
			dataString(data, "childId") ??
			dataString(data, "descendantRunId") ??
			`anonymous-child-${anonymous++}`;
		const failureKind = dataString(data, "failureKind") ?? null;
		const child = {
			status,
			failureKind,
			...(dataString(data, "workflowRunId") === undefined
				? {}
				: { workflowRunId: dataString(data, "workflowRunId") }),
			...(dataString(data, "taskId") === undefined
				? {}
				: { taskId: dataString(data, "taskId") }),
			...(event.message === undefined ? {} : { message: event.message }),
			timestamp: event.timestamp,
		};
		children.set(childRunId, child);
		if (status === "failed" || status === "cancelled") {
			latestFailure = {
				childRunId,
				...(child.workflowRunId === undefined
					? {}
					: { workflowRunId: child.workflowRunId }),
				...(child.taskId === undefined ? {} : { taskId: child.taskId }),
				status,
				failureKind,
				...(event.message === undefined ? {} : { message: event.message }),
				timestamp: event.timestamp,
			};
		}
	}

	if (children.size === 0) return undefined;
	let pending = 0;
	let running = 0;
	let completed = 0;
	let failed = 0;
	let cancelled = 0;
	const activeChildRunIds: string[] = [];
	for (const [childRunId, child] of children) {
		if (child.status === "pending") pending += 1;
		else if (child.status === "running") running += 1;
		else if (child.status === "completed") completed += 1;
		else if (child.status === "failed") failed += 1;
		else if (child.status === "cancelled") cancelled += 1;
		if (child.status === "pending" || child.status === "running")
			activeChildRunIds.push(childRunId);
	}
	return {
		total: children.size,
		pending,
		running,
		completed,
		failed,
		cancelled,
		activeChildRunIds,
		latestFailure,
		worstDescendantStatus:
			failed > 0
				? "failed"
				: cancelled > 0
					? "cancelled"
					: running > 0
						? "running"
						: pending > 0
							? "pending"
							: children.size > 0
								? "completed"
								: null,
	};
}

function withChildSummary<T extends RunStatusSnapshot>(
	snapshot: T,
	childSummary: RunChildSummary | undefined,
): T {
	return childSummary === undefined ? snapshot : { ...snapshot, childSummary };
}

export function createRunStatusSnapshot(
	result: ResultEnvelope,
): RunStatusSnapshot {
	const logs = resultLogs(result);
	const resultArtifact =
		logs.find((artifact) => artifact.type === "result") ?? null;

	return {
		runId: result.runId,
		attemptId: result.attemptId,
		...(result.taskId === undefined ? {} : { taskId: result.taskId }),
		...(result.correlationId === undefined
			? {}
			: { correlationId: result.correlationId }),
		backend: result.backend,
		status: result.status,
		failureKind: result.failureKind,
		startedAt: result.startedAt,
		completedAt: result.completedAt,
		durationMs: result.durationMs,
		logs,
		resultPath: resultArtifact?.path ?? null,
		metadata: result.metadata,
		...(result.completion === undefined
			? {}
			: { completion: result.completion }),
	};
}

async function readJsonFile(path: string): Promise<unknown | null> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "ENOENT"
		)
			return null;
		throw error;
	}
}

function coerceResultEnvelope(value: unknown): ResultEnvelope | null {
	if (typeof value !== "object" || value === null) return null;
	const raw = value as Partial<ResultEnvelope> & { taskId?: string };
	if (
		typeof raw.runId !== "string" ||
		typeof raw.backend !== "string" ||
		typeof raw.status !== "string" ||
		typeof raw.cwd !== "string"
	)
		return null;
	const attemptId =
		typeof raw.attemptId === "string"
			? raw.attemptId
			: typeof raw.taskId === "string"
				? raw.taskId
				: "task-1";
	return {
		schemaVersion: 2,
		runId: raw.runId,
		attemptId,
		...(raw.taskId === undefined ? {} : { taskId: raw.taskId }),
		...(raw.correlationId === undefined
			? {}
			: { correlationId: raw.correlationId }),
		backend: raw.backend,
		status: raw.status,
		failureKind: raw.failureKind ?? null,
		cwd: raw.cwd,
		startedAt: raw.startedAt ?? new Date(0).toISOString(),
		completedAt: raw.completedAt ?? null,
		durationMs: raw.durationMs ?? null,
		workspace: raw.workspace ?? {
			mode: "shared",
			cwd: raw.cwd,
			worktreePath: null,
		},
		sandbox: raw.sandbox ?? { enabled: false },
		exitCode: raw.exitCode ?? null,
		signal: raw.signal ?? null,
		artifacts: Array.isArray(raw.artifacts) ? raw.artifacts : [],
		metadata: raw.metadata ?? { contextLengthExceeded: false },
		...(raw.tmux === undefined ? {} : { tmux: raw.tmux }),
		...(raw.completion === undefined ? {} : { completion: raw.completion }),
	} as ResultEnvelope;
}

async function readResultFile(path: string): Promise<ResultEnvelope | null> {
	return coerceResultEnvelope(await readJsonFile(path));
}

async function readRunResultFromAttempt(
	attempt: RunAttemptRecord | undefined,
): Promise<ResultEnvelope | null> {
	if (attempt?.resultPath === undefined || attempt.artifactCwd === undefined)
		return null;
	return await readResultFile(
		safeArtifactPath(attempt.artifactCwd, { path: attempt.resultPath }),
	);
}

async function readRunResultFallback(
	ref: RunStatusRef,
): Promise<ResultEnvelope | null> {
	const { runDir } = pathsFor(ref);
	const attemptId = ref.attemptId ?? ref.taskId;
	if (attemptId !== undefined) {
		return (
			(await readResultFile(
				join(runDir, "attempts", attemptId, "result.json"),
			)) ?? (await readResultFile(join(runDir, attemptId, "result.json")))
		);
	}
	const attemptsDir = join(runDir, "attempts");
	const entries = await readdir(attemptsDir, { withFileTypes: true }).catch(
		() => [],
	);
	const attemptDirs = entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
	const latest = attemptDirs.at(-1);
	if (latest !== undefined)
		return await readResultFile(join(attemptsDir, latest, "result.json"));
	// v1 fallback
	return await readResultFile(
		join(runDir, ref.taskId ?? "task-1", "result.json"),
	);
}

function recordLogs(attempt: RunAttemptRecord): RunLogRef[] {
	return [
		artifactFromAttempt(attempt, "stdout", attempt.stdoutPath),
		artifactFromAttempt(attempt, "stderr", attempt.stderrPath),
		artifactFromAttempt(attempt, "output", attempt.outputPath),
		artifactFromAttempt(attempt, "result", attempt.resultPath),
	].filter((artifact): artifact is RunLogRef => artifact !== null);
}

function selectedAttempt(
	record: RunRecord,
	ref: RunStatusRef,
): RunAttemptRecord | undefined {
	const requested =
		ref.attemptId ??
		ref.taskId ??
		record.latestAttemptId ??
		record.activeAttemptId ??
		undefined;
	return requested === undefined
		? record.attempts.at(-1)
		: (record.attempts.find((attempt) => attempt.attemptId === requested) ??
				record.attempts.at(-1));
}

function snapshotFromRecord(
	record: RunRecord,
	ref: RunStatusRef,
	events: RunEvent[],
): RunStatusSnapshot {
	const attempt = selectedAttempt(record, ref);
	return {
		runId: record.runId,
		attemptId:
			attempt?.attemptId ??
			ref.attemptId ??
			ref.taskId ??
			record.latestAttemptId ??
			"unknown",
		correlationId: record.correlationId,
		backend: attempt?.backend ?? record.backend ?? "headless",
		status: record.status,
		failureKind: record.failureKind,
		startedAt: attempt?.startedAt ?? record.startedAt,
		completedAt: record.completedAt,
		durationMs: null,
		logs: attempt === undefined ? [] : recordLogs(attempt),
		resultPath: attempt?.resultPath ?? null,
		metadata: { contextLengthExceeded: false },
		mode: record.mode,
		dependency: record.dependency,
		registryPath: relativeRunRecordPath(ref),
		eventsPath: relativeRunEventsPath(ref),
		eventTail: events,
		attempts: record.attempts.map(attemptSnapshot),
	};
}

function mergeRecordSnapshot(
	snapshot: RunStatusSnapshot,
	record: RunRecord,
	ref: RunStatusRef,
	events: RunEvent[],
): RunStatusSnapshot {
	const attempt = record.attempts.find(
		(candidate) => candidate.attemptId === snapshot.attemptId,
	);
	return {
		...snapshot,
		correlationId: snapshot.correlationId ?? record.correlationId,
		status: record.status,
		failureKind: record.failureKind,
		completedAt: record.completedAt,
		mode: record.mode,
		dependency: record.dependency,
		registryPath: relativeRunRecordPath(ref),
		eventsPath: relativeRunEventsPath(ref),
		eventTail: events,
		attempts: record.attempts.map(attemptSnapshot),
		logs:
			snapshot.logs.length > 0
				? snapshot.logs
				: attempt === undefined
					? snapshot.logs
					: recordLogs(attempt),
	};
}

export async function readRunResult(
	ref: RunStatusRef,
): Promise<ResultEnvelope | null> {
	const resolvedRef = await resolveRunRef(ref);
	const record = await readRunRecord(resolvedRef);
	const resultFromRecord =
		record === null
			? null
			: await readRunResultFromAttempt(selectedAttempt(record, resolvedRef));
	return resultFromRecord ?? (await readRunResultFallback(resolvedRef));
}

export async function getRunStatus(
	ref: RunStatusRef,
): Promise<RunStatusSnapshot | null> {
	const resolvedRef = await resolveRunRef(ref);
	const record = await readRunRecord(resolvedRef);
	const scannedEvents = await readRunEvents(
		resolvedRef,
		CHILD_EVENT_SCAN_LIMIT,
	).catch(() => []);
	const events = scannedEvents.slice(-EVENT_TAIL_LIMIT);
	const childSummary = summarizeChildEvents(scannedEvents);
	const result = await readRunResult(resolvedRef);
	if (result !== null) {
		const snapshot = createRunStatusSnapshot(result);
		return withChildSummary(
			record === null
				? snapshot
				: mergeRecordSnapshot(snapshot, record, resolvedRef, events),
			childSummary,
		);
	}
	return record === null
		? null
		: withChildSummary(
				snapshotFromRecord(record, resolvedRef, events),
				childSummary,
			);
}

export async function getRunLogs(
	ref: RunStatusRef,
): Promise<RunLogsSnapshot | null> {
	const resolvedRef = await resolveRunRef(ref);
	const { cwd } = pathsFor(resolvedRef);
	const snapshot = await getRunStatus(resolvedRef);
	if (snapshot === null) return null;

	const logText: RunLogsSnapshot["logText"] = {};
	for (const log of snapshot.logs) {
		logText[log.type] = await readFile(
			safeArtifactPath(cwd, log),
			"utf8",
		).catch(() => "");
	}
	if (snapshot.eventsPath !== undefined) {
		logText.events = await readFile(
			safeArtifactPath(cwd, { path: snapshot.eventsPath }),
			"utf8",
		).catch(() => "");
	}
	return { ...snapshot, logText };
}

export async function waitForRun(
	options: WaitForRunOptions,
): Promise<WaitForRunResult> {
	const timeoutMs = options.timeoutMs ?? 60_000;
	const pollIntervalMs = options.pollIntervalMs ?? 500;
	const deadline = Date.now() + timeoutMs;
	let snapshot = await getRunStatus(options);
	while (Date.now() <= deadline) {
		snapshot = await getRunStatus(options);
		if (snapshot !== null && isTerminalStatus(snapshot.status))
			return { status: "completed", snapshot };
		await sleep(pollIntervalMs);
	}
	return { status: "timeout", snapshot };
}
