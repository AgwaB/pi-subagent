import { resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadAgentByName, type AgentDefinition } from "./agents.ts";
import {
  appendRunEvent,
  beginRunRecord,
  createResultEnvelope,
  createRunId,
  createTaskArtifactStore,
  setRunDependency,
  type ArtifactRef,
  type ResultEnvelope,
} from "./artifacts/index.ts";
import {
  AGENT_SCOPES,
  ASYNC_DEPENDENCIES,
  BACKENDS,
  EXECUTION_MODES,
  ON_COMPLETE_ACTIONS,
  THINKING_LEVELS,
  WORKSPACE_MODES,
  WORKTREE_POLICIES,
  type ExecutionMode,
  type ResolveInput,
  type ResolveValidationFailure,
  type ResolvedBackend,
} from "./core/constants.ts";
import { resolveBackend } from "./core/resolver.ts";
import { validateResolveInput } from "./core/validation.ts";
import { interruptRun } from "./orchestrate/interrupt.ts";
import { DEFAULT_PARALLEL_CONCURRENCY, runParallelSubagentTasks, runSubagentTask } from "./orchestrate/run.ts";
import { getRunLogs, getRunStatus, waitForRun } from "./orchestrate/status.ts";
import { showSubagentPanel } from "./panel.ts";
import { WorkspacePolicyError } from "./workspace/worktree.ts";

const TOOL_NAME = "subagent";
const SUPPORTED_KEYS = new Set([
  "backend",
  "visible",
  "sandbox",
  "agent",
  "task",
  "roleContext",
  "agentScope",
  "confirmProjectAgents",
  "mode",
  "tasks",
  "concurrency",
  "asyncDependency",
  "workspace",
  "worktree",
  "worktreePolicy",
  "cwd",
  "async",
  "onComplete",
  "timeoutMs",
  "model",
  "tools",
  "thinking",
  "thinkingLevel",
  "reasoningLevel",
  "action",
  "runId",
  "taskId",
  "pollIntervalMs",
  "reason",
  "signal",
  "escalateAfterMs",
  "killAfterMs",
]);
const AGENT_TASK_KEYS = ["agent", "task", "roleContext", "agentScope", "confirmProjectAgents"];
const SUBAGENT_TASK_SCHEMA = Type.Object({
  agent: Type.Optional(Type.String({ minLength: 1 })),
  task: Type.Optional(Type.String({ minLength: 1 })),
  roleContext: Type.Optional(Type.String({ minLength: 1 })),
  agentScope: Type.Optional(Type.Union(AGENT_SCOPES.map((value) => Type.Literal(value)))),
  confirmProjectAgents: Type.Optional(Type.Boolean()),
  sandbox: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  visible: Type.Optional(Type.Boolean()),
  cwd: Type.Optional(Type.String({ minLength: 1 })),
  timeoutMs: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  model: Type.Optional(Type.String({ minLength: 1 })),
  thinking: Type.Optional(Type.Union(THINKING_LEVELS.map((value) => Type.Literal(value)))),
  tools: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
});

interface ToolTextContent {
  type: "text";
  text: string;
}

interface ToolResult {
  content: ToolTextContent[];
  details?: unknown;
  isError: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasAnyKey(input: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => Object.hasOwn(input, key));
}

function formatKeyList(keys: readonly string[]): string {
  return keys.map((key) => `"${key}"`).join(", ");
}

function getExecuteParams(first: unknown, second: unknown): unknown {
  return second === undefined ? first : second;
}

function getCwd(ctx: unknown): string {
  if (isRecord(ctx) && typeof ctx.cwd === "string" && ctx.cwd.length > 0) return ctx.cwd;
  return process.cwd();
}

function textResult(payload: unknown, isError: boolean, details?: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    ...(details === undefined ? {} : { details }),
    isError,
  };
}

function artifactSummary(artifacts: readonly ArtifactRef[]) {
  return artifacts.map((artifact) => ({
    type: artifact.type,
    path: artifact.path,
    ...(artifact.bytes === undefined ? {} : { bytes: artifact.bytes }),
  }));
}

function compactResult(result: ResultEnvelope, error?: string) {
  return {
    tool: TOOL_NAME,
    backend: result.backend,
    status: result.status,
    failureKind: result.failureKind,
    ...(error === undefined ? {} : { error }),
    runId: result.runId,
    taskId: result.taskId,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    signal: result.signal,
    sandbox: result.sandbox,
    workspace: result.workspace,
    ...(result.tmux === undefined ? {} : { tmux: result.tmux }),
    ...(result.completion === undefined ? {} : { completion: result.completion }),
    artifacts: artifactSummary(result.artifacts),
  };
}

function validationFailure(failure: ResolveValidationFailure): ToolResult {
  return textResult(
    {
      tool: TOOL_NAME,
      backend: failure.backend,
      status: failure.status,
      failureKind: failure.failureKind,
      error: failure.error,
    },
    true,
    { resolved: failure },
  );
}

class InputValidationError extends Error {
  readonly failureKind = "validation" as const;
}

function optionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new InputValidationError(`${fieldName} must be a non-empty string when provided.`);
  return value;
}

function optionalPositiveNumber(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new InputValidationError(`${fieldName} must be a positive finite number when provided.`);
  return value;
}

async function lifecycleAction(raw: Record<string, unknown>, cwd: string): Promise<ToolResult | null> {
  const action = raw.action ?? "run";
  if (action === "run") return null;
  if (action !== "status" && action !== "logs" && action !== "wait" && action !== "interrupt" && action !== "mark-background") {
    throw new InputValidationError('action must be one of "run", "status", "logs", "wait", "interrupt", or "mark-background" when provided.');
  }

  const runId = optionalString(raw.runId, "runId");
  if (runId === undefined) throw new InputValidationError(`${String(action)} action requires a non-empty runId.`);
  const ref = {
    cwd: optionalString(raw.cwd, "cwd") ?? cwd,
    runId,
    taskId: optionalString(raw.taskId, "taskId"),
  };

  if (action === "status") {
    const snapshot = await getRunStatus(ref);
    return textResult({ tool: TOOL_NAME, action, status: snapshot === null ? "failed" : snapshot.status, snapshot }, snapshot === null, { snapshot });
  }

  if (action === "logs") {
    const snapshot = await getRunLogs(ref);
    return textResult({ tool: TOOL_NAME, action, status: snapshot === null ? "failed" : snapshot.status, snapshot }, snapshot === null, { snapshot });
  }

  if (action === "mark-background") {
    const record = await setRunDependency(ref, "background");
    await appendRunEvent(ref, { type: "run.mark_background", status: record.status, message: "run marked background" });
    const snapshot = await getRunStatus(ref);
    return textResult({ tool: TOOL_NAME, action, status: snapshot?.status ?? record.status, snapshot }, false, { snapshot, record });
  }

  if (action === "interrupt") {
    const signal = optionalString(raw.signal, "signal") as NodeJS.Signals | undefined;
    if (signal !== undefined && signal !== "SIGINT" && signal !== "SIGTERM" && signal !== "SIGKILL") {
      throw new InputValidationError('signal must be one of "SIGINT", "SIGTERM", or "SIGKILL" when provided.');
    }
    const interrupted = await interruptRun({
      cwd: ref.cwd,
      runId,
      reason: optionalString(raw.reason, "reason"),
      signal,
      escalateAfterMs: optionalPositiveNumber(raw.escalateAfterMs, "escalateAfterMs"),
      killAfterMs: optionalPositiveNumber(raw.killAfterMs, "killAfterMs"),
    });
    const snapshot = await getRunStatus(ref);
    const isError = interrupted.status === "not-found" || interrupted.status === "unsupported";
    return textResult({ tool: TOOL_NAME, action, status: interrupted.status, interrupted, snapshot }, isError, { interrupted, snapshot });
  }

  const waited = await waitForRun({ ...ref, timeoutMs: optionalPositiveNumber(raw.timeoutMs, "timeoutMs"), pollIntervalMs: optionalPositiveNumber(raw.pollIntervalMs, "pollIntervalMs") });
  const isError = waited.status !== "completed" || waited.snapshot?.status !== "completed";
  return textResult({ tool: TOOL_NAME, action, status: waited.status, snapshot: waited.snapshot }, isError, { waited });
}

function executionMode(input: ResolveInput): ExecutionMode {
  if (input.mode !== undefined) return input.mode;
  if (input.tasks !== undefined) return "parallel";
  return "single";
}

function unsupportedPathError(raw: Record<string, unknown>, input: ResolveInput, backend: ResolvedBackend): string | undefined {
  const mode = executionMode(input);
  const unknownKeys = Object.keys(raw).filter((key) => !SUPPORTED_KEYS.has(key));
  if (unknownKeys.length > 0) {
    return `unsupported subagent option(s): ${formatKeyList(unknownKeys)}.`;
  }

  if (mode === "parallel") {
    return input.tasks === undefined ? "parallel mode requires a non-empty tasks array." : undefined;
  }

  if (backend !== "inline" && backend !== "headless" && backend !== "tmux") {
    return `backend "${backend}" is not implemented in this MVP; only inline, headless, and tmux execution are supported.`;
  }

  if (hasAnyKey(raw, AGENT_TASK_KEYS) && input.task === undefined) {
    return `${backend} agent/task execution requires a non-empty "task".`;
  }

  if (!hasAnyKey(raw, AGENT_TASK_KEYS)) {
    return `${backend} execution requires agent/task input.`;
  }

  return undefined;
}

async function writeUnsupportedResult(cwd: string, backend: ResolvedBackend, input: ResolveInput): Promise<ResultEnvelope> {
  const startedAt = new Date();
  const store = await createTaskArtifactStore({ cwd });
  const sandboxed = input.sandbox !== undefined && input.sandbox !== null;
  return await store.writeResult({
    backend,
    status: "failed",
    failureKind: "validation",
    cwd,
    startedAt,
    completedAt: new Date(),
    workspace: { mode: "shared", cwd },
    sandbox: { enabled: sandboxed },
    exitCode: null,
    signal: null,
    artifacts: [],
  });
}

interface ToolUpdateCallback {
  (update: { content: ToolTextContent[]; details?: unknown }): void;
}

interface NotificationContext {
  ui?: {
    notify?: (message: string, level?: "info" | "warning" | "error") => void;
  };
}

interface ProjectAgentApprovalContext extends NotificationContext {
  hasUI?: boolean;
  ui?: NotificationContext["ui"] & {
    confirm?: (title: string, message?: string) => Promise<boolean> | boolean;
  };
}

interface AgentRequest {
  agent: string;
  cwd?: string;
  agentScope?: ResolveInput["agentScope"];
  confirmProjectAgents?: boolean;
}

function agentRequests(input: ResolveInput): AgentRequest[] {
  if (input.tasks !== undefined) {
    return input.tasks
      .filter((task): task is typeof task & { agent: string } => typeof task.agent === "string" && task.agent.length > 0)
      .map((task) => ({
        agent: task.agent,
        cwd: task.cwd,
        agentScope: task.agentScope ?? input.agentScope,
        confirmProjectAgents: task.confirmProjectAgents ?? input.confirmProjectAgents,
      }));
  }
  return typeof input.agent === "string" && input.agent.length > 0
    ? [{ agent: input.agent, cwd: input.cwd, agentScope: input.agentScope, confirmProjectAgents: input.confirmProjectAgents }]
    : [];
}

async function maybeConfirmProjectAgents(input: ResolveInput, cwd: string, ctx?: ProjectAgentApprovalContext): Promise<void> {
  const projectAgents: AgentDefinition[] = [];
  for (const request of agentRequests(input)) {
    if (request.confirmProjectAgents === false || request.agentScope === "global") continue;
    const requestCwd = resolve(cwd, request.cwd ?? ".");
    const agent = await loadAgentByName(request.agent, requestCwd, request.agentScope);
    if (agent?.source === "project" && !projectAgents.some((candidate) => candidate.sourcePath === agent.sourcePath)) {
      projectAgents.push(agent);
    }
  }
  if (projectAgents.length === 0) return;

  const names = projectAgents.map((agent) => agent.displayName).join(", ");
  const sources = projectAgents.map((agent) => agent.sourcePath).join("\n");
  if (ctx?.hasUI && ctx.ui?.confirm) {
    const approved = await ctx.ui.confirm(
      "Run project-local subagent definitions?",
      `Agents: ${names}\nSources:\n${sources}\n\nProject agents are repository-controlled. Continue only for trusted repositories.`,
    );
    if (!approved) throw new Error("Canceled: project-local subagent definitions were not approved.");
    return;
  }

  throw new Error('Project-local subagent definitions require interactive approval or confirmProjectAgents:false.');
}

function completionPayload(result: ResultEnvelope, mode: ExecutionMode) {
  return {
    tool: TOOL_NAME,
    event: "complete",
    mode,
    runId: result.runId,
    taskId: result.taskId,
    backend: result.backend,
    status: result.status,
    failureKind: result.failureKind,
    artifacts: artifactSummary(result.artifacts),
  };
}

function notifyCompletion(input: ResolveInput, result: ResultEnvelope, mode: ExecutionMode, onUpdate?: ToolUpdateCallback, ctx?: NotificationContext): number {
  if (input.onComplete !== "notify") return 0;
  const payload = completionPayload(result, mode);
  let updatesSent = 0;
  try {
    onUpdate?.({ content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], details: payload });
    if (onUpdate) updatesSent += 1;
  } catch {
    // Completion notifications must not change the task result.
  }
  try {
    ctx?.ui?.notify?.(`subagent ${result.runId}/${result.taskId} ${result.status}`, result.status === "completed" ? "info" : "warning");
    if (ctx?.ui?.notify) updatesSent += 1;
  } catch {
    // Completion notifications must not change the task result.
  }
  return updatesSent;
}

async function annotateCompletion(
  store: Awaited<ReturnType<typeof createTaskArtifactStore>>,
  input: ResolveInput,
  result: ResultEnvelope,
  updatesSent: number,
): Promise<ResultEnvelope> {
  const completion = {
    onComplete: input.onComplete ?? null,
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

async function startAsyncRun(input: ResolveInput, cwd: string, backend: ResolvedBackend, signal?: AbortSignal, onUpdate?: ToolUpdateCallback, ctx?: NotificationContext): Promise<ResultEnvelope> {
  const startedAt = new Date();
  const runId = createRunId(startedAt);
  const taskId = "task-1";
  const mode = executionMode(input);
  const dependency = input.asyncDependency ?? "unclassified";
  const sandboxed = input.sandbox !== undefined && input.sandbox !== null;
  const store = await createTaskArtifactStore({ cwd, runId, taskId });
  const running = await store.writeResult({
    backend,
    status: "running",
    failureKind: null,
    cwd,
    startedAt,
    completedAt: null,
    workspace: { mode: "shared", cwd },
    sandbox: { enabled: sandboxed },
    exitCode: null,
    signal: null,
    artifacts: [],
  });
  await beginRunRecord({
    cwd,
    runId,
    mode,
    backend,
    startedAt,
    dependency,
    aggregateTaskId: mode === "parallel" ? taskId : null,
    tasks: [{ taskId, status: "running", backend }],
  });
  await appendRunEvent({ cwd, runId }, { type: "run.started", status: "running", message: `${mode} async run started`, data: { dependency } });

  void (async () => {
    if (mode === "parallel") {
      const parallel = await runParallelSubagentTasks(input, cwd, signal, { runId, taskIdOffset: 1 });
      const updatesSent = notifyCompletion(input, parallel.aggregate, mode, onUpdate, ctx);
      await annotateCompletion(store, input, parallel.aggregate, updatesSent);
      return;
    }

    if (input.onComplete === "notify") {
      const result = await runSubagentTask({ input, cwd, signal, runId, taskId, runMode: mode });
      const updatesSent = notifyCompletion(input, result, mode, onUpdate, ctx);
      await annotateCompletion(store, input, result, updatesSent);
      return;
    }

    const result = await runSubagentTask({ input, cwd, signal, runId, taskId, runMode: mode });
    await annotateCompletion(store, input, result, 0);
  })().catch(async (error) => {
    await appendRunEvent({ cwd, runId }, { type: "run.failed", status: "failed", message: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
    await store.writeResult({
      backend,
      status: "failed",
      failureKind: "internal",
      cwd,
      startedAt,
      completedAt: new Date(),
      workspace: { mode: "shared", cwd },
      sandbox: { enabled: sandboxed },
      exitCode: null,
      signal: null,
      artifacts: [await store.writeTextArtifact("stderr", `${error instanceof Error ? error.message : String(error)}\n`)],
    });
  });

  return running;
}

export default function registerSubagentEngine(pi: ExtensionAPI) {
  if (typeof pi.registerCommand === "function") {
    pi.registerCommand("subagent", {
      description: "Subagent utilities. Use `/subagent panel` to open the live status panel.",
      getArgumentCompletions(prefix) {
        const items = [{ value: "panel", label: "panel", description: "Open the live Subagents status panel" }];
        const filtered = items.filter((item) => item.value.startsWith(prefix.trim()));
        return filtered.length > 0 ? filtered : null;
      },
      async handler(args, ctx) {
        if (args.trim() !== "panel") {
          ctx.ui.notify?.('Usage: /subagent panel', "warning");
          return;
        }
        await showSubagentPanel(ctx);
      },
    });
  }

  pi.registerTool({
    name: TOOL_NAME,
    label: "Subagent",
    description:
      "Subagent engine. Executes headless/tmux/inline agent-task workers; supports workspace:auto/worktree isolation, bounded parallel fanout, async lifecycle lookup, mark-background, and conservative interrupt.",
    parameters: Type.Object({
      backend: Type.Optional(Type.Union(BACKENDS.map((value) => Type.Literal(value)))),
      visible: Type.Optional(Type.Boolean()),
      sandbox: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])), 
      agent: Type.Optional(Type.String({ minLength: 1 })),
      task: Type.Optional(Type.String({ minLength: 1 })),
      roleContext: Type.Optional(Type.String({ minLength: 1 })),
      agentScope: Type.Optional(Type.Union(AGENT_SCOPES.map((value) => Type.Literal(value)))),
      confirmProjectAgents: Type.Optional(Type.Boolean()),
      mode: Type.Optional(Type.Union(EXECUTION_MODES.map((value) => Type.Literal(value)))),
      tasks: Type.Optional(Type.Array(SUBAGENT_TASK_SCHEMA, { minItems: 1 })),
      concurrency: Type.Optional(Type.Number({ minimum: 1, description: `Maximum parallel tasks to run at once. Default ${DEFAULT_PARALLEL_CONCURRENCY}.` })),
      asyncDependency: Type.Optional(Type.Union(ASYNC_DEPENDENCIES.map((value) => Type.Literal(value)), { description: "Whether an async run is needed before final, background, or unclassified." })),
      workspace: Type.Optional(
        Type.Union([
          Type.Union(WORKSPACE_MODES.map((value) => Type.Literal(value))),
          Type.Object({
            mode: Type.Optional(Type.Union(WORKSPACE_MODES.map((value) => Type.Literal(value)))),
            path: Type.Optional(Type.String({ minLength: 1 })),
          }),
        ]),
      ),
      worktree: Type.Optional(Type.Union([Type.Boolean(), Type.String({ minLength: 1 })])),
      worktreePolicy: Type.Optional(Type.Union(WORKTREE_POLICIES.map((value) => Type.Literal(value)))),
      cwd: Type.Optional(Type.String({ minLength: 1 })),
      async: Type.Optional(Type.Boolean()),
      onComplete: Type.Optional(Type.Union(ON_COMPLETE_ACTIONS.map((value) => Type.Literal(value)))),
      timeoutMs: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
      model: Type.Optional(Type.String({ minLength: 1, description: "Optional Pi model pattern or provider/model id for model-backed subagents." })),
      tools: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Optional tool allowlist for agentless model-backed runs. Ignored when agent is set; define agent tools in the agent file. Use [] to disable tools for an agentless run." })),
      thinking: Type.Optional(Type.Union(THINKING_LEVELS.map((value) => Type.Literal(value)), { description: "Optional Pi thinking/reasoning level." })),
      thinkingLevel: Type.Optional(Type.Union(THINKING_LEVELS.map((value) => Type.Literal(value)), { description: "Alias for thinking." })),
      reasoningLevel: Type.Optional(Type.Union(THINKING_LEVELS.map((value) => Type.Literal(value)), { description: "Alias for thinking." })),
      action: Type.Optional(
        Type.Union(
          [Type.Literal("run"), Type.Literal("status"), Type.Literal("logs"), Type.Literal("wait"), Type.Literal("interrupt"), Type.Literal("mark-background")],
          { default: "run", description: "What to do. Default \"run\" starts a new subagent. status/logs/wait/interrupt/mark-background operate on an existing runId." },
        ),
      ),
      runId: Type.Optional(Type.String({ minLength: 1 })),
      taskId: Type.Optional(Type.String({ minLength: 1 })),
      pollIntervalMs: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
      reason: Type.Optional(Type.String({ minLength: 1 })),
      signal: Type.Optional(Type.Union([Type.Literal("SIGINT"), Type.Literal("SIGTERM"), Type.Literal("SIGKILL")])),
      escalateAfterMs: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
      killAfterMs: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    }),
    async execute(toolCallIdOrArgs, maybeParams, signal, onUpdate, ctx) {
      const params = getExecuteParams(toolCallIdOrArgs, maybeParams);
      const cwd = getCwd(ctx);

      try {
        const raw = isRecord(params) ? params : {};
        const lifecycle = await lifecycleAction(raw, cwd);
        if (lifecycle !== null) return lifecycle;

        const validation = validateResolveInput(params);
        if (!validation.ok) return validationFailure(validation.failure);

        const resolved = resolveBackend(validation.input);
        if (resolved.status === "failed") return validationFailure(resolved);

        const unsupportedError = unsupportedPathError(raw, validation.input, resolved.backend);
        if (unsupportedError) {
          const result = await writeUnsupportedResult(cwd, resolved.backend, validation.input);
          return textResult(compactResult(result, unsupportedError), true, { result, resolved });
        }

        const runCwd = validation.input.cwd ?? cwd;
        await maybeConfirmProjectAgents(validation.input, runCwd, ctx as ProjectAgentApprovalContext);
        const mode = executionMode(validation.input);
        if (validation.input.async === true || validation.input.onComplete === "detach" || validation.input.onComplete === "notify") {
          const result = await startAsyncRun(validation.input, runCwd, resolved.backend, signal, onUpdate, ctx as NotificationContext);
          return textResult(compactResult(result), false, { result, resolved });
        }

        if (mode === "parallel") {
          const parallel = await runParallelSubagentTasks(validation.input, runCwd, signal);
          const tasks = parallel.results.map((result) => compactResult(result));
          const failed = parallel.aggregate.status !== "completed";
          return textResult(
            {
              tool: TOOL_NAME,
              mode: "parallel",
              status: parallel.aggregate.status,
              failureKind: parallel.aggregate.failureKind,
              runId: parallel.runId,
              concurrencyLimit: parallel.concurrency,
              aggregate: compactResult(parallel.aggregate),
              tasks,
            },
            failed,
            { aggregate: parallel.aggregate, results: parallel.results, resolved },
          );
        }

        const result = await runSubagentTask({ input: validation.input, cwd: runCwd, signal });
        return textResult(compactResult(result), result.status !== "completed", { result, resolved });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return textResult(
          {
            tool: TOOL_NAME,
            status: "failed",
            failureKind: error instanceof WorkspacePolicyError || error instanceof InputValidationError ? error.failureKind : "internal",
            error: message,
          },
          true,
        );
      }
    },
  });
}
