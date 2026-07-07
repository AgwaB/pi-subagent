import type {
	FailureKind,
	ResolvedBackend,
	Status,
} from "../core/constants.ts";

export const RESULT_SCHEMA_VERSION = 2 as const;
export const ARTIFACT_TYPES = [
	"result",
	"stdout",
	"stderr",
	"output",
	"worker",
	"worktree-status",
	"worktree-diff",
	"tool-calls",
	"tool-calls-summary",
] as const;
export const WORKSPACE_MODES = ["shared", "worktree", "auto"] as const;

export type ArtifactType = (typeof ARTIFACT_TYPES)[number];
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

export interface ArtifactRef {
	type: ArtifactType;
	path: string;
	bytes?: number;
}

export type WorktreeCleanupStatus =
	| "not-needed"
	| "removed"
	| "kept"
	| "failed";

export interface ResultWorkspace {
	mode: WorkspaceMode;
	cwd: string;
	worktreePath: string | null;
	worktreeCleanupStatus?: WorktreeCleanupStatus;
	worktreeStatusPath?: string;
	worktreeDiffPath?: string;
	worktreeCleanupError?: string;
}

export interface ResultSandbox {
	enabled: boolean;
	/** Network domains allowed inside the sandbox. Absent or empty means deny-all. */
	allowedDomains?: string[];
}

export interface ResultTmuxMetadata {
	sessionName: string;
	sessionId: string | null;
	paneId: string | null;
}

export interface CompletionMetadata {
	onComplete: string | null;
	notified: boolean;
	updatesSent: number;
}

export type ResultSessionDisposition =
	| "created"
	| "resumed"
	| "ephemeral"
	| "unavailable";
export type ResultSessionReason =
	| "session_not_found"
	| "resume_unsupported"
	| "session_store_error";

export interface ResultSessionMetadata {
	id?: string;
	requested: boolean;
	disposition: ResultSessionDisposition;
	reason?: ResultSessionReason;
}

export interface ToolResultBudgetMetadata {
	enabled: boolean;
	maxTotalChars?: number;
	/** Present when an invalid budget option was ignored. */
	warning?: string;
	toolResults?: number;
	retainedChars?: number;
	evictedCount?: number;
	evictedChars?: number;
	evictableCount?: number;
	forcedEvictionApplied?: boolean;
}

export interface ResultMetadata {
	contextLengthExceeded: boolean;
	contextOverflowRecovered?: boolean;
	/** True when a context-length failure was recovered by budget eviction + one retry. */
	contextRecovered?: boolean;
	toolResultBudget?: ToolResultBudgetMetadata;
	provider?: string;
	model?: string;
	usage?: unknown;
	stopReason?: string;
	parentSessionId?: string;
	sessionId?: string;
	session?: ResultSessionMetadata;
	streamErrors?: string[];
	nonFatalStreamErrors?: string[];
	recoveredStreamErrors?: string[];
	parseErrors?: string[];
}

export interface ResultEnvelopeInput {
	runId: string;
	attemptId: string;
	correlationId?: string;
	backend: ResolvedBackend;
	status: Status;
	failureKind?: FailureKind | null;
	cwd: string;
	startedAt?: string | Date;
	completedAt?: string | Date | null;
	durationMs?: number | null;
	workspace?: Partial<ResultWorkspace> | null;
	sandbox?: Partial<ResultSandbox> | null;
	exitCode?: number | null;
	signal?: string | null;
	artifacts?: ArtifactRef[];
	tmux?: ResultTmuxMetadata;
	completion?: CompletionMetadata;
	metadata?: Partial<ResultMetadata> | null;
	/** @deprecated v1 compatibility only. */
	taskId?: string;
}

export interface ResultEnvelope {
	schemaVersion: typeof RESULT_SCHEMA_VERSION;
	runId: string;
	attemptId: string;
	correlationId?: string;
	backend: ResolvedBackend;
	status: Status;
	failureKind: FailureKind | null;
	cwd: string;
	startedAt: string;
	completedAt: string | null;
	durationMs: number | null;
	workspace: ResultWorkspace;
	sandbox: ResultSandbox;
	exitCode: number | null;
	signal: string | null;
	artifacts: ArtifactRef[];
	metadata: ResultMetadata;
	tmux?: ResultTmuxMetadata;
	completion?: CompletionMetadata;
	/** @deprecated v1 compatibility only. */
	taskId?: string;
}

function toIsoTimestamp(value: string | Date, fieldName: string): string {
	const date = typeof value === "string" ? new Date(value) : value;
	if (Number.isNaN(date.getTime())) {
		throw new Error(`${fieldName} must be a valid ISO timestamp or Date.`);
	}
	return date.toISOString();
}

function normalizeDuration(
	value: number | null | undefined,
): number | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(
			"durationMs must be a non-negative finite number when provided.",
		);
	}
	return value;
}

function normalizeWorkspace(input: ResultEnvelopeInput): ResultWorkspace {
	const workspace = input.workspace ?? {};
	return {
		mode: workspace.mode ?? "shared",
		cwd: workspace.cwd ?? input.cwd,
		worktreePath: workspace.worktreePath ?? null,
		...(workspace.worktreeCleanupStatus === undefined
			? {}
			: { worktreeCleanupStatus: workspace.worktreeCleanupStatus }),
		...(workspace.worktreeStatusPath === undefined
			? {}
			: { worktreeStatusPath: workspace.worktreeStatusPath }),
		...(workspace.worktreeDiffPath === undefined
			? {}
			: { worktreeDiffPath: workspace.worktreeDiffPath }),
		...(workspace.worktreeCleanupError === undefined
			? {}
			: { worktreeCleanupError: workspace.worktreeCleanupError }),
	};
}

function normalizeSandbox(input: ResultEnvelopeInput): ResultSandbox {
	if (input.sandbox === undefined || input.sandbox === null) {
		return { enabled: false };
	}

	return {
		enabled: input.sandbox.enabled ?? true,
		...(input.sandbox.allowedDomains === undefined ||
		input.sandbox.allowedDomains.length === 0
			? {}
			: { allowedDomains: input.sandbox.allowedDomains }),
	};
}

function normalizeMetadata(input: ResultEnvelopeInput): ResultMetadata {
	const metadata = input.metadata ?? {};
	return {
		contextLengthExceeded: metadata.contextLengthExceeded ?? false,
		...(metadata.contextOverflowRecovered === undefined
			? {}
			: { contextOverflowRecovered: metadata.contextOverflowRecovered }),
		...(metadata.contextRecovered === undefined
			? {}
			: { contextRecovered: metadata.contextRecovered }),
		...(metadata.toolResultBudget === undefined
			? {}
			: { toolResultBudget: metadata.toolResultBudget }),
		...(metadata.provider === undefined ? {} : { provider: metadata.provider }),
		...(metadata.model === undefined ? {} : { model: metadata.model }),
		...(metadata.usage === undefined ? {} : { usage: metadata.usage }),
		...(metadata.stopReason === undefined
			? {}
			: { stopReason: metadata.stopReason }),
		...(metadata.parentSessionId === undefined
			? {}
			: { parentSessionId: metadata.parentSessionId }),
		...(metadata.sessionId === undefined
			? {}
			: { sessionId: metadata.sessionId }),
		...(metadata.session === undefined ? {} : { session: metadata.session }),
		...(metadata.streamErrors === undefined
			? {}
			: { streamErrors: metadata.streamErrors }),
		...(metadata.nonFatalStreamErrors === undefined
			? {}
			: { nonFatalStreamErrors: metadata.nonFatalStreamErrors }),
		...(metadata.recoveredStreamErrors === undefined
			? {}
			: { recoveredStreamErrors: metadata.recoveredStreamErrors }),
		...(metadata.parseErrors === undefined
			? {}
			: { parseErrors: metadata.parseErrors }),
	};
}

function dedupeArtifactRefs(refs: ArtifactRef[]): ArtifactRef[] {
	const seen = new Set<string>();
	const deduped: ArtifactRef[] = [];

	for (const ref of refs) {
		const key = `${ref.type}:${ref.path}`;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(ref);
	}

	return deduped;
}

export function mergeArtifactRefs(
	...groups: readonly ArtifactRef[][]
): ArtifactRef[] {
	return dedupeArtifactRefs(groups.flat());
}

export function createResultEnvelope(
	input: ResultEnvelopeInput,
): ResultEnvelope {
	const startedAt = toIsoTimestamp(input.startedAt ?? new Date(), "startedAt");
	const completedAt =
		input.completedAt === undefined
			? input.status === "pending" || input.status === "running"
				? null
				: new Date().toISOString()
			: input.completedAt === null
				? null
				: toIsoTimestamp(input.completedAt, "completedAt");

	const explicitDurationMs = normalizeDuration(input.durationMs);
	const durationMs =
		explicitDurationMs !== undefined
			? explicitDurationMs
			: completedAt === null
				? null
				: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));

	return {
		schemaVersion: RESULT_SCHEMA_VERSION,
		runId: input.runId,
		attemptId: input.attemptId,
		...(input.correlationId === undefined
			? {}
			: { correlationId: input.correlationId }),
		backend: input.backend,
		status: input.status,
		failureKind: input.failureKind ?? null,
		cwd: input.cwd,
		startedAt,
		completedAt,
		durationMs,
		workspace: normalizeWorkspace(input),
		sandbox: normalizeSandbox(input),
		exitCode: input.exitCode ?? null,
		signal: input.signal ?? null,
		artifacts: dedupeArtifactRefs(input.artifacts ?? []),
		metadata: normalizeMetadata(input),
		...(input.tmux === undefined ? {} : { tmux: input.tmux }),
		...(input.completion === undefined ? {} : { completion: input.completion }),
		...(input.taskId === undefined ? {} : { taskId: input.taskId }),
	};
}
