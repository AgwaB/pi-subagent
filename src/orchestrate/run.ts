import { resolve } from "node:path";
import { loadAgentByName } from "../agents.ts";
import {
  appendRunEvent,
  beginRunRecord,
  createRunId,
  createTaskArtifactStore,
  finishTaskFromResult,
  relativeRunEventsPath,
  relativeRunRecordPath,
  updateTaskProcess,
  upsertRunTask,
  type ResultEnvelope,
} from "../artifacts/index.ts";
import type { ExecutionMode, FailureKind, ResolveInput, ResolvedBackend, SubagentTaskInput } from "../core/constants.ts";
import { resolveBackend } from "../core/resolver.ts";
import { runHeadlessModel } from "../runners/headless-model.ts";
import { runInlineModel } from "../runners/inline.ts";
import { runTmuxModel } from "../runners/tmux.ts";
import { finalizeWorktreeResult, resolveWorkspace, type ResolvedWorkspace } from "../workspace/worktree.ts";

export const DEFAULT_PARALLEL_CONCURRENCY = 4;
export const MAX_PARALLEL_TASKS = 12;
export const MAX_PARALLEL_CONCURRENCY = 10;

export interface RunSubagentTaskOptions {
  input: ResolveInput;
  cwd: string;
  signal?: AbortSignal;
  runId?: string;
  taskId?: string;
  taskIndex?: number;
  runMode?: ExecutionMode;
}

export interface MultiRunOptions {
  runId?: string;
  taskIdOffset?: number;
}

export interface ParallelRunResult {
  runId: string;
  results: ResultEnvelope[];
  aggregate: ResultEnvelope;
  concurrency: number;
}

function mergeTaskInput(parent: ResolveInput, task: SubagentTaskInput): ResolveInput {
  return {
    ...parent,
    ...task,
    tasks: undefined,
    mode: "single",
    workspace: parent.workspace,
    worktree: parent.worktree,
    worktreePolicy: parent.worktreePolicy,
    concurrency: undefined,
    asyncDependency: undefined,
  };
}

function workspaceMeta(workspace: ResolvedWorkspace) {
  return {
    mode: workspace.mode,
    cwd: workspace.baseCwd,
    worktreePath: workspace.worktreePath,
  };
}

function taskIdFor(index: number, offset = 0): string {
  return `task-${index + 1 + offset}`;
}

function aggregateStatus(results: readonly ResultEnvelope[]): { status: "completed" | "failed" | "cancelled"; failureKind: FailureKind | null } {
  const failed = results.find((result) => result.status === "failed");
  if (failed !== undefined) return { status: "failed", failureKind: failed.failureKind ?? "internal" };
  const cancelled = results.find((result) => result.status === "cancelled");
  if (cancelled !== undefined) return { status: "cancelled", failureKind: cancelled.failureKind ?? "cancelled" };
  return { status: "completed", failureKind: null };
}

function aggregateOutput(mode: ExecutionMode, runId: string, results: readonly ResultEnvelope[]): string {
  return `${JSON.stringify(
    {
      mode,
      runId,
      status: aggregateStatus(results).status,
      tasks: results.map((result) => ({
        runId: result.runId,
        taskId: result.taskId,
        backend: result.backend,
        status: result.status,
        failureKind: result.failureKind,
        exitCode: result.exitCode,
        signal: result.signal,
        workspace: result.workspace,
        artifacts: result.artifacts,
      })),
    },
    null,
    2,
  )}\n`;
}

function parallelConcurrency(input: ResolveInput): number {
  const requested = input.concurrency ?? DEFAULT_PARALLEL_CONCURRENCY;
  return Math.max(1, Math.min(MAX_PARALLEL_CONCURRENCY, requested));
}

async function writeAggregateResult(options: {
  input: ResolveInput;
  cwd: string;
  backend: ResolvedBackend;
  runId: string;
  taskId?: string;
  startedAt: Date;
  mode: ExecutionMode;
  results: readonly ResultEnvelope[];
}): Promise<ResultEnvelope> {
  const store = await createTaskArtifactStore({ cwd: options.cwd, runId: options.runId, taskId: options.taskId ?? "task-1" });
  const output = await store.writeTextArtifact("output", aggregateOutput(options.mode, options.runId, options.results));
  const status = aggregateStatus(options.results);
  const sandboxed = options.input.sandbox !== undefined && options.input.sandbox !== null;
  const aggregate = await store.writeResult({
    backend: options.backend,
    status: status.status,
    failureKind: status.failureKind,
    cwd: options.cwd,
    startedAt: options.startedAt,
    completedAt: new Date(),
    workspace: { mode: "shared", cwd: options.cwd },
    sandbox: { enabled: sandboxed },
    exitCode: null,
    signal: null,
    artifacts: [output],
  });
  await finishTaskFromResult({ cwd: options.cwd, runId: options.runId }, aggregate);
  await appendRunEvent(
    { cwd: options.cwd, runId: options.runId },
    {
      type: aggregate.status === "completed" ? "run.completed" : aggregate.status === "cancelled" ? "run.cancelled" : "run.failed",
      status: aggregate.status,
      message: `${options.mode} run ${aggregate.status}`,
      data: { taskCount: options.results.length, aggregateTaskId: aggregate.taskId },
    },
  );
  return aggregate;
}

export async function runSubagentTask(options: RunSubagentTaskOptions): Promise<ResultEnvelope> {
  const input = options.input;
  const resolved = resolveBackend(input);
  if (resolved.status === "failed") throw new Error(resolved.error);

  const backend = resolved.backend;
  const runId = options.runId ?? createRunId();
  const taskId = options.taskId ?? "task-1";
  const runMode = options.runMode ?? "single";
  const baseCwd = resolve(input.cwd ?? options.cwd);
  const startedAt = new Date();
  const runRef = { cwd: baseCwd, runId };
  const requestedAgent = input.agent ?? `${backend}-worker`;
  const agentDefinition = input.agent === undefined ? undefined : await loadAgentByName(input.agent, baseCwd, input.agentScope);

  await beginRunRecord({
    ...runRef,
    mode: runMode,
    backend,
    startedAt,
    dependency: input.asyncDependency ?? null,
    aggregateTaskId: runMode === "parallel" ? "task-1" : null,
  });

  try {
    const workspace = await resolveWorkspace({
      cwd: baseCwd,
      input,
      mode: runMode === "parallel" ? "parallel" : "single",
      taskIndex: options.taskIndex,
      runId,
    });
    const cwd = workspace.cwd;
    const workspaceResult = workspaceMeta(workspace);

    await upsertRunTask({
      ...runRef,
      taskId,
      status: "running",
      backend,
      failureKind: null,
      startedAt,
      completedAt: null,
      workspace: workspaceResult,
    });
    await appendRunEvent({ ...runRef }, { type: "task.started", taskId, status: "running", message: `task ${taskId} started` });

    const onProcessStart = async (process: { pid: number; processGroupId?: number; command?: string }) => {
      await updateTaskProcess({ ...runRef, taskId, process });
      await appendRunEvent({ ...runRef }, { type: "task.process_started", taskId, status: "running", data: process });
    };

    const common = {
      cwd,
      artifactCwd: baseCwd,
      signal: options.signal,
      timeoutMs: input.timeoutMs,
      sandbox: input.sandbox,
      runId,
      taskId,
      workspace: workspaceResult,
      onProcessStart,
    };

    if (input.task === undefined) throw new Error(`${backend} execution requires agent/task input.`);
    const modelOptions = {
      ...common,
      agent: requestedAgent,
      task: input.task,
      roleContext: input.roleContext,
      agentScope: input.agentScope,
      confirmProjectAgents: input.confirmProjectAgents,
      model: input.model,
      thinking: input.thinking,
      tools: input.agent === undefined ? input.tools : undefined,
      agentDefinition,
    };
    let result: ResultEnvelope = backend === "tmux" ? await runTmuxModel(modelOptions) : backend === "inline" ? await runInlineModel(modelOptions) : await runHeadlessModel(modelOptions);
    result = await finalizeWorktreeResult(workspace, result);

    await finishTaskFromResult(runRef, result);
    await appendRunEvent(
      { ...runRef },
      {
        type: result.status === "completed" ? "task.completed" : result.status === "cancelled" ? "task.cancelled" : "task.failed",
        taskId,
        status: result.status,
        message: `task ${taskId} ${result.status}`,
        data: { failureKind: result.failureKind, exitCode: result.exitCode, signal: result.signal },
      },
    );
    if (runMode === "single") {
      await appendRunEvent(
        { ...runRef },
        { type: result.status === "completed" ? "run.completed" : result.status === "cancelled" ? "run.cancelled" : "run.failed", status: result.status, message: `run ${result.status}` },
      );
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await upsertRunTask({
      ...runRef,
      taskId,
      status: "failed",
      backend,
      failureKind: "internal",
      startedAt,
      completedAt: new Date(),
    }).catch(() => undefined);
    await appendRunEvent({ ...runRef }, { type: "task.failed", taskId, status: "failed", message }).catch(() => undefined);
    throw error;
  }
}

export async function runParallelSubagentTasks(input: ResolveInput, cwd: string, signal?: AbortSignal, options: MultiRunOptions = {}): Promise<ParallelRunResult> {
  if (!input.tasks || input.tasks.length === 0) throw new Error("parallel mode requires a non-empty tasks array.");
  if (input.tasks.length > MAX_PARALLEL_TASKS) throw new Error(`too many parallel tasks (${input.tasks.length}); max is ${MAX_PARALLEL_TASKS}.`);

  const resolved = resolveBackend(input);
  if (resolved.status === "failed") throw new Error(resolved.error);

  const runId = options.runId ?? createRunId();
  const taskIdOffset = options.taskIdOffset ?? 1;
  const startedAt = new Date();
  const runCwd = resolve(input.cwd ?? cwd);
  const concurrency = Math.min(parallelConcurrency(input), input.tasks.length);
  const taskSeeds = input.tasks.map((_, index) => ({ taskId: taskIdFor(index, taskIdOffset) }));

  await beginRunRecord({
    cwd: runCwd,
    runId,
    mode: "parallel",
    backend: resolved.backend,
    startedAt,
    dependency: input.asyncDependency ?? null,
    aggregateTaskId: "task-1",
    tasks: [{ taskId: "task-1", status: "running", backend: resolved.backend }, ...taskSeeds],
  });
  await appendRunEvent({ cwd: runCwd, runId }, { type: "run.started", status: "running", message: "parallel run started", data: { taskCount: input.tasks.length, concurrency } });

  const results: ResultEnvelope[] = new Array(input.tasks.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= input.tasks.length) return;
      const taskInput = mergeTaskInput(input, input.tasks[index]);
      results[index] = await runSubagentTask({
        input: taskInput,
        cwd: runCwd,
        signal,
        runId,
        taskId: taskIdFor(index, taskIdOffset),
        taskIndex: index,
        runMode: "parallel",
      });
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const aggregate = await writeAggregateResult({ input, cwd: runCwd, backend: resolved.backend, runId, startedAt, mode: "parallel", results });
  return { runId, results, aggregate, concurrency };
}

export { writeAggregateResult };
