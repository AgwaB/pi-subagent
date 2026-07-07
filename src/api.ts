import { resolve } from "node:path";
import { loadAgentByName, type AgentDefinition } from "./agents.ts";
import {
	appendRunEvent,
	type ResultEnvelope,
	type RunEvent,
} from "./artifacts/index.ts";
import type {
	ExecutionMode,
	FailureKind,
	ResolveInput,
	ResolvedBackend,
	Status,
} from "./core/constants.ts";
import { resolveBackend } from "./core/resolver.ts";
import { validateResolveInput } from "./core/validation.ts";
import {
	startAsyncParallelSubagentRuns,
	startAsyncSubagentRun,
} from "./orchestrate/async.ts";
import {
	interruptRun,
	type InterruptRunOptions,
	type InterruptRunResult,
} from "./orchestrate/interrupt.ts";
import {
	reconcileSubagentRun as reconcileRun,
	type ReconcileSubagentRunOptions as ReconcileRunOptions,
	type ReconcileSubagentRunResult,
} from "./orchestrate/reconcile.ts";
import { resolveRunRef } from "./orchestrate/run-ref.ts";
import {
	runParallelSubagentTasks,
	runSubagentTask,
	type ParallelRunResult,
} from "./orchestrate/run.ts";
import {
	getRunLogs,
	getRunStatus,
	waitForRun,
	type RunLogsSnapshot,
	type RunStatusRef,
	type RunStatusSnapshot,
	type WaitForRunOptions,
	type WaitForRunResult,
} from "./orchestrate/status.ts";

export interface RunSubagentOptions extends ResolveInput {
	signal?: AbortSignal;
}

export type RunSubagentResult = ResultEnvelope | ParallelRunResult;

export type GetSubagentStatusOptions = RunStatusRef;
export type GetSubagentLogsOptions = RunStatusRef;
export type WaitForSubagentOptions = WaitForRunOptions;
export type InterruptSubagentOptions = InterruptRunOptions;
export type ReconcileSubagentOptions = ReconcileRunOptions;

export interface RecordSubagentChildEventOptions extends RunStatusRef {
	event: "started" | "updated" | "completed" | "failed" | "cancelled";
	childRunId: string;
	workflowRunId?: string;
	childTaskId?: string;
	status?: Status;
	failureKind?: FailureKind | string | null;
	message?: string;
	/** Child usage totals (tokens/cost), usually sent with terminal events. */
	usage?: Record<string, unknown>;
}

export class SubagentValidationError extends Error {
	readonly failureKind = "validation" as const;
	readonly backend?: ResolvedBackend;

	constructor(message: string, backend?: ResolvedBackend) {
		super(message);
		this.name = "SubagentValidationError";
		this.backend = backend;
	}
}

const AGENT_REQUEST_KEYS = [
	"agent",
	"task",
	"roleContext",
	"agentScope",
	"confirmProjectAgents",
] as const;

interface AgentRequest {
	agent: string;
	cwd?: string;
	agentScope?: ResolveInput["agentScope"];
	confirmProjectAgents?: boolean;
}

function executionMode(input: ResolveInput): ExecutionMode {
	if (input.mode !== undefined) return input.mode;
	if (input.tasks !== undefined) return "parallel";
	return "single";
}

function hasRunnableSingleInput(input: ResolveInput): boolean {
	return AGENT_REQUEST_KEYS.some((key) => input[key] !== undefined);
}

function agentRequests(input: ResolveInput): AgentRequest[] {
	if (input.tasks !== undefined) {
		return input.tasks
			.filter(
				(task): task is typeof task & { agent: string } =>
					typeof task.agent === "string" && task.agent.length > 0,
			)
			.map((task) => ({
				agent: task.agent,
				cwd: task.cwd,
				agentScope: task.agentScope ?? input.agentScope,
				confirmProjectAgents:
					task.confirmProjectAgents ?? input.confirmProjectAgents ?? false,
			}));
	}
	return typeof input.agent === "string" && input.agent.length > 0
		? [
				{
					agent: input.agent,
					cwd: input.cwd,
					agentScope: input.agentScope,
					confirmProjectAgents: input.confirmProjectAgents ?? false,
				},
			]
		: [];
}

async function assertProjectAgentApproval(
	input: ResolveInput,
	cwd: string,
): Promise<void> {
	const projectAgents: AgentDefinition[] = [];
	for (const request of agentRequests(input)) {
		if (
			request.confirmProjectAgents === false ||
			request.agentScope === "global"
		)
			continue;
		const requestCwd = resolve(cwd, request.cwd ?? ".");
		const agent = await loadAgentByName(
			request.agent,
			requestCwd,
			request.agentScope,
		);
		if (
			agent?.source === "project" &&
			!projectAgents.some(
				(candidate) => candidate.sourcePath === agent.sourcePath,
			)
		) {
			projectAgents.push(agent);
		}
	}
	if (projectAgents.length === 0) return;

	const names = projectAgents.map((agent) => agent.displayName).join(", ");
	const sources = projectAgents.map((agent) => agent.sourcePath).join("\n");
	throw new SubagentValidationError(
		`Project-local subagent definitions require explicit opt-in from code API callers. Set confirmProjectAgents:false only for trusted repositories. Agents: ${names}\nSources:\n${sources}`,
	);
}

function validateRunnableInput(
	input: ResolveInput,
	backend: ResolvedBackend,
): void {
	const mode = executionMode(input);
	if (mode === "parallel") {
		if (input.tasks === undefined || input.tasks.length === 0) {
			throw new SubagentValidationError(
				"parallel mode requires a non-empty tasks array.",
				backend,
			);
		}
		return;
	}

	if (!hasRunnableSingleInput(input)) {
		throw new SubagentValidationError(
			`${backend} execution requires agent/task input.`,
			backend,
		);
	}
	if (input.task === undefined) {
		throw new SubagentValidationError(
			`${backend} agent/task execution requires a non-empty task.`,
			backend,
		);
	}
}

function validateRunOptions(options: RunSubagentOptions): {
	input: ResolveInput;
	cwd: string;
	backend: ResolvedBackend;
	signal?: AbortSignal;
} {
	const { signal, ...rawInput } = options;
	const validation = validateResolveInput(rawInput);
	if (!validation.ok) {
		throw new SubagentValidationError(
			validation.failure.error,
			validation.failure.backend,
		);
	}

	const resolved = resolveBackend(validation.input);
	if (resolved.status === "failed") {
		throw new SubagentValidationError(resolved.error, resolved.backend);
	}

	validateRunnableInput(validation.input, resolved.backend);
	const cwd = resolve(validation.input.cwd ?? process.cwd());
	return { input: validation.input, cwd, backend: resolved.backend, signal };
}

export async function runSubagent(
	options: RunSubagentOptions,
): Promise<RunSubagentResult> {
	const { input, cwd, backend, signal } = validateRunOptions(options);
	await assertProjectAgentApproval(input, cwd);

	try {
		const mode = executionMode(input);
		const asyncRequested =
			input.async === true ||
			input.onComplete === "detach" ||
			input.onComplete === "notify";
		if (mode === "parallel") {
			return asyncRequested
				? await startAsyncParallelSubagentRuns(input, cwd, signal)
				: await runParallelSubagentTasks(input, cwd, signal);
		}

		if (asyncRequested) {
			return await startAsyncSubagentRun({ input, cwd, backend, signal });
		}

		return await runSubagentTask({ input, cwd, signal });
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			(error as { failureKind?: unknown }).failureKind === "validation"
		) {
			throw new SubagentValidationError(
				error instanceof Error ? error.message : String(error),
			);
		}
		throw error;
	}
}

export async function getSubagentStatus(
	options: GetSubagentStatusOptions,
): Promise<RunStatusSnapshot | null> {
	return await getRunStatus(options);
}

export async function getSubagentLogs(
	options: GetSubagentLogsOptions,
): Promise<RunLogsSnapshot | null> {
	return await getRunLogs(options);
}

export async function waitForSubagent(
	options: WaitForSubagentOptions,
): Promise<WaitForRunResult> {
	return await waitForRun(options);
}

export async function interruptSubagent(
	options: InterruptSubagentOptions,
): Promise<InterruptRunResult> {
	return await interruptRun(options);
}

export async function reconcileSubagentRun(
	options: ReconcileSubagentOptions,
): Promise<ReconcileSubagentRunResult> {
	return await reconcileRun(options);
}

function defaultChildStatus(
	event: RecordSubagentChildEventOptions["event"],
): Status {
	if (event === "started" || event === "updated") return "running";
	if (event === "completed") return "completed";
	if (event === "cancelled") return "cancelled";
	return "failed";
}

export async function recordSubagentChildEvent(
	options: RecordSubagentChildEventOptions,
): Promise<RunEvent> {
	const {
		event,
		childRunId,
		workflowRunId,
		childTaskId,
		failureKind,
		message,
		usage,
	} = options;
	const ref = await resolveRunRef(options);
	return await appendRunEvent(ref, {
		type: `child.${event}`,
		status: options.status ?? defaultChildStatus(event),
		...(message === undefined ? {} : { message }),
		data: {
			childRunId,
			...(workflowRunId === undefined ? {} : { workflowRunId }),
			...(childTaskId === undefined ? {} : { taskId: childTaskId }),
			...(failureKind === undefined ? {} : { failureKind }),
			...(usage === undefined ? {} : { usage }),
		},
	});
}

export type {
	ArtifactRef,
	CompletionMetadata,
	ResultEnvelope,
	ResultMetadata,
	ResultSandbox,
	ResultSessionDisposition,
	ResultSessionMetadata,
	ResultSessionReason,
	ResultTmuxMetadata,
	ResultWorkspace,
	WorktreeCleanupStatus,
} from "./artifacts/index.ts";
export type {
	AsyncDependency,
	Backend,
	ExecutionMode,
	FailureKind,
	ResolvedBackend,
	Status,
} from "./core/constants.ts";
export type { InterruptRunResult } from "./orchestrate/interrupt.ts";
export type { ReconcileSubagentRunResult } from "./orchestrate/reconcile.ts";
export type { ParallelRunResult } from "./orchestrate/run.ts";
export type {
	RunChildFailureSummary,
	RunChildSummary,
	RunLogRef,
	RunLogsSnapshot,
	RunStatusRef,
	RunStatusSnapshot,
	RunTaskStatusSnapshot,
	WaitForRunResult,
} from "./orchestrate/status.ts";
