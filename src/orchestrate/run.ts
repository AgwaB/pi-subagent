import { resolve } from "node:path";
import { loadAgentByName, type AgentDefinition } from "../agents.ts";
import {
	appendRunEvent,
	beginRunRecord,
	createAttemptArtifactStore,
	createAttemptId,
	createRunId,
	finishAttemptFromResult,
	updateAttemptProcess,
	upsertRunAttempt,
	type ProcessMetadata,
	type ResultEnvelope,
} from "../artifacts/index.ts";
import type {
	FailureKind,
	ResolveInput,
	ResolvedBackend,
	SubagentTaskInput,
} from "../core/constants.ts";
import { resolveBackend } from "../core/resolver.ts";
import { runHeadlessModel } from "../runners/headless-model.ts";
import { runInlineModel } from "../runners/inline.ts";
import { runTmuxModel } from "../runners/tmux.ts";
import {
	finalizeWorktreeResult,
	resolveWorkspace,
	type ResolvedWorkspace,
} from "../workspace/worktree.ts";
import { writeRunLocator } from "./run-ref.ts";

export const DEFAULT_PARALLEL_CONCURRENCY = 4;
export const MAX_PARALLEL_TASKS = 12;
export const MAX_PARALLEL_CONCURRENCY = 10;

export interface RunSubagentTaskOptions {
	input: ResolveInput;
	cwd: string;
	signal?: AbortSignal;
	runId?: string;
	attemptId?: string;
	taskIndex?: number;
}

export interface MultiRunOptions {
	correlationId?: string;
}

export interface ParallelRunResult {
	mode: "parallel";
	runIds: string[];
	results: ResultEnvelope[];
	concurrency: number;
	totalTasks: number;
	startedCount: number;
	skippedCount: number;
	failFastTriggered: boolean;
}

export class SubagentToolAuthorityError extends Error {
	readonly failureKind = "validation" as const;
}

function mergeTaskInput(
	parent: ResolveInput,
	task: SubagentTaskInput,
): ResolveInput {
	return {
		...parent,
		...task,
		tasks: undefined,
		mode: "single",
		workspace: parent.workspace,
		worktree: parent.worktree,
		worktreePolicy: parent.worktreePolicy,
		concurrency: undefined,
		failFast: undefined,
		cancelSiblingsOnFailure: undefined,
		asyncDependency: undefined,
		runsDir: parent.runsDir,
		correlationId: parent.correlationId,
		parentSessionId: parent.parentSessionId,
	};
}

function workspaceMeta(workspace: ResolvedWorkspace) {
	return {
		mode: workspace.mode,
		cwd: workspace.baseCwd,
		worktreePath: workspace.worktreePath,
	};
}

function parallelConcurrency(input: ResolveInput): number {
	const requested = input.concurrency ?? DEFAULT_PARALLEL_CONCURRENCY;
	return Math.max(1, Math.min(MAX_PARALLEL_CONCURRENCY, requested));
}

function toolListLabel(tools: readonly string[] | undefined): string {
	return tools === undefined
		? "(unspecified)"
		: tools.length === 0
			? "(none)"
			: tools.join(", ");
}

function resolveEffectiveTools(
	input: ResolveInput,
	agentDefinition: AgentDefinition | undefined,
): string[] | undefined {
	if (agentDefinition === undefined) return input.tools;
	if (input.tools === undefined) return agentDefinition.tools;
	if (agentDefinition.tools === undefined) {
		throw new SubagentToolAuthorityError(
			`agent ${agentDefinition.displayName} does not declare a tools authority ceiling; caller tools cannot be applied safely.`,
		);
	}
	const allowed = new Set(agentDefinition.tools);
	const outside = input.tools.filter((tool) => !allowed.has(tool));
	if (outside.length > 0) {
		throw new SubagentToolAuthorityError(
			`caller tools expand agent ${agentDefinition.displayName}; disallowed: ${outside.join(", ")}; allowed tools: ${toolListLabel(agentDefinition.tools)}`,
		);
	}
	return input.tools;
}

function failureKindFromError(error: unknown): FailureKind {
	const candidate =
		typeof error === "object" && error !== null && "failureKind" in error
			? (error as { failureKind?: unknown }).failureKind
			: undefined;
	return candidate === "validation" ? "validation" : "internal";
}

async function writeParallelErrorResult(options: {
	taskInput: ResolveInput;
	cwd: string;
	runId: string;
	attemptId: string;
	error: unknown;
	cancelled: boolean;
}): Promise<ResultEnvelope> {
	const message =
		options.error instanceof Error
			? options.error.message
			: String(options.error);
	const resolved = resolveBackend(options.taskInput);
	const backend: ResolvedBackend =
		resolved.status === "failed" ? "inline" : resolved.backend;
	const store = await createAttemptArtifactStore({
		cwd: options.cwd,
		runId: options.runId,
		attemptId: options.attemptId,
		runsDir: options.taskInput.runsDir,
	});
	const stderr = await store.writeTextArtifact("stderr", `${message}\n`);
	const output = await store.writeTextArtifact("output", "");
	const result = await store.writeResult({
		backend,
		status: options.cancelled ? "cancelled" : "failed",
		failureKind: options.cancelled
			? "cancelled"
			: failureKindFromError(options.error),
		cwd: options.cwd,
		startedAt: new Date(),
		completedAt: new Date(),
		workspace: { mode: "shared", cwd: options.cwd },
		sandbox: { enabled: Boolean(options.taskInput.sandbox) },
		exitCode: null,
		signal: options.cancelled ? "SIGABRT" : null,
		artifacts: [stderr, output],
		correlationId: options.taskInput.correlationId,
		metadata: { contextLengthExceeded: false },
	});
	await finishAttemptFromResult(
		{
			cwd: options.cwd,
			runsDir: options.taskInput.runsDir,
			runId: options.runId,
		},
		result,
	).catch(() => undefined);
	await appendRunEvent(
		{
			cwd: options.cwd,
			runsDir: options.taskInput.runsDir,
			runId: options.runId,
		},
		{
			type: options.cancelled ? "attempt.cancelled" : "attempt.failed",
			attemptId: options.attemptId,
			status: result.status,
			message,
			data: { failureKind: result.failureKind },
		},
	).catch(() => undefined);
	return result;
}

export async function runSubagentTask(
	options: RunSubagentTaskOptions,
): Promise<ResultEnvelope> {
	const input = options.input;
	const resolved = resolveBackend(input);
	if (resolved.status === "failed") throw new Error(resolved.error);

	const backend = resolved.backend;
	const runId = options.runId ?? createRunId();
	const attemptId = options.attemptId ?? createAttemptId();
	const baseCwd = resolve(input.cwd ?? options.cwd);
	const startedAt = new Date();
	const runRef = { cwd: baseCwd, runId, runsDir: input.runsDir };
	const requestedAgent = input.agent ?? `${backend}-worker`;
	const shouldLoadAgent = input.agent !== undefined;
	const agentDefinition = shouldLoadAgent
		? await loadAgentByName(input.agent!, baseCwd, input.agentScope)
		: undefined;
	const effectiveTools = resolveEffectiveTools(input, agentDefinition);

	await beginRunRecord({
		...runRef,
		mode: "single",
		backend,
		startedAt,
		dependency: input.asyncDependency ?? null,
		correlationId: input.correlationId,
		parentSessionId: input.parentSessionId,
		activeAttemptId: attemptId,
		attempts: [
			{
				attemptId,
				status: "running",
				backend,
				startedAt: startedAt.toISOString(),
			},
		],
	});
	await writeRunLocator({
		...runRef,
		parentSessionId: input.parentSessionId,
		correlationId: input.correlationId,
	}).catch(() => undefined);

	try {
		const workspace = await resolveWorkspace({
			cwd: baseCwd,
			input,
			taskIndex: options.taskIndex,
			runId,
		});
		const cwd = workspace.cwd;
		const workspaceResult = workspaceMeta(workspace);

		await upsertRunAttempt({
			...runRef,
			attemptId,
			status: "running",
			backend,
			failureKind: null,
			startedAt,
			completedAt: null,
			workspace: workspaceResult,
			activate: true,
		});
		await appendRunEvent(
			{ ...runRef },
			{
				type: "attempt.started",
				attemptId,
				status: "running",
				message: `attempt ${attemptId} started`,
			},
		);

		const onProcessStart = async (process: ProcessMetadata) => {
			await updateAttemptProcess({ ...runRef, attemptId, process });
			await appendRunEvent(
				{ ...runRef },
				{
					type: "attempt.process_started",
					attemptId,
					status: "running",
					data: { ...process },
				},
			);
		};

		const common = {
			cwd,
			artifactCwd: baseCwd,
			signal: options.signal,
			timeoutMs: input.timeoutMs,
			sandbox: input.sandbox,
			runId,
			attemptId,
			runsDir: input.runsDir,
			correlationId: input.correlationId,
			parentSessionId: input.parentSessionId,
			workspace: workspaceResult,
			onProcessStart,
		};

		if (input.task === undefined)
			throw new Error(`${backend} execution requires agent/task input.`);
		const modelOptions = {
			...common,
			captureToolCalls: input.captureToolCalls,
			agent: requestedAgent,
			task: input.task,
			roleContext: input.roleContext,
			agentScope: input.agentScope,
			confirmProjectAgents: input.confirmProjectAgents,
			model: input.model,
			thinking: input.thinking,
			tools: effectiveTools,
			systemPrompt: input.systemPrompt,
			skills: input.skills,
			extensions: input.extensions,
			sessionId: input.sessionId,
			agentDefinition,
		};
		let result: ResultEnvelope =
			backend === "tmux"
				? await runTmuxModel(modelOptions)
				: backend === "inline"
					? await runInlineModel(modelOptions)
					: await runHeadlessModel(modelOptions);
		result = await finalizeWorktreeResult(workspace, result);

		await finishAttemptFromResult(runRef, result);
		await appendRunEvent(
			{ ...runRef },
			{
				type:
					result.status === "completed"
						? "attempt.completed"
						: result.status === "cancelled"
							? "attempt.cancelled"
							: "attempt.failed",
				attemptId,
				status: result.status,
				message: `attempt ${attemptId} ${result.status}`,
				data: {
					failureKind: result.failureKind,
					exitCode: result.exitCode,
					signal: result.signal,
				},
			},
		);
		await appendRunEvent(
			{ ...runRef },
			{
				type:
					result.status === "completed"
						? "run.completed"
						: result.status === "cancelled"
							? "run.cancelled"
							: "run.failed",
				status: result.status,
				message: `run ${result.status}`,
			},
		);
		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await upsertRunAttempt({
			...runRef,
			attemptId,
			status: "failed",
			backend,
			failureKind: "internal",
			startedAt,
			completedAt: new Date(),
			activate: true,
		}).catch(() => undefined);
		await appendRunEvent(
			{ ...runRef },
			{ type: "attempt.failed", attemptId, status: "failed", message },
		).catch(() => undefined);
		await appendRunEvent(
			{ ...runRef },
			{ type: "run.failed", status: "failed", message },
		).catch(() => undefined);
		throw error;
	}
}

export async function runParallelSubagentTasks(
	input: ResolveInput,
	cwd: string,
	signal?: AbortSignal,
	_options: MultiRunOptions = {},
): Promise<ParallelRunResult> {
	if (!input.tasks || input.tasks.length === 0)
		throw new SubagentToolAuthorityError(
			"parallel mode requires a non-empty tasks array.",
		);
	if (input.tasks.length > MAX_PARALLEL_TASKS)
		throw new SubagentToolAuthorityError(
			`too many parallel tasks (${input.tasks.length}); max is ${MAX_PARALLEL_TASKS}.`,
		);
	for (const [index, task] of input.tasks.entries()) {
		if (task.task === undefined)
			throw new SubagentToolAuthorityError(
				`parallel tasks[${index}] requires a non-empty task.`,
			);
	}

	const tasks = input.tasks;
	const runCwd = resolve(input.cwd ?? cwd);
	const concurrency = Math.min(parallelConcurrency(input), tasks.length);
	const resultSlots: Array<ResultEnvelope | undefined> = new Array(
		tasks.length,
	);
	const failFast =
		input.failFast === true || input.cancelSiblingsOnFailure === true;
	const cancelSiblings = input.cancelSiblingsOnFailure === true;
	const controller = cancelSiblings ? new AbortController() : undefined;
	const childSignal = controller?.signal ?? signal;
	let nextIndex = 0;
	let startedCount = 0;
	let stopScheduling = false;
	let failFastTriggered = false;
	let parentAbortTriggered = false;
	let siblingCancelTriggered = false;

	function triggerFailFast(): void {
		if (!failFast) return;
		failFastTriggered = true;
		stopScheduling = true;
		if (cancelSiblings && !controller?.signal.aborted) {
			siblingCancelTriggered = true;
			controller?.abort();
		}
	}

	function onParentAbort(): void {
		parentAbortTriggered = true;
		controller?.abort();
	}
	if (signal !== undefined) {
		if (signal.aborted) onParentAbort();
		else signal.addEventListener("abort", onParentAbort, { once: true });
	}

	async function worker(): Promise<void> {
		while (true) {
			if (stopScheduling) return;
			const index = nextIndex;
			nextIndex += 1;
			if (index >= tasks.length) return;
			startedCount += 1;
			const taskInput = mergeTaskInput(input, tasks[index]!);
			const runId = createRunId();
			const attemptId = createAttemptId();
			try {
				const result = await runSubagentTask({
					input: taskInput,
					cwd: runCwd,
					signal: childSignal,
					runId,
					attemptId,
					taskIndex: index,
				});
				resultSlots[index] = result;
				const parentCancelled =
					(parentAbortTriggered || signal?.aborted === true) &&
					(result.status === "cancelled" || result.failureKind === "abort");
				if (result.status !== "completed" && !parentCancelled)
					triggerFailFast();
			} catch (error) {
				if (parentAbortTriggered || signal?.aborted === true) throw error;
				const siblingAbort =
					controller?.signal.aborted === true &&
					siblingCancelTriggered &&
					!parentAbortTriggered;
				const result = await writeParallelErrorResult({
					taskInput,
					cwd: runCwd,
					runId,
					attemptId,
					error,
					cancelled: siblingAbort,
				});
				resultSlots[index] = result;
				if (!siblingAbort) triggerFailFast();
			}
		}
	}

	try {
		const workers = await Promise.allSettled(
			Array.from({ length: concurrency }, () => worker()),
		);
		const rejected = workers.find(
			(workerResult): workerResult is PromiseRejectedResult =>
				workerResult.status === "rejected",
		);
		if (rejected !== undefined) throw rejected.reason;
	} finally {
		if (signal !== undefined)
			signal.removeEventListener("abort", onParentAbort);
	}

	const results = resultSlots.filter(
		(result): result is ResultEnvelope => result !== undefined,
	);
	return {
		mode: "parallel",
		runIds: results.map((result) => result.runId),
		results,
		concurrency,
		totalTasks: tasks.length,
		startedCount,
		skippedCount: Math.max(0, tasks.length - startedCount),
		failFastTriggered,
	};
}
