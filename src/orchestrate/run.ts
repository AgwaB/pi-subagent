import { resolve } from "node:path";
import { loadAgentByName, type AgentDefinition } from "../agents.ts";
import {
	appendRunEvent,
	beginRunRecord,
	commitAttemptResultIfActive,
	createAttemptArtifactStore,
	createAttemptId,
	createRunId,
	readRunRecord,
	updateAttemptProcess,
	upsertRunAttempt,
	type ProcessMetadata,
	type ResultEnvelope,
	type ResultTmuxMetadata,
	type RunRef,
} from "../artifacts/index.ts";
import {
	isFailureKind,
	type FailureKind,
	type ResolveInput,
	type ResolvedBackend,
	type SubagentTaskInput,
} from "../core/constants.ts";
import { resolveBackend } from "../core/resolver.ts";
import { runHeadlessModel } from "../runners/headless-model.ts";
import { runInlineModel } from "../runners/inline.ts";
import { runTmuxModel } from "../runners/tmux.ts";
import {
	discardPreparedWorkspace,
	finalizeWorktreeResult,
	retainOwnedWorkspace,
	resolveWorkspace,
	type ResolvedWorkspace,
} from "../workspace/worktree.ts";
import { writeRunLocator } from "./run-ref.ts";
import { cleanupInactiveAttemptOwnership } from "./reconcile.ts";

export const DEFAULT_PARALLEL_CONCURRENCY = 4;
export const MAX_PARALLEL_TASKS = 12;
export const MAX_PARALLEL_CONCURRENCY = 10;

export interface RunSubagentTaskOptions {
	input: ResolveInput;
	cwd: string;
	/** Explicit binding for this execution only; absent means child env must unset it. */
	durableWorkerBinding?: string;
	/** Preflight marker used to reject inline before a durable barrier emits READY. */
	requiresDurableWorkerBinding?: boolean;
	/** Internal durable-worker continuation of the already-created active attempt. */
	resumeExistingAttempt?: boolean;
	signal?: AbortSignal;
	runId?: string;
	attemptId?: string;
	taskIndex?: number;
}

export interface PreparedSubagentExecution {
	input: ResolveInput & { task: string };
	durableWorkerBinding?: string;
	ownership: {
		state: "prepared" | "execution-owned" | "finalized";
		cleanupStatus?: "not-needed" | "removed" | "kept" | "failed";
	};
	backend: ResolvedBackend;
	runId: string;
	attemptId: string;
	baseCwd: string;
	workspace: ResolvedWorkspace;
	workspaceResult: ReturnType<typeof workspaceMeta>;
	requestedAgent: string;
	agentDefinition: AgentDefinition | undefined;
	effectiveTools: string[] | undefined;
}

export interface MultiRunOptions {
	correlationId?: string;
}

export async function commitOwnedTerminalResult(
	ref: RunRef,
	result: ResultEnvelope,
): Promise<Awaited<ReturnType<typeof commitAttemptResultIfActive>>> {
	if (!(await cleanupInactiveAttemptOwnership(ref, result.attemptId)))
		throw Object.assign(
			new Error("inactive attempt ownership could not be drained"),
			{ failureKind: "internal" as const, terminalBlocked: true as const },
		);
	return await commitAttemptResultIfActive(ref, result);
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
	return isFailureKind(candidate) ? candidate : "internal";
}

function terminalCommitBlocked(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"terminalBlocked" in error &&
		(error as { terminalBlocked?: unknown }).terminalBlocked === true
	);
}

function tmuxMetadataMatches(
	persisted: ResultTmuxMetadata | undefined,
	expected: ResultTmuxMetadata,
): boolean {
	return (
		persisted?.serverName === expected.serverName &&
		persisted.socketPath === expected.socketPath &&
		persisted.ownershipTokenSha256 === expected.ownershipTokenSha256 &&
		persisted.launchState === expected.launchState &&
		persisted.launchPid === expected.launchPid &&
		persisted.launchProcessGroupId === expected.launchProcessGroupId &&
		persisted.launchProcessBirthIdentity ===
			expected.launchProcessBirthIdentity &&
		persisted.serverPid === expected.serverPid &&
		persisted.serverProcessGroupId === expected.serverProcessGroupId &&
		persisted.serverProcessBirthIdentity === expected.serverProcessBirthIdentity &&
		persisted.panePid === expected.panePid &&
		persisted.paneProcessGroupId === expected.paneProcessGroupId &&
		persisted.paneProcessBirthIdentity === expected.paneProcessBirthIdentity &&
		persisted.sessionName === expected.sessionName &&
		persisted.sessionId === expected.sessionId &&
		persisted.paneId === expected.paneId
	);
}

function processMetadataMatches(
	persisted: ProcessMetadata | undefined,
	expected: ProcessMetadata,
): boolean {
	return (
		persisted !== undefined &&
		persisted.pid === expected.pid &&
		persisted.processGroupId === expected.processGroupId &&
		persisted.processBirthIdentity === expected.processBirthIdentity &&
		persisted.command === expected.command &&
		persisted.workerPid === expected.workerPid &&
		persisted.workerProcessGroupId === expected.workerProcessGroupId &&
		persisted.workerProcessBirthIdentity === expected.workerProcessBirthIdentity
	);
}

async function writeParallelErrorResult(options: {
	taskInput: ResolveInput;
	cwd: string;
	runId: string;
	attemptId: string;
	error: unknown;
	cancelled: boolean;
	cancelFailureKind?: "abort" | "cancelled";
}): Promise<ResultEnvelope> {
	const message =
		options.error instanceof Error
			? options.error.message
			: String(options.error);
	const resolved = resolveBackend(options.taskInput);
	const backend: ResolvedBackend =
		resolved.status === "failed" ? "inline" : resolved.backend;
	const startedAt = new Date();
	const completedAt = new Date();
	const runRef = {
		cwd: options.cwd,
		runId: options.runId,
		runsDir: options.taskInput.runsDir,
	};
	await beginRunRecord({
		...runRef,
		mode: "single",
		backend,
		startedAt,
		dependency: options.taskInput.asyncDependency ?? null,
		correlationId: options.taskInput.correlationId,
		parentSessionId: options.taskInput.parentSessionId,
		activeAttemptId: options.attemptId,
		attempts: [
			{
				attemptId: options.attemptId,
				status: "running",
				backend,
				startedAt: startedAt.toISOString(),
			},
		],
	});
	await writeRunLocator({
		...runRef,
		parentSessionId: options.taskInput.parentSessionId,
		correlationId: options.taskInput.correlationId,
	}).catch(() => undefined);
	await appendRunEvent(runRef, {
		type: "run.started",
		status: "running",
		message: "parallel task error run started",
		data: { attemptId: options.attemptId },
	}).catch(() => undefined);
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
			? (options.cancelFailureKind ?? "cancelled")
			: failureKindFromError(options.error),
		cwd: options.cwd,
		startedAt,
		completedAt,
		workspace: { mode: "shared", cwd: options.cwd },
		sandbox: { enabled: Boolean(options.taskInput.sandbox) },
		exitCode: null,
		signal: options.cancelled ? "SIGABRT" : null,
		artifacts: [stderr, output],
		correlationId: options.taskInput.correlationId,
		metadata: { contextLengthExceeded: false },
	});
	const committed = await commitOwnedTerminalResult(runRef, result).catch(
		() => ({ committed: false as const, record: null }),
	);
	if (!committed.committed) return result;
	await appendRunEvent(runRef, {
		type: options.cancelled ? "attempt.cancelled" : "attempt.failed",
		attemptId: options.attemptId,
		status: result.status,
		message,
		data: { failureKind: result.failureKind },
	}).catch(() => undefined);
	await appendRunEvent(runRef, {
		type: options.cancelled ? "run.cancelled" : "run.failed",
		status: result.status,
		message: `run ${result.status}`,
	}).catch(() => undefined);
	return result;
}

export async function prepareSubagentExecution(
	options: RunSubagentTaskOptions,
): Promise<PreparedSubagentExecution> {
	const input = Object.freeze({ ...options.input });
	const resolved = resolveBackend(input);
	if (resolved.status === "failed") throw new Error(resolved.error);
	const backend = resolved.backend;
	if (
		backend === "inline" &&
		(options.requiresDurableWorkerBinding === true ||
			options.durableWorkerBinding !== undefined ||
			process.env.PI_SUBAGENT_DURABLE_WORKER_BINDING_JSON !== undefined)
	)
		throw new SubagentToolAuthorityError(
			"durable worker binding does not support inline execution; choose headless or tmux.",
		);
	const runId = options.runId ?? createRunId();
	const attemptId = options.attemptId ?? createAttemptId();
	const baseCwd = resolve(input.cwd ?? options.cwd);
	const requestedAgent = input.agent ?? `${backend}-worker`;
	const agentDefinition =
		input.agent === undefined
			? undefined
			: await loadAgentByName(input.agent, baseCwd, input.agentScope);
	const effectiveTools = resolveEffectiveTools(input, agentDefinition);
	if (input.task === undefined)
		throw new Error(`${backend} execution requires agent/task input.`);
	const preparedInput: ResolveInput & { task: string } = Object.freeze({
		...input,
		task: input.task,
	});
	const workspace = await resolveWorkspace({
		cwd: baseCwd,
		input,
		taskIndex: options.taskIndex,
		runId,
	});
	const workspaceResult = workspaceMeta(workspace);
	try {
		const existingRecord = await readRunRecord({
			cwd: baseCwd,
			runId,
			runsDir: input.runsDir,
		});
		const existingAttempt = existingRecord?.attempts.find(
			(attempt) => attempt.attemptId === attemptId,
		);
		if (
			options.resumeExistingAttempt === true &&
			(existingAttempt === undefined ||
				existingRecord?.activeAttemptId !== attemptId ||
				existingAttempt.process?.workerPid !== process.pid ||
				(existingAttempt.status !== "pending" &&
					existingAttempt.status !== "running"))
		)
			throw new Error(
				`attempt id ${attemptId} cannot be resumed by this worker`,
			);
		if (
			options.resumeExistingAttempt !== true &&
			existingAttempt !== undefined
		)
				throw new Error(
					`attempt id ${attemptId} is already present in run ${runId}`,
				);
		const reservation = await upsertRunAttempt({
			cwd: baseCwd,
			runId,
			runsDir: input.runsDir,
			attemptId,
			status: "pending",
			backend,
			failureKind: null,
			workspace: {
				...workspaceResult,
				worktreeCleanupStatus:
					workspace.mode === "worktree" ? "prepared" : "not-needed",
			},
			activate: true,
			createOnly: options.resumeExistingAttempt !== true,
			mustExist: options.resumeExistingAttempt === true,
			requireNoActive: options.resumeExistingAttempt !== true,
			onlyIfActive: options.resumeExistingAttempt === true,
		});
		const reservedAttempt = reservation.attempts.find(
			(attempt) => attempt.attemptId === attemptId,
		);
		if (
			reservation.activeAttemptId !== attemptId ||
			reservedAttempt === undefined ||
			(reservedAttempt.status !== "pending" &&
				reservedAttempt.status !== "running")
		)
			throw new Error(
				`attempt id ${attemptId} lost active ownership before preparation completed`,
			);
	} catch (error) {
		await discardPreparedWorkspace(workspace).catch(() => undefined);
		throw error;
	}
	return {
		input: preparedInput,
		durableWorkerBinding: options.durableWorkerBinding,
		ownership: { state: "prepared" as const },
		backend,
		runId,
		attemptId,
		baseCwd,
		workspace,
		workspaceResult,
		requestedAgent,
		agentDefinition,
		effectiveTools,
	};
}

export async function discardSubagentExecution(
	prepared: PreparedSubagentExecution,
): Promise<void> {
	if (prepared.ownership.state !== "prepared") return;
	await discardPreparedWorkspace(prepared.workspace);
	prepared.ownership.state = "finalized";
	prepared.ownership.cleanupStatus =
		prepared.workspace.mode === "worktree" ? "removed" : "not-needed";
	await upsertRunAttempt({
		cwd: prepared.baseCwd,
		runId: prepared.runId,
		runsDir: prepared.input.runsDir,
		attemptId: prepared.attemptId,
		status: "cancelled",
		backend: prepared.backend,
		failureKind: "user_cancelled",
		completedAt: new Date(),
		workspace: {
			...prepared.workspaceResult,
			worktreeCleanupStatus:
				prepared.workspace.mode === "worktree" ? "removed" : "not-needed",
		},
		activate: false,
		mustExist: true,
		onlyIfActive: true,
	}).catch(() => undefined);
}

async function writeOwnedExecutionFailure(
	prepared: PreparedSubagentExecution,
	error: unknown,
): Promise<ResultEnvelope> {
	const { input, backend, runId, attemptId, baseCwd, workspace } = prepared;
	const runRef = { cwd: baseCwd, runId, runsDir: input.runsDir };
	const existing = await readRunRecord(runRef);
	const existingAttempt = existing?.attempts.find(
		(attempt) => attempt.attemptId === attemptId,
	);
	const startedAt = existingAttempt?.startedAt ?? new Date().toISOString();
	const completedAt = new Date();
	const message = error instanceof Error ? error.message : String(error);
	const failureKind = failureKindFromError(error);
	const status =
		failureKind === "abort" ||
		failureKind === "cancelled" ||
		failureKind === "user_cancelled"
			? "cancelled"
			: "failed";

	await retainOwnedWorkspace(workspace);
	const store = await createAttemptArtifactStore({
		...runRef,
		attemptId,
	});
	const stderr = await store.writeTextArtifact("stderr", `${message}\n`);
	const output = await store.writeTextArtifact("output", "");
	const cleanupStatus = workspace.mode === "worktree" ? "kept" : "not-needed";
	const result = await store.writeResult({
		backend,
		status,
		failureKind,
		cwd: baseCwd,
		startedAt,
		completedAt,
		workspace: {
			...prepared.workspaceResult,
			worktreeCleanupStatus: cleanupStatus,
		},
		sandbox: { enabled: Boolean(input.sandbox) },
		exitCode: null,
		signal: status === "cancelled" ? "SIGTERM" : null,
		artifacts: [stderr, output],
		...(existingAttempt?.tmux === undefined
			? {}
			: { tmux: existingAttempt.tmux }),
		correlationId: input.correlationId,
		metadata: { contextLengthExceeded: false },
	});
	prepared.ownership.state = "finalized";
	prepared.ownership.cleanupStatus = cleanupStatus;
	const committed = await commitOwnedTerminalResult(runRef, result);
	if (!committed.committed) return result;
	await appendRunEvent(runRef, {
		type: status === "cancelled" ? "attempt.cancelled" : "attempt.failed",
		attemptId,
		status,
		message,
		data: { failureKind },
	}).catch(() => undefined);
	await appendRunEvent(runRef, {
		type: status === "cancelled" ? "run.cancelled" : "run.failed",
		status,
		message: `run ${status}`,
	}).catch(() => undefined);
	return result;
}

export async function runPreparedSubagentExecution(
	prepared: PreparedSubagentExecution,
	options: Pick<RunSubagentTaskOptions, "signal"> & {
		deferTerminalCommit?: boolean;
	} = {},
): Promise<ResultEnvelope> {
	const {
		input,
		backend,
		runId,
		attemptId,
		baseCwd,
		workspace,
		workspaceResult,
		requestedAgent,
		agentDefinition,
		effectiveTools,
		durableWorkerBinding,
	} = prepared;
	const startedAt = new Date();
	const runRef = { cwd: baseCwd, runId, runsDir: input.runsDir };

	await beginRunRecord({
		...runRef,
		mode: "single",
		backend,
		startedAt,
		dependency: input.asyncDependency ?? null,
		correlationId: input.correlationId,
		parentSessionId: input.parentSessionId,
		attempts: [],
	});
	const runningRecord = await upsertRunAttempt({
		...runRef,
		attemptId,
		status: "running",
		backend,
		failureKind: null,
		startedAt,
		completedAt: null,
		workspace: {
			...workspaceResult,
			worktreeCleanupStatus:
				workspace.mode === "worktree" ? "execution-owned" : "not-needed",
		},
		activate: false,
		onlyIfActive: true,
	});
	const runningAttempt = runningRecord.attempts.find(
		(attempt) => attempt.attemptId === attemptId,
	);
	if (
		runningRecord.activeAttemptId !== attemptId ||
		runningAttempt?.status !== "running"
	)
		throw new Error(
			`attempt id ${attemptId} lost active ownership before execution`,
		);
	prepared.ownership.state = "execution-owned";
	await writeRunLocator({
		...runRef,
		parentSessionId: input.parentSessionId,
		correlationId: input.correlationId,
	}).catch(() => undefined);

	try {
		const cwd = workspace.cwd;

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
			const beforeUpdate = await readRunRecord(runRef);
			const existingProcess = beforeUpdate?.attempts.find(
				(attempt) => attempt.attemptId === attemptId,
			)?.process;
			const ownedProcess: ProcessMetadata = {
				...process,
				...(existingProcess?.workerPid === undefined
					? {}
					: {
							workerPid: existingProcess.workerPid,
							workerProcessGroupId: existingProcess.workerProcessGroupId,
							workerProcessBirthIdentity:
								existingProcess.workerProcessBirthIdentity,
						}),
			};
			await updateAttemptProcess({
				...runRef,
				attemptId,
				process: ownedProcess,
			});
			const updated = await readRunRecord(runRef);
			const persisted = updated?.attempts.find(
				(attempt) => attempt.attemptId === attemptId,
			);
			if (
				updated?.activeAttemptId !== attemptId ||
				persisted?.status !== "running" ||
				!processMetadataMatches(persisted.process, ownedProcess)
			)
				throw new Error(
					"process ownership metadata was not committed to the active attempt",
				);
			await appendRunEvent(
				{ ...runRef },
				{
					type: "attempt.process_started",
					attemptId,
					status: "running",
					data: { ...ownedProcess },
				},
			);
		};
		const onTmuxStart = async (tmux: ResultTmuxMetadata) => {
			const updated = await upsertRunAttempt({
				...runRef,
				attemptId,
				status: "running",
				backend,
				tmux,
				workspace: {
					...workspaceResult,
					worktreeCleanupStatus:
						workspace.mode === "worktree" ? "execution-owned" : "not-needed",
				},
				onlyIfActive: true,
			});
			const persisted = updated.attempts.find(
				(attempt) => attempt.attemptId === attemptId,
			);
			if (
				updated.activeAttemptId !== attemptId ||
				persisted?.status !== "running" ||
				!tmuxMetadataMatches(persisted.tmux, tmux)
			)
				throw new Error(
					"tmux ownership metadata was not committed to the active attempt",
				);
		};

		const childEnv = { ...process.env };
		delete childEnv.PI_SUBAGENT_DURABLE_WORKER_BINDING_JSON;
		if (durableWorkerBinding !== undefined)
			childEnv.PI_SUBAGENT_DURABLE_WORKER_BINDING_JSON = durableWorkerBinding;
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
			onTmuxStart,
			childEnv,
		};

		const modelOptions = {
			...common,
			captureToolCalls: input.captureToolCalls,
			toolResultBudget: input.toolResultBudget,
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
		result = await finalizeWorktreeResult(workspace, result, input.runsDir);
		prepared.ownership.state = "finalized";
		const terminalCleanupStatus = result.workspace.worktreeCleanupStatus;
		prepared.ownership.cleanupStatus =
			terminalCleanupStatus === "removed" ||
			terminalCleanupStatus === "kept" ||
			terminalCleanupStatus === "failed" ||
			terminalCleanupStatus === "not-needed"
				? terminalCleanupStatus
				: workspace.mode === "worktree"
					? "kept"
					: "not-needed";

		if (options.deferTerminalCommit === true) return result;
		const committed = await commitOwnedTerminalResult(runRef, result);
		if (!committed.committed) return result;
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
		await retainOwnedWorkspace(workspace).catch(() => undefined);
		// The owning entry point commits the fallback result after this method
		// releases model/workspace control.
		throw error;
	}
}

export async function runSubagentTask(
	options: RunSubagentTaskOptions,
): Promise<ResultEnvelope> {
	const prepared = await prepareSubagentExecution(options);
	try {
		return await runPreparedSubagentExecution(prepared, {
			signal: options.signal,
		});
	} catch (error) {
		if (terminalCommitBlocked(error)) throw error;
		if (prepared.ownership.state === "execution-owned")
			return await writeOwnedExecutionFailure(prepared, error);
		await discardSubagentExecution(prepared).catch(() => undefined);
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
	function parentIsAborted(): boolean {
		return parentAbortTriggered || signal?.aborted === true;
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
			if (parentIsAborted()) {
				stopScheduling = true;
				const abortError = Object.assign(
					new Error("parallel execution was aborted before task start"),
					{ failureKind: "abort" as const },
				);
				resultSlots[index] = await writeParallelErrorResult({
					taskInput,
					cwd: runCwd,
					runId,
					attemptId,
					error: abortError,
					cancelled: true,
					cancelFailureKind: "abort",
				});
				return;
			}
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
					parentIsAborted() &&
					(result.status === "cancelled" || result.failureKind === "abort");
				if (result.status !== "completed" && !parentCancelled)
					triggerFailFast();
			} catch (error) {
				if (parentIsAborted()) throw error;
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
