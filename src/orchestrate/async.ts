import { createRunId, createTaskArtifactStore, beginRunRecord, appendRunEvent, type ResultEnvelope } from "../artifacts/index.ts";
import type { ExecutionMode, OnCompleteAction, ResolveInput, ResolvedBackend } from "../core/constants.ts";
import { runParallelSubagentTasks, runSubagentTask } from "./run.ts";

export interface StartAsyncSubagentRunOptions {
  input: ResolveInput;
  cwd: string;
  backend: ResolvedBackend;
  signal?: AbortSignal;
  runId?: string;
  taskId?: string;
  onComplete?: (result: ResultEnvelope, mode: ExecutionMode) => number | Promise<number>;
}

function executionMode(input: ResolveInput): ExecutionMode {
  if (input.mode !== undefined) return input.mode;
  if (input.tasks !== undefined) return "parallel";
  return "single";
}

function sandboxEnabled(input: ResolveInput): boolean {
  return input.sandbox !== undefined && input.sandbox !== null;
}

async function annotateCompletion(
  store: Awaited<ReturnType<typeof createTaskArtifactStore>>,
  input: ResolveInput,
  result: ResultEnvelope,
  updatesSent: number,
): Promise<ResultEnvelope> {
  const completion = {
    onComplete: (input.onComplete ?? null) as OnCompleteAction | null,
    notified: input.onComplete === "notify",
    updatesSent,
  };
  return await store.writeResult({
    ...result,
    completedAt: result.completedAt,
    artifacts: result.artifacts,
    completion,
  });
}

export async function startAsyncSubagentRun(options: StartAsyncSubagentRunOptions): Promise<ResultEnvelope> {
  const input = options.input;
  const startedAt = new Date();
  const runId = options.runId ?? createRunId(startedAt);
  const taskId = options.taskId ?? "task-1";
  const mode = executionMode(input);
  const dependency = input.asyncDependency ?? "unclassified";
  const store = await createTaskArtifactStore({ cwd: options.cwd, runId, taskId });
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
    artifacts: [],
  });
  await beginRunRecord({
    cwd: options.cwd,
    runId,
    mode,
    backend: options.backend,
    startedAt,
    dependency,
    aggregateTaskId: mode === "parallel" ? taskId : null,
    tasks: [{ taskId, status: "running", backend: options.backend }],
  });
  await appendRunEvent({ cwd: options.cwd, runId }, { type: "run.started", status: "running", message: `${mode} async run started`, data: { dependency } });

  void (async () => {
    if (mode === "parallel") {
      const parallel = await runParallelSubagentTasks(input, options.cwd, options.signal, { runId, taskIdOffset: 1 });
      const updatesSent = (await options.onComplete?.(parallel.aggregate, mode)) ?? 0;
      await annotateCompletion(store, input, parallel.aggregate, updatesSent);
      return;
    }

    const result = await runSubagentTask({ input, cwd: options.cwd, signal: options.signal, runId, taskId, runMode: mode });
    const updatesSent = (await options.onComplete?.(result, mode)) ?? 0;
    await annotateCompletion(store, input, result, updatesSent);
  })().catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    await appendRunEvent({ cwd: options.cwd, runId }, { type: "run.failed", status: "failed", message }).catch(() => undefined);
    const stderr = await store.writeTextArtifact("stderr", `${message}\n`);
    await store.writeResult({
      backend: options.backend,
      status: "failed",
      failureKind: "internal",
      cwd: options.cwd,
      startedAt,
      completedAt: new Date(),
      workspace: { mode: "shared", cwd: options.cwd },
      sandbox: { enabled: sandboxEnabled(input) },
      exitCode: null,
      signal: null,
      artifacts: [stderr],
    });
  });

  return running;
}
