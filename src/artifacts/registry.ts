import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AsyncDependency, ExecutionMode, FailureKind, ResolvedBackend, Status } from "../core/constants.ts";
import type { ArtifactRef, ResultEnvelope, ResultTmuxMetadata, ResultWorkspace } from "./result.ts";

const DEFAULT_RUNS_DIR = ".pi/agent/runs";
const RUN_RECORD_SCHEMA_VERSION = 1 as const;
const RUN_EVENT_SCHEMA_VERSION = 1 as const;
const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const mutationQueues = new Map<string, Promise<void>>();

export type RunEventType =
  | "run.started"
  | "run.updated"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "task.started"
  | "task.process_started"
  | "task.completed"
  | "task.failed"
  | "task.cancelled"
  | "run.interrupt_requested"
  | "run.mark_background";

export interface ProcessMetadata {
  pid: number;
  processGroupId?: number;
  command?: string;
}

export interface RunTaskRecord {
  taskId: string;
  status: Status;
  backend?: ResolvedBackend;
  failureKind: FailureKind | null;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  artifactCwd?: string;
  resultPath?: string;
  stdoutPath?: string;
  stderrPath?: string;
  outputPath?: string;
  workspace?: Partial<ResultWorkspace>;
  process?: ProcessMetadata;
  tmux?: ResultTmuxMetadata;
}

export interface RunRecord {
  schemaVersion: typeof RUN_RECORD_SCHEMA_VERSION;
  runId: string;
  mode: ExecutionMode;
  status: Status;
  failureKind: FailureKind | null;
  dependency: AsyncDependency | null;
  backend?: ResolvedBackend;
  cwd: string;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  aggregateTaskId: string | null;
  tasks: RunTaskRecord[];
  interrupt?: {
    requestedAt: string;
    signal: NodeJS.Signals;
    reason: string | null;
  };
}

export interface RunEvent {
  schemaVersion: typeof RUN_EVENT_SCHEMA_VERSION;
  timestamp: string;
  type: RunEventType;
  runId: string;
  taskId?: string;
  status?: Status;
  message?: string;
  data?: Record<string, unknown>;
}

export interface RunRef {
  cwd?: string;
  runId: string;
  runsDir?: string;
}

export interface RunPaths {
  cwd: string;
  runsDir: string;
  runDir: string;
  runJsonPath: string;
  eventsPath: string;
}

export interface BeginRunOptions extends RunRef {
  mode: ExecutionMode;
  backend?: ResolvedBackend;
  startedAt?: Date | string;
  dependency?: AsyncDependency | null;
  aggregateTaskId?: string | null;
  tasks?: Array<Pick<RunTaskRecord, "taskId"> & Partial<RunTaskRecord>>;
}

export interface UpsertTaskOptions extends RunRef {
  taskId: string;
  status: Status;
  backend?: ResolvedBackend;
  failureKind?: FailureKind | null;
  startedAt?: Date | string;
  completedAt?: Date | string | null;
  artifactCwd?: string;
  resultPath?: string;
  stdoutPath?: string;
  stderrPath?: string;
  outputPath?: string;
  workspace?: Partial<ResultWorkspace>;
  process?: ProcessMetadata;
  tmux?: ResultTmuxMetadata;
}

function assertSafeId(name: string, value: string): void {
  if (!SAFE_ID_PATTERN.test(value)) throw new Error(`${name} must contain only letters, numbers, dots, underscores, or dashes.`);
}

function isInsideOrEqual(parent: string, child: string): boolean {
  const childRelative = relative(parent, child);
  return childRelative === "" || (!childRelative.startsWith("..") && !isAbsolute(childRelative));
}

function toIso(value: Date | string | undefined, fallback = new Date()): string {
  const date = value === undefined ? fallback : typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) throw new Error("timestamp must be a valid ISO timestamp or Date.");
  return date.toISOString();
}

function toSafeRelativePath(cwd: string, artifactPath: string): string {
  const artifactRelative = relative(cwd, artifactPath);
  if (artifactRelative === "" || artifactRelative.startsWith("..") || isAbsolute(artifactRelative)) {
    throw new Error("artifact path must stay inside cwd to be exposed as a relative tool path.");
  }
  return artifactRelative.split(sep).join("/");
}

function artifactPath(result: ResultEnvelope, type: ArtifactRef["type"]): string | undefined {
  return result.artifacts.find((artifact) => artifact.type === type)?.path;
}

function sortTasks(tasks: RunTaskRecord[]): RunTaskRecord[] {
  return [...tasks].sort((a, b) => a.taskId.localeCompare(b.taskId, undefined, { numeric: true }));
}

function aggregateStatus(tasks: readonly RunTaskRecord[]): { status: Status; failureKind: FailureKind | null; completedAt: string | null } {
  const executable = tasks.filter((task) => !task.taskId.startsWith("aggregate"));
  const candidates = executable.length > 0 ? executable : tasks;
  if (candidates.some((task) => task.status === "running")) return { status: "running", failureKind: null, completedAt: null };
  if (candidates.some((task) => task.status === "pending")) return { status: "pending", failureKind: null, completedAt: null };
  const failed = candidates.find((task) => task.status === "failed");
  if (failed) return { status: "failed", failureKind: failed.failureKind ?? "internal", completedAt: latestCompletedAt(candidates) };
  const cancelled = candidates.find((task) => task.status === "cancelled");
  if (cancelled) return { status: "cancelled", failureKind: cancelled.failureKind ?? "cancelled", completedAt: latestCompletedAt(candidates) };
  if (candidates.length === 0) return { status: "pending", failureKind: null, completedAt: null };
  return { status: "completed", failureKind: null, completedAt: latestCompletedAt(candidates) };
}

function latestCompletedAt(tasks: readonly RunTaskRecord[]): string | null {
  const completed = tasks.map((task) => task.completedAt).filter((value): value is string => value !== null).sort();
  return completed.at(-1) ?? null;
}

function mergeDefined<T extends Record<string, unknown>>(base: T, patch: Partial<T>): T {
  const next = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (next as Record<string, unknown>)[key] = value;
  }
  return next;
}

function isRunRecord(value: unknown): value is RunRecord {
  return typeof value === "object" && value !== null && (value as { schemaVersion?: unknown }).schemaVersion === RUN_RECORD_SCHEMA_VERSION && typeof (value as { runId?: unknown }).runId === "string";
}

export function runPaths(ref: RunRef): RunPaths {
  assertSafeId("runId", ref.runId);
  const cwd = resolve(ref.cwd ?? process.cwd());
  const runsDir = resolve(cwd, ref.runsDir ?? DEFAULT_RUNS_DIR);
  if (!isInsideOrEqual(cwd, runsDir)) throw new Error("runsDir must be inside cwd so registry refs remain relative and safe.");
  const runDir = join(runsDir, ref.runId);
  return {
    cwd,
    runsDir,
    runDir,
    runJsonPath: join(runDir, "run.json"),
    eventsPath: join(runDir, "events.jsonl"),
  };
}

export function runRecordPath(ref: RunRef): string {
  return toSafeRelativePath(runPaths(ref).cwd, runPaths(ref).runJsonPath);
}

async function readRecordPath(path: string): Promise<RunRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return isRunRecord(parsed) ? parsed : null;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeRecordPath(path: string, record: RunRecord): Promise<RunRecord> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`);
  await rename(tempPath, path);
  return record;
}

async function withRunMutation<T>(ref: RunRef, fn: (record: RunRecord | null, paths: RunPaths) => Promise<{ record: RunRecord; value: T }>): Promise<T> {
  const paths = runPaths(ref);
  await mkdir(paths.runDir, { recursive: true });
  const key = paths.runJsonPath;
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveCurrent) => { release = resolveCurrent; });
  const queued = previous.then(() => current, () => current);
  mutationQueues.set(key, queued);
  await previous.catch(() => undefined);
  try {
    const existing = await readRecordPath(paths.runJsonPath);
    const { record, value } = await fn(existing, paths);
    await writeRecordPath(paths.runJsonPath, record);
    return value;
  } finally {
    release();
    if (mutationQueues.get(key) === queued) mutationQueues.delete(key);
  }
}

export async function readRunRecord(ref: RunRef): Promise<RunRecord | null> {
  return await readRecordPath(runPaths(ref).runJsonPath);
}

export async function beginRunRecord(options: BeginRunOptions): Promise<RunRecord> {
  const now = toIso(options.startedAt);
  return await withRunMutation(options, async (existing, paths) => {
    if (existing !== null) {
      const tasks = [...existing.tasks];
      for (const task of options.tasks ?? []) {
        if (tasks.some((candidate) => candidate.taskId === task.taskId)) continue;
        tasks.push({
          taskId: task.taskId,
          status: task.status ?? "pending",
          backend: task.backend ?? options.backend,
          failureKind: task.failureKind ?? null,
          startedAt: task.startedAt ?? now,
          updatedAt: task.updatedAt ?? now,
          completedAt: task.completedAt ?? null,
          artifactCwd: task.artifactCwd,
          resultPath: task.resultPath,
          stdoutPath: task.stdoutPath,
          stderrPath: task.stderrPath,
          outputPath: task.outputPath,
          workspace: task.workspace,
          process: task.process,
          tmux: task.tmux,
        });
      }
      const aggregate = aggregateStatus(tasks.filter((task) => task.taskId !== (existing.aggregateTaskId ?? options.aggregateTaskId ?? null)));
      const merged: RunRecord = {
        ...existing,
        mode: existing.mode ?? options.mode,
        backend: existing.backend ?? options.backend,
        dependency: existing.dependency ?? options.dependency ?? null,
        aggregateTaskId: existing.aggregateTaskId ?? options.aggregateTaskId ?? null,
        status: aggregate.status,
        failureKind: aggregate.failureKind,
        completedAt: aggregate.completedAt,
        updatedAt: now,
        tasks: sortTasks(tasks),
      };
      return { record: merged, value: merged };
    }
    const tasks: RunTaskRecord[] = sortTasks((options.tasks ?? []).map((task) => ({
      taskId: task.taskId,
      status: task.status ?? "pending",
      backend: task.backend ?? options.backend,
      failureKind: task.failureKind ?? null,
      startedAt: task.startedAt ?? now,
      updatedAt: task.updatedAt ?? now,
      completedAt: task.completedAt ?? null,
      artifactCwd: task.artifactCwd,
      resultPath: task.resultPath,
      stdoutPath: task.stdoutPath,
      stderrPath: task.stderrPath,
      outputPath: task.outputPath,
      workspace: task.workspace,
      process: task.process,
      tmux: task.tmux,
    })));
    const aggregate = aggregateStatus(tasks);
    const record: RunRecord = {
      schemaVersion: RUN_RECORD_SCHEMA_VERSION,
      runId: options.runId,
      mode: options.mode,
      status: tasks.length > 0 ? aggregate.status : "pending",
      failureKind: tasks.length > 0 ? aggregate.failureKind : null,
      dependency: options.dependency ?? null,
      ...(options.backend === undefined ? {} : { backend: options.backend }),
      cwd: paths.cwd,
      startedAt: now,
      updatedAt: now,
      completedAt: tasks.length > 0 ? aggregate.completedAt : null,
      aggregateTaskId: options.aggregateTaskId ?? null,
      tasks,
    };
    return { record, value: record };
  });
}

export async function upsertRunTask(options: UpsertTaskOptions): Promise<RunRecord> {
  const now = new Date().toISOString();
  return await withRunMutation(options, async (existing, paths) => {
    const startedAt = toIso(options.startedAt, new Date());
    const completedAt = options.completedAt === undefined ? (options.status === "pending" || options.status === "running" ? null : now) : options.completedAt === null ? null : toIso(options.completedAt);
    const taskPatch: Partial<RunTaskRecord> = {
      status: options.status,
      backend: options.backend,
      failureKind: options.failureKind ?? null,
      updatedAt: now,
      completedAt,
      artifactCwd: options.artifactCwd,
      resultPath: options.resultPath,
      stdoutPath: options.stdoutPath,
      stderrPath: options.stderrPath,
      outputPath: options.outputPath,
      workspace: options.workspace,
      process: options.process,
      tmux: options.tmux,
    };
    const baseRecord: RunRecord = existing ?? {
      schemaVersion: RUN_RECORD_SCHEMA_VERSION,
      runId: options.runId,
      mode: "single",
      status: "pending",
      failureKind: null,
      dependency: null,
      backend: options.backend,
      cwd: paths.cwd,
      startedAt,
      updatedAt: now,
      completedAt: null,
      aggregateTaskId: null,
      tasks: [],
    };
    const tasks = [...baseRecord.tasks];
    const index = tasks.findIndex((task) => task.taskId === options.taskId);
    if (index >= 0) {
      tasks[index] = mergeDefined(tasks[index], taskPatch);
    } else {
      tasks.push(mergeDefined({
        taskId: options.taskId,
        status: options.status,
        backend: options.backend,
        failureKind: options.failureKind ?? null,
        startedAt,
        updatedAt: now,
        completedAt,
      }, taskPatch));
    }
    const aggregate = aggregateStatus(tasks.filter((task) => task.taskId !== baseRecord.aggregateTaskId));
    const record: RunRecord = {
      ...baseRecord,
      backend: baseRecord.backend ?? options.backend,
      status: aggregate.status,
      failureKind: aggregate.failureKind,
      updatedAt: now,
      completedAt: aggregate.completedAt,
      tasks: sortTasks(tasks),
    };
    return { record, value: record };
  });
}

export async function updateTaskProcess(ref: RunRef & { taskId: string; process: ProcessMetadata }): Promise<RunRecord> {
  return await upsertRunTask({ ...ref, status: "running", process: ref.process, completedAt: null });
}

export async function finishTaskFromResult(baseRef: RunRef, result: ResultEnvelope): Promise<RunRecord> {
  return await upsertRunTask({
    ...baseRef,
    taskId: result.taskId,
    status: result.status,
    backend: result.backend,
    failureKind: result.failureKind,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    artifactCwd: result.cwd,
    resultPath: artifactPath(result, "result"),
    stdoutPath: artifactPath(result, "stdout"),
    stderrPath: artifactPath(result, "stderr"),
    outputPath: artifactPath(result, "output"),
    workspace: result.workspace,
    tmux: result.tmux,
  });
}

export async function setRunDependency(ref: RunRef, dependency: AsyncDependency): Promise<RunRecord> {
  const now = new Date().toISOString();
  return await withRunMutation(ref, async (existing, paths) => {
    if (existing === null) throw new Error(`No run found with id: ${ref.runId}`);
    const record = { ...existing, dependency, updatedAt: now, cwd: paths.cwd };
    return { record, value: record };
  });
}

export async function recordInterruptRequest(ref: RunRef, signal: NodeJS.Signals, reason: string | null): Promise<RunRecord> {
  const now = new Date().toISOString();
  return await withRunMutation(ref, async (existing, paths) => {
    if (existing === null) throw new Error(`No run found with id: ${ref.runId}`);
    const record = { ...existing, updatedAt: now, cwd: paths.cwd, interrupt: { requestedAt: now, signal, reason } };
    return { record, value: record };
  });
}

export async function appendRunEvent(ref: RunRef, event: Omit<RunEvent, "schemaVersion" | "timestamp" | "runId"> & { timestamp?: string | Date }): Promise<RunEvent> {
  const paths = runPaths(ref);
  await mkdir(paths.runDir, { recursive: true });
  const payload: RunEvent = {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    timestamp: toIso(event.timestamp),
    type: event.type,
    runId: ref.runId,
    ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
    ...(event.status === undefined ? {} : { status: event.status }),
    ...(event.message === undefined ? {} : { message: event.message }),
    ...(event.data === undefined ? {} : { data: event.data }),
  };
  await appendFile(paths.eventsPath, `${JSON.stringify(payload)}\n`, "utf8");
  return payload;
}

export async function readRunEvents(ref: RunRef, limit?: number): Promise<RunEvent[]> {
  const paths = runPaths(ref);
  let text: string;
  try {
    text = await readFile(paths.eventsPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const events: RunEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as RunEvent;
      if (parsed.schemaVersion === RUN_EVENT_SCHEMA_VERSION && parsed.runId === ref.runId) events.push(parsed);
    } catch {
      // Ignore corrupt trailing lines; event log is diagnostic, not authoritative.
    }
  }
  return limit === undefined ? events : events.slice(-limit);
}

export function relativeRunRecordPath(ref: RunRef): string {
  const paths = runPaths(ref);
  return toSafeRelativePath(paths.cwd, paths.runJsonPath);
}

export function relativeRunEventsPath(ref: RunRef): string {
  const paths = runPaths(ref);
  return toSafeRelativePath(paths.cwd, paths.eventsPath);
}
