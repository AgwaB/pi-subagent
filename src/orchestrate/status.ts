import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  readRunEvents,
  readRunRecord,
  relativeRunEventsPath,
  relativeRunRecordPath,
  type ArtifactRef,
  type CompletionMetadata,
  type ResultEnvelope,
  type RunEvent,
  type RunRecord,
  type RunTaskRecord,
} from "../artifacts/index.ts";
import { STATUSES, type AsyncDependency, type ExecutionMode, type FailureKind, type ResolvedBackend, type Status } from "../core/constants.ts";

const DEFAULT_RUNS_DIR = ".pi/agent/runs";
const DEFAULT_TASK_ID = "task-1";
const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const EVENT_TAIL_LIMIT = 20;

export interface RunStatusRef {
  runId: string;
  taskId?: string;
  cwd?: string;
  runsDir?: string;
}

export interface RunLogRef extends ArtifactRef {
  type: "stdout" | "stderr" | "output" | "result";
  artifactCwd?: string;
}

export interface RunTaskStatusSnapshot {
  taskId: string;
  status: Status;
  backend: ResolvedBackend | null;
  failureKind: FailureKind | null;
  startedAt: string;
  completedAt: string | null;
  resultPath: string | null;
  outputPath: string | null;
  stdoutPath: string | null;
  stderrPath: string | null;
  artifactCwd?: string;
  pid?: number;
  processGroupId?: number;
}

export interface RunStatusSnapshot {
  runId: string;
  taskId: string;
  backend: ResolvedBackend;
  status: Status;
  failureKind: FailureKind | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  logs: RunLogRef[];
  resultPath: string | null;
  completion?: CompletionMetadata;
  mode?: ExecutionMode;
  dependency?: AsyncDependency | null;
  registryPath?: string;
  eventsPath?: string;
  eventTail?: RunEvent[];
  tasks?: RunTaskStatusSnapshot[];
}

export interface RunLogsSnapshot extends RunStatusSnapshot {
  logText: Partial<Record<RunLogRef["type"] | "events", string>>;
}

export interface WaitForRunOptions extends RunStatusRef {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface WaitForRunResult {
  status: "completed" | "timeout";
  snapshot: RunStatusSnapshot | null;
}

function assertSafeId(name: string, value: string): void {
  if (!SAFE_ID_PATTERN.test(value)) {
    throw new Error(`${name} must contain only letters, numbers, dots, underscores, or dashes.`);
  }
}

function isInsideOrEqual(parent: string, child: string): boolean {
  const childRelative = relative(parent, child);
  return childRelative === "" || (!childRelative.startsWith("..") && !isAbsolute(childRelative));
}

function resultPathFor(ref: RunStatusRef): { cwd: string; path: string } {
  assertSafeId("runId", ref.runId);
  assertSafeId("taskId", ref.taskId ?? DEFAULT_TASK_ID);
  const cwd = resolve(ref.cwd ?? process.cwd());
  const runsDir = resolve(cwd, ref.runsDir ?? DEFAULT_RUNS_DIR);
  if (!isInsideOrEqual(cwd, runsDir)) {
    throw new Error("runsDir must be inside cwd so lifecycle refs remain relative and safe.");
  }
  return { cwd, path: join(runsDir, ref.runId, ref.taskId ?? DEFAULT_TASK_ID, "result.json") };
}

function safeArtifactPath(cwd: string, artifact: Pick<RunLogRef, "path" | "artifactCwd">): string {
  if (isAbsolute(artifact.path) || artifact.path.split("/").includes("..")) throw new Error("artifact path must be a safe relative path.");
  const artifactCwd = resolve(artifact.artifactCwd ?? cwd);
  const path = resolve(artifactCwd, artifact.path.split("/").join(sep));
  if (!isInsideOrEqual(artifactCwd, path)) throw new Error("artifact path must stay inside its artifact cwd.");
  return path;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function artifactFromTask(task: RunTaskRecord, type: RunLogRef["type"], path: string | undefined): RunLogRef | null {
  if (path === undefined) return null;
  return { type, path, artifactCwd: task.artifactCwd };
}

function taskSnapshot(task: RunTaskRecord): RunTaskStatusSnapshot {
  return {
    taskId: task.taskId,
    status: task.status,
    backend: task.backend ?? null,
    failureKind: task.failureKind,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    resultPath: task.resultPath ?? null,
    outputPath: task.outputPath ?? null,
    stdoutPath: task.stdoutPath ?? null,
    stderrPath: task.stderrPath ?? null,
    ...(task.artifactCwd === undefined ? {} : { artifactCwd: task.artifactCwd }),
    ...(task.process?.pid === undefined ? {} : { pid: task.process.pid }),
    ...(task.process?.processGroupId === undefined ? {} : { processGroupId: task.process.processGroupId }),
  };
}

function resultLogs(result: ResultEnvelope): RunLogRef[] {
  return result.artifacts
    .filter((artifact): artifact is RunLogRef => artifact.type === "stdout" || artifact.type === "stderr" || artifact.type === "output" || artifact.type === "result")
    .map((artifact) => ({ ...artifact, artifactCwd: result.cwd }));
}

export function isStatus(value: unknown): value is Status {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}

export function isTerminalStatus(status: Status): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function statusSucceeded(status: Status): boolean {
  return status === "completed";
}

export function statusFailedClosed(status: Status, failureKind: FailureKind | null): boolean {
  return (status === "failed" || status === "cancelled") && failureKind !== null;
}

export function createRunStatusSnapshot(result: ResultEnvelope): RunStatusSnapshot {
  const logs = resultLogs(result);
  const resultArtifact = logs.find((artifact) => artifact.type === "result") ?? null;

  return {
    runId: result.runId,
    taskId: result.taskId,
    backend: result.backend,
    status: result.status,
    failureKind: result.failureKind,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    durationMs: result.durationMs,
    logs,
    resultPath: resultArtifact?.path ?? null,
    ...(result.completion === undefined ? {} : { completion: result.completion }),
  };
}

export async function readRunResult(ref: RunStatusRef): Promise<ResultEnvelope | null> {
  const { path } = resultPathFor(ref);
  try {
    return JSON.parse(await readFile(path, "utf8")) as ResultEnvelope;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function readTaskResultFromRecord(task: RunTaskRecord): Promise<ResultEnvelope | null> {
  if (task.resultPath === undefined || task.artifactCwd === undefined) return null;
  try {
    return JSON.parse(await readFile(safeArtifactPath(task.artifactCwd, { path: task.resultPath }), "utf8")) as ResultEnvelope;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function recordLogs(task: RunTaskRecord): RunLogRef[] {
  return [
    artifactFromTask(task, "stdout", task.stdoutPath),
    artifactFromTask(task, "stderr", task.stderrPath),
    artifactFromTask(task, "output", task.outputPath),
    artifactFromTask(task, "result", task.resultPath),
  ].filter((artifact): artifact is RunLogRef => artifact !== null);
}

function snapshotFromRecord(record: RunRecord, ref: RunStatusRef, events: RunEvent[]): RunStatusSnapshot {
  const selectedTask = record.tasks.find((task) => task.taskId === (ref.taskId ?? record.aggregateTaskId ?? DEFAULT_TASK_ID)) ?? record.tasks[0];
  return {
    runId: record.runId,
    taskId: selectedTask?.taskId ?? ref.taskId ?? DEFAULT_TASK_ID,
    backend: selectedTask?.backend ?? record.backend ?? "headless",
    status: ref.taskId === undefined ? record.status : (selectedTask?.status ?? record.status),
    failureKind: ref.taskId === undefined ? record.failureKind : (selectedTask?.failureKind ?? record.failureKind),
    startedAt: selectedTask?.startedAt ?? record.startedAt,
    completedAt: ref.taskId === undefined ? record.completedAt : (selectedTask?.completedAt ?? record.completedAt),
    durationMs: null,
    logs: selectedTask === undefined ? [] : recordLogs(selectedTask),
    resultPath: selectedTask?.resultPath ?? null,
    mode: record.mode,
    dependency: record.dependency,
    registryPath: relativeRunRecordPath(ref),
    eventsPath: relativeRunEventsPath(ref),
    eventTail: events,
    tasks: record.tasks.map(taskSnapshot),
  };
}

function mergeRecordSnapshot(snapshot: RunStatusSnapshot, record: RunRecord, ref: RunStatusRef, events: RunEvent[]): RunStatusSnapshot {
  const selectedTask = record.tasks.find((task) => task.taskId === snapshot.taskId);
  const isRunLevel = ref.taskId === undefined;
  return {
    ...snapshot,
    status: isRunLevel ? record.status : snapshot.status,
    failureKind: isRunLevel ? record.failureKind : snapshot.failureKind,
    completedAt: isRunLevel ? record.completedAt : snapshot.completedAt,
    mode: record.mode,
    dependency: record.dependency,
    registryPath: relativeRunRecordPath(ref),
    eventsPath: relativeRunEventsPath(ref),
    eventTail: events,
    tasks: record.tasks.map(taskSnapshot),
    logs: snapshot.logs.length > 0 ? snapshot.logs : selectedTask === undefined ? snapshot.logs : recordLogs(selectedTask),
  };
}

export async function getRunStatus(ref: RunStatusRef): Promise<RunStatusSnapshot | null> {
  const record = await readRunRecord(ref);
  const events = await readRunEvents(ref, EVENT_TAIL_LIMIT).catch(() => []);
  let result = await readRunResult(ref);
  if (result === null && record !== null && ref.taskId !== undefined) {
    const task = record.tasks.find((candidate) => candidate.taskId === ref.taskId);
    if (task !== undefined) result = await readTaskResultFromRecord(task);
  }
  if (result !== null) {
    const snapshot = createRunStatusSnapshot(result);
    return record === null ? snapshot : mergeRecordSnapshot(snapshot, record, ref, events);
  }
  return record === null ? null : snapshotFromRecord(record, ref, events);
}

export async function getRunLogs(ref: RunStatusRef): Promise<RunLogsSnapshot | null> {
  const { cwd } = resultPathFor(ref);
  const snapshot = await getRunStatus(ref);
  if (snapshot === null) return null;
  const logText: RunLogsSnapshot["logText"] = {};
  for (const artifact of snapshot.logs) {
    if (artifact.type === "result") continue;
    logText[artifact.type] = await readFile(safeArtifactPath(cwd, artifact), "utf8").catch(() => "");
  }
  if (snapshot.eventTail !== undefined) {
    logText.events = snapshot.eventTail.map((event) => JSON.stringify(event)).join("\n");
  }
  return { ...snapshot, logText };
}

export async function waitForRun(options: WaitForRunOptions): Promise<WaitForRunResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("timeoutMs must be a non-negative finite number when provided.");
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) throw new Error("pollIntervalMs must be a positive finite number when provided.");

  const deadline = Date.now() + timeoutMs;
  while (true) {
    const snapshot = await getRunStatus(options);
    if (snapshot !== null && isTerminalStatus(snapshot.status)) {
      return { status: "completed", snapshot };
    }
    if (Date.now() >= deadline) return { status: "timeout", snapshot };
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }
}
