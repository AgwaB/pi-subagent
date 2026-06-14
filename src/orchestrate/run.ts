import { resolve } from "node:path";
import { loadAgentByName, type AgentDefinition } from "../agents.ts";
import {
  appendRunEvent,
  beginRunRecord,
  createAttemptId,
  createRunId,
  finishAttemptFromResult,
  updateAttemptProcess,
  upsertRunAttempt,
  type ProcessMetadata,
  type ResultEnvelope,
} from "../artifacts/index.ts";
import type { ResolveInput, SubagentTaskInput } from "../core/constants.ts";
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
}

export class SubagentToolAuthorityError extends Error {
  readonly failureKind = "validation" as const;
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
  return tools === undefined ? "(unspecified)" : tools.length === 0 ? "(none)" : tools.join(", ");
}

function resolveEffectiveTools(input: ResolveInput, agentDefinition: AgentDefinition | undefined): string[] | undefined {
  if (agentDefinition === undefined) return input.tools;
  if (input.tools === undefined) return agentDefinition.tools;
  if (agentDefinition.tools === undefined) {
    throw new SubagentToolAuthorityError(`agent ${agentDefinition.displayName} does not declare a tools authority ceiling; caller tools cannot be applied safely.`);
  }
  const allowed = new Set(agentDefinition.tools);
  const outside = input.tools.filter((tool) => !allowed.has(tool));
  if (outside.length > 0) {
    throw new SubagentToolAuthorityError(`caller tools expand agent ${agentDefinition.displayName}; disallowed: ${outside.join(", ")}; allowed tools: ${toolListLabel(agentDefinition.tools)}`);
  }
  return input.tools;
}

export async function runSubagentTask(options: RunSubagentTaskOptions): Promise<ResultEnvelope> {
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
  const agentDefinition = shouldLoadAgent ? await loadAgentByName(input.agent!, baseCwd, input.agentScope) : undefined;
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
    attempts: [{ attemptId, status: "running", backend, startedAt: startedAt.toISOString() }],
  });

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
    await appendRunEvent({ ...runRef }, { type: "attempt.started", attemptId, status: "running", message: `attempt ${attemptId} started` });

    const onProcessStart = async (process: ProcessMetadata) => {
      await updateAttemptProcess({ ...runRef, attemptId, process });
      await appendRunEvent({ ...runRef }, { type: "attempt.process_started", attemptId, status: "running", data: { ...process } });
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
      workspace: workspaceResult,
      onProcessStart,
    };

    if (input.task === undefined) throw new Error(`${backend} execution requires agent/task input.`);
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
      agentDefinition,
    };
    let result: ResultEnvelope = backend === "tmux" ? await runTmuxModel(modelOptions) : backend === "inline" ? await runInlineModel(modelOptions) : await runHeadlessModel(modelOptions);
    result = await finalizeWorktreeResult(workspace, result);

    await finishAttemptFromResult(runRef, result);
    await appendRunEvent(
      { ...runRef },
      {
        type: result.status === "completed" ? "attempt.completed" : result.status === "cancelled" ? "attempt.cancelled" : "attempt.failed",
        attemptId,
        status: result.status,
        message: `attempt ${attemptId} ${result.status}`,
        data: { failureKind: result.failureKind, exitCode: result.exitCode, signal: result.signal },
      },
    );
    await appendRunEvent(
      { ...runRef },
      { type: result.status === "completed" ? "run.completed" : result.status === "cancelled" ? "run.cancelled" : "run.failed", status: result.status, message: `run ${result.status}` },
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
    await appendRunEvent({ ...runRef }, { type: "attempt.failed", attemptId, status: "failed", message }).catch(() => undefined);
    await appendRunEvent({ ...runRef }, { type: "run.failed", status: "failed", message }).catch(() => undefined);
    throw error;
  }
}

export async function runParallelSubagentTasks(input: ResolveInput, cwd: string, signal?: AbortSignal, _options: MultiRunOptions = {}): Promise<ParallelRunResult> {
  if (!input.tasks || input.tasks.length === 0) throw new SubagentToolAuthorityError("parallel mode requires a non-empty tasks array.");
  if (input.tasks.length > MAX_PARALLEL_TASKS) throw new SubagentToolAuthorityError(`too many parallel tasks (${input.tasks.length}); max is ${MAX_PARALLEL_TASKS}.`);
  for (const [index, task] of input.tasks.entries()) {
    if (task.task === undefined) throw new SubagentToolAuthorityError(`parallel tasks[${index}] requires a non-empty task.`);
  }

  const tasks = input.tasks;
  const runCwd = resolve(input.cwd ?? cwd);
  const concurrency = Math.min(parallelConcurrency(input), tasks.length);
  const results: ResultEnvelope[] = new Array(tasks.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= tasks.length) return;
      const taskInput = mergeTaskInput(input, tasks[index]!);
      results[index] = await runSubagentTask({
        input: taskInput,
        cwd: runCwd,
        signal,
        taskIndex: index,
      });
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { mode: "parallel", runIds: results.map((result) => result.runId), results, concurrency };
}
