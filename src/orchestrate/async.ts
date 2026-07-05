import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	appendRunEvent,
	beginRunRecord,
	createAttemptArtifactStore,
	createAttemptId,
	createRunId,
	finishAttemptFromResult,
	updateAttemptProcess,
	type ResultEnvelope,
} from "../artifacts/index.ts";
import type {
	ExecutionMode,
	ResolveInput,
	ResolvedBackend,
	SubagentTaskInput,
} from "../core/constants.ts";
import { resolveBackend } from "../core/resolver.ts";
import {
	DEFAULT_PARALLEL_CONCURRENCY,
	MAX_PARALLEL_CONCURRENCY,
	MAX_PARALLEL_TASKS,
	SubagentToolAuthorityError,
	type ParallelRunResult,
} from "./run.ts";
import { writeRunLocator } from "./run-ref.ts";
import { readRunResult, waitForRun } from "./status.ts";

export interface StartAsyncSubagentRunOptions {
	input: ResolveInput;
	cwd: string;
	backend: ResolvedBackend;
	signal?: AbortSignal;
	runId?: string;
	attemptId?: string;
	onComplete?: (
		result: ResultEnvelope,
		mode: ExecutionMode,
	) => number | Promise<number>;
}

function executionMode(input: ResolveInput): ExecutionMode {
	if (input.mode !== undefined) return input.mode;
	if (input.tasks !== undefined) return "parallel";
	return "single";
}

function parallelConcurrency(input: ResolveInput): number {
	const requested = input.concurrency ?? DEFAULT_PARALLEL_CONCURRENCY;
	return Math.max(1, Math.min(MAX_PARALLEL_CONCURRENCY, requested));
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
		asyncDependency: parent.asyncDependency,
		runsDir: parent.runsDir,
		correlationId: parent.correlationId,
		parentSessionId: parent.parentSessionId,
	};
}

function sandboxEnabled(input: ResolveInput): boolean {
	return Boolean(input.sandbox);
}

function armCompletionMonitor(
	options: StartAsyncSubagentRunOptions & {
		runId: string;
		attemptId: string;
		mode: ExecutionMode;
		store: Awaited<ReturnType<typeof createAttemptArtifactStore>>;
	},
): void {
	if (options.onComplete === undefined || options.input.onComplete !== "notify")
		return;
	void (async () => {
		const waited = await waitForRun({
			cwd: options.cwd,
			runsDir: options.input.runsDir,
			runId: options.runId,
			attemptId: options.attemptId,
			timeoutMs: options.input.timeoutMs ?? 86_400_000,
			pollIntervalMs: 500,
		});
		if (waited.status !== "completed") return;
		const result = await readRunResult({
			cwd: options.cwd,
			runsDir: options.input.runsDir,
			runId: options.runId,
			attemptId: options.attemptId,
		});
		if (result === null) return;
		const updatesSent = await options.onComplete!(result, options.mode);
		const completed = await options.store.writeResult({
			...result,
			completion: {
				onComplete: options.input.onComplete ?? null,
				notified: true,
				updatesSent,
			},
		});
		await finishAttemptFromResult(
			{
				cwd: options.cwd,
				runsDir: options.input.runsDir,
				runId: options.runId,
			},
			completed,
		);
	})().catch(() => undefined);
}

function workerPath(): string {
	return join(
		dirname(fileURLToPath(import.meta.url)),
		"../workers/durable-worker.mjs",
	);
}

export async function startAsyncParallelSubagentRuns(
	input: ResolveInput,
	cwd: string,
	signal?: AbortSignal,
	onComplete?: StartAsyncSubagentRunOptions["onComplete"],
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

	const taskPlans = input.tasks.map((task, index) => {
		const taskInput = mergeTaskInput(input, task);
		const resolved = resolveBackend(taskInput);
		if (resolved.status === "failed")
			throw new SubagentToolAuthorityError(
				`parallel tasks[${index}] backend resolution failed: ${resolved.error}`,
			);
		return { index, taskInput, backend: resolved.backend };
	});
	const concurrency = Math.min(parallelConcurrency(input), taskPlans.length);
	const results: ResultEnvelope[] = new Array(taskPlans.length);
	let nextIndex = 0;

	async function worker(): Promise<void> {
		while (true) {
			const index = nextIndex;
			nextIndex += 1;
			const plan = taskPlans[index];
			if (plan === undefined) return;
			results[plan.index] = await startAsyncSubagentRun({
				input: plan.taskInput,
				cwd: plan.taskInput.cwd ?? cwd,
				backend: plan.backend,
				signal,
				onComplete,
			});
		}
	}

	try {
		await Promise.all(Array.from({ length: concurrency }, () => worker()));
	} catch (error) {
		const startedResults = results.filter(
			(result): result is ResultEnvelope => result !== undefined,
		);
		if (startedResults.length > 0 && error && typeof error === "object") {
			Object.assign(error, {
				startedRunIds: startedResults.map((result) => result.runId),
				startedResults,
			});
		}
		throw error;
	}
	return {
		mode: "parallel",
		runIds: results.map((result) => result.runId),
		results,
		concurrency,
		totalTasks: input.tasks.length,
		startedCount: results.length,
		skippedCount: 0,
		failFastTriggered: false,
	};
}

export async function startAsyncSubagentRun(
	options: StartAsyncSubagentRunOptions,
): Promise<ResultEnvelope> {
	const input = options.input;
	const startedAt = new Date();
	const runId = options.runId ?? createRunId(startedAt);
	const attemptId = options.attemptId ?? createAttemptId(startedAt);
	const mode = executionMode(input);
	if (mode === "parallel") {
		throw new SubagentToolAuthorityError(
			"startAsyncSubagentRun handles one run; use startAsyncParallelSubagentRuns for parallel inputs.",
		);
	}
	const dependency = input.asyncDependency ?? "unclassified";
	const store = await createAttemptArtifactStore({
		cwd: options.cwd,
		runId,
		attemptId,
		runsDir: input.runsDir,
	});
	const payloadPath = store.pathFor("worker");
	const payloadText = `${JSON.stringify({ input, cwd: options.cwd, backend: options.backend, runId, attemptId, startedAt: startedAt.toISOString() }, null, 2)}\n`;
	await writeFile(payloadPath, payloadText);
	const workerRef = store.refFor(
		"worker",
		Buffer.byteLength(payloadText, "utf8"),
	);

	const running = await store.writeResult({
		backend: options.backend,
		status: "running",
		failureKind: null,
		cwd: options.cwd,
		startedAt,
		completedAt: null,
		workspace: { mode: "shared", cwd: options.cwd },
		sandbox: { enabled: sandboxEnabled(input) },
		exitCode: null,
		signal: null,
		artifacts: [workerRef],
		correlationId: input.correlationId,
		metadata: { contextLengthExceeded: false },
	});

	await beginRunRecord({
		cwd: options.cwd,
		runsDir: input.runsDir,
		runId,
		mode,
		backend: options.backend,
		startedAt,
		dependency,
		correlationId: input.correlationId,
		parentSessionId: input.parentSessionId,
		activeAttemptId: attemptId,
		attempts: [
			{
				attemptId,
				status: "running",
				backend: options.backend,
				startedAt: startedAt.toISOString(),
				artifactCwd: options.cwd,
				resultPath: running.artifacts.find(
					(artifact) => artifact.type === "result",
				)?.path,
			},
		],
	});
	await writeRunLocator({
		cwd: options.cwd,
		runsDir: input.runsDir,
		runId,
		parentSessionId: input.parentSessionId,
		correlationId: input.correlationId,
	}).catch(() => undefined);
	await appendRunEvent(
		{ cwd: options.cwd, runsDir: input.runsDir, runId },
		{
			type: "run.started",
			status: "running",
			message: `${mode} durable async run started`,
			data: { dependency, attemptId },
		},
	);

	const workerLogFd = openSync(join(store.attemptDir, "worker.log"), "a");
	let child;
	try {
		child = spawn(process.execPath, [workerPath(), payloadPath], {
			cwd: options.cwd,
			detached: process.platform !== "win32",
			stdio: ["ignore", workerLogFd, workerLogFd],
		});
	} finally {
		closeSync(workerLogFd);
	}
	child.unref();

	if (child.pid !== undefined) {
		await updateAttemptProcess({
			cwd: options.cwd,
			runsDir: input.runsDir,
			runId,
			attemptId,
			process: {
				pid: child.pid,
				processGroupId: process.platform === "win32" ? undefined : child.pid,
				command: process.execPath,
				workerPid: child.pid,
				workerProcessGroupId:
					process.platform === "win32" ? undefined : child.pid,
			},
		}).catch(() => undefined);
	}

	armCompletionMonitor({ ...options, runId, attemptId, mode, store });
	return running;
}
