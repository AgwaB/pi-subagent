import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AsyncDependency, ExecutionMode, FailureKind, ResolvedBackend, Status } from "../core/constants.ts";
import type { ArtifactRef, ResultEnvelope, ResultTmuxMetadata, ResultWorkspace } from "./result.ts";

const DEFAULT_RUNS_DIR = ".pi/agent/runs";
const RUN_RECORD_SCHEMA_VERSION = 2 as const;
const RUN_EVENT_SCHEMA_VERSION = 2 as const;
const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;

export type RunEventType =
  | "run.started"
  | "run.updated"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "run.interrupt_requested"
  | "run.mark_background"
  | "attempt.started"
  | "attempt.process_started"
  | "attempt.heartbeat"
  | "attempt.completed"
  | "attempt.failed"
  | "attempt.cancelled"
  | "attempt.stale_result_ignored"
  | "reconcile.completed"
  | "reconcile.failed"
  // v1 read/event compatibility
  | "task.started"
  | "task.process_started"
  | "task.completed"
  | "task.failed"
  | "task.cancelled";

export interface ProcessMetadata {
  pid: number;
  processGroupId?: number;
  command?: string;
  workerPid?: number;
  workerProcessGroupId?: number;
}

export interface RunAttemptRecord {
  attemptId: string;
  status: Status;
  backend?: ResolvedBackend;
  failureKind: FailureKind | null;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  heartbeatAt?: string;
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
  correlationId?: string;
  mode: ExecutionMode;
  status: Status;
  failureKind: FailureKind | null;
  dependency: AsyncDependency | null;
  backend?: ResolvedBackend;
  cwd: string;
  runsDir: string;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  activeAttemptId: string | null;
  latestAttemptId: string | null;
  attempts: RunAttemptRecord[];
  interrupt?: {
    requestedAt: string;
    signal: NodeJS.Signals;
    reason: string | null;
  };
  /** @deprecated v1 compatibility only. */
  aggregateTaskId?: string | null;
  /** @deprecated v1 compatibility only. */
  tasks?: Array<RunAttemptRecord & { taskId: string }>;
}

export type RunTaskRecord = RunAttemptRecord & { taskId: string };

export interface RunEvent {
  schemaVersion: typeof RUN_EVENT_SCHEMA_VERSION;
  timestamp: string;
  type: RunEventType;
  runId: string;
  attemptId?: string;
  /** @deprecated v1 compatibility only. */
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
  lockPath: string;
}

export interface BeginRunOptions extends RunRef {
  mode: ExecutionMode;
  backend?: ResolvedBackend;
  startedAt?: Date | string;
  dependency?: AsyncDependency | null;
  correlationId?: string;
  activeAttemptId?: string | null;
  attempts?: Array<Pick<RunAttemptRecord, "attemptId"> & Partial<RunAttemptRecord>>;
  /** @deprecated ignored for v2 writes. */
  aggregateTaskId?: string | null;
  /** @deprecated mapped to attempts for v1 call sites. */
  tasks?: Array<{ taskId: string } & Partial<RunTaskRecord>>;
}

export interface UpsertAttemptOptions extends RunRef {
  attemptId: string;
  status: Status;
  backend?: ResolvedBackend;
  failureKind?: FailureKind | null;
  startedAt?: Date | string;
  completedAt?: Date | string | null;
  heartbeatAt?: Date | string;
  artifactCwd?: string;
  resultPath?: string;
  stdoutPath?: string;
  stderrPath?: string;
  outputPath?: string;
  workspace?: Partial<ResultWorkspace>;
  process?: ProcessMetadata;
  tmux?: ResultTmuxMetadata;
  activate?: boolean;
}

export type UpsertTaskOptions = Omit<UpsertAttemptOptions, "attemptId"> & { taskId: string };

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

function sortAttempts(attempts: RunAttemptRecord[]): RunAttemptRecord[] {
  return [...attempts].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.attemptId.localeCompare(b.attemptId));
}

function aggregateStatus(attempts: readonly RunAttemptRecord[], latestAttemptId: string | null): { status: Status; failureKind: FailureKind | null; completedAt: string | null } {
  const active = attempts.find((attempt) => attempt.attemptId === latestAttemptId) ?? attempts.at(-1);
  if (!active) return { status: "pending", failureKind: null, completedAt: null };
  return { status: active.status, failureKind: active.failureKind ?? null, completedAt: active.completedAt };
}

function mergeDefined<T extends object>(base: T, patch: Partial<T>): T {
  const next = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (next as Record<string, unknown>)[key] = value;
  }
  return next;
}

function mergeProcessMetadata(existing: ProcessMetadata | undefined, patch: ProcessMetadata | undefined): ProcessMetadata | undefined {
  if (patch === undefined) return existing;
  return { ...(existing ?? {}), ...patch };
}

function isRunRecord(value: unknown): value is RunRecord {
  return typeof value === "object" && value !== null && (value as { schemaVersion?: unknown }).schemaVersion === RUN_RECORD_SCHEMA_VERSION && typeof (value as { runId?: unknown }).runId === "string";
}

function coerceV1Record(value: unknown, paths: RunPaths): RunRecord | null {
  if (typeof value !== "object" || value === null || typeof (value as { runId?: unknown }).runId !== "string" || !Array.isArray((value as { tasks?: unknown }).tasks)) return null;
  const raw = value as {
    runId: string;
    mode?: ExecutionMode;
    status?: Status;
    failureKind?: FailureKind | null;
    dependency?: AsyncDependency | null;
    backend?: ResolvedBackend;
    cwd?: string;
    startedAt?: string;
    updatedAt?: string;
    completedAt?: string | null;
    aggregateTaskId?: string | null;
    tasks: Array<Record<string, unknown>>;
    interrupt?: RunRecord["interrupt"];
  };
  const attempts: RunAttemptRecord[] = raw.tasks.map((task) => {
    const taskId = typeof task.taskId === "string" ? task.taskId : "task-1";
    return {
      attemptId: taskId,
      status: (task.status as Status | undefined) ?? "pending",
      backend: task.backend as ResolvedBackend | undefined,
      failureKind: (task.failureKind as FailureKind | null | undefined) ?? null,
      startedAt: typeof task.startedAt === "string" ? task.startedAt : raw.startedAt ?? new Date().toISOString(),
      updatedAt: typeof task.updatedAt === "string" ? task.updatedAt : raw.updatedAt ?? new Date().toISOString(),
      completedAt: typeof task.completedAt === "string" || task.completedAt === null ? task.completedAt : null,
      artifactCwd: typeof task.artifactCwd === "string" ? task.artifactCwd : undefined,
      resultPath: typeof task.resultPath === "string" ? task.resultPath : undefined,
      stdoutPath: typeof task.stdoutPath === "string" ? task.stdoutPath : undefined,
      stderrPath: typeof task.stderrPath === "string" ? task.stderrPath : undefined,
      outputPath: typeof task.outputPath === "string" ? task.outputPath : undefined,
      workspace: typeof task.workspace === "object" && task.workspace !== null ? task.workspace as Partial<ResultWorkspace> : undefined,
      process: typeof task.process === "object" && task.process !== null ? task.process as ProcessMetadata : undefined,
      tmux: typeof task.tmux === "object" && task.tmux !== null ? task.tmux as ResultTmuxMetadata : undefined,
    };
  });
  const latest = raw.aggregateTaskId ?? attempts.at(-1)?.attemptId ?? null;
  return {
    schemaVersion: RUN_RECORD_SCHEMA_VERSION,
    runId: raw.runId,
    mode: raw.mode ?? "single",
    status: raw.status ?? aggregateStatus(attempts, latest).status,
    failureKind: raw.failureKind ?? aggregateStatus(attempts, latest).failureKind,
    dependency: raw.dependency ?? null,
    ...(raw.backend === undefined ? {} : { backend: raw.backend }),
    cwd: raw.cwd ?? paths.cwd,
    runsDir: toSafeRelativePath(paths.cwd, paths.runsDir),
    startedAt: raw.startedAt ?? new Date().toISOString(),
    updatedAt: raw.updatedAt ?? new Date().toISOString(),
    completedAt: raw.completedAt ?? null,
    activeAttemptId: raw.status === "running" || raw.status === "pending" ? latest : null,
    latestAttemptId: latest,
    attempts,
    interrupt: raw.interrupt,
    aggregateTaskId: raw.aggregateTaskId ?? null,
    tasks: raw.tasks.map((task) => ({ ...(attempts.find((attempt) => attempt.attemptId === task.taskId) ?? attempts[0]!), taskId: String(task.taskId ?? "task-1") })),
  };
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
    lockPath: join(runDir, "run.lock"),
  };
}

export function runRecordPath(ref: RunRef): string {
  const paths = runPaths(ref);
  return toSafeRelativePath(paths.cwd, paths.runJsonPath);
}

export function relativeRunRecordPath(ref: RunRef): string {
  return runRecordPath(ref);
}

export function relativeRunEventsPath(ref: RunRef): string {
  const paths = runPaths(ref);
  return toSafeRelativePath(paths.cwd, paths.eventsPath);
}

async function readRecordPath(paths: RunPaths): Promise<RunRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(paths.runJsonPath, "utf8"));
    return isRunRecord(parsed) ? parsed : coerceV1Record(parsed, paths);
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function lockHolderPid(content: string): number | null {
  const pid = Number.parseInt(content.split("\n")[0] ?? "", 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function lockIsStale(lockPath: string): Promise<boolean> {
  try {
    const content = await readFile(lockPath, "utf8");
    const pid = lockHolderPid(content);
    if (pid !== null) return !pidAlive(pid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; // already released
    // Unreadable content: fall through to the mtime heuristic below.
  }
  try {
    const info = await stat(lockPath);
    return Date.now() - info.mtimeMs > LOCK_TIMEOUT_MS;
  } catch {
    return false;
  }
}

async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  while (handle === undefined) {
    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
      // Two waiters can both judge a lock stale and race rm/open; the loser's rm
      // can unlink the winner's fresh lock. Confirm the path still carries our
      // pid; if not, we lost the race and must retry.
      const owner = lockHolderPid(await readFile(lockPath, "utf8").catch(() => ""));
      if (owner !== process.pid) {
        await handle.close().catch(() => undefined);
        handle = undefined;
        await sleep(LOCK_RETRY_MS);
        continue;
      }
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
      // Reclaim only locks whose recorded holder is provably gone (or whose
      // content is unreadable and stale by mtime); never steal from a live holder.
      if (await lockIsStale(lockPath)) {
        await rm(lockPath, { force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for run lock ${lockPath}; the lock is held by a live process. Retry later or remove the file if the holder is wedged.`);
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    await handle.close().catch(() => undefined);
    // Release only if we still own the lock; a reclaimed lock may now belong
    // to another process and must not be deleted out from under it.
    try {
      if (lockHolderPid(await readFile(lockPath, "utf8")) === process.pid) {
        await rm(lockPath, { force: true });
      }
    } catch {
      // Lock already released or unreadable; leave it alone.
    }
  }
}

async function withRunMutation<T>(ref: RunRef, fn: (record: RunRecord | null, paths: RunPaths) => Promise<{ record: RunRecord; value: T }>): Promise<T> {
  const paths = runPaths(ref);
  await mkdir(paths.runDir, { recursive: true });
  return await withFileLock(paths.lockPath, async () => {
    const existing = await readRecordPath(paths);
    const { record, value } = await fn(existing, paths);
    await writeRecordPath(paths.runJsonPath, record);
    return value;
  });
}

export async function readRunRecord(ref: RunRef): Promise<RunRecord | null> {
  return await readRecordPath(runPaths(ref));
}

function normalizeAttemptSeed(task: Pick<RunAttemptRecord, "attemptId"> & Partial<RunAttemptRecord>, now: string, backend?: ResolvedBackend): RunAttemptRecord {
  return {
    attemptId: task.attemptId,
    status: task.status ?? "pending",
    backend: task.backend ?? backend,
    failureKind: task.failureKind ?? null,
    startedAt: task.startedAt ?? now,
    updatedAt: task.updatedAt ?? now,
    completedAt: task.completedAt ?? null,
    heartbeatAt: task.heartbeatAt,
    artifactCwd: task.artifactCwd,
    resultPath: task.resultPath,
    stdoutPath: task.stdoutPath,
    stderrPath: task.stderrPath,
    outputPath: task.outputPath,
    workspace: task.workspace,
    process: task.process,
    tmux: task.tmux,
  };
}

function v1TasksToAttempts(tasks: BeginRunOptions["tasks"], now: string, backend?: ResolvedBackend): RunAttemptRecord[] {
  return (tasks ?? []).map((task) => normalizeAttemptSeed({ ...task, attemptId: task.taskId }, now, backend));
}

export async function beginRunRecord(options: BeginRunOptions): Promise<RunRecord> {
  const now = toIso(options.startedAt);
  return await withRunMutation(options, async (existing, paths) => {
    const nextAttempts = [...(options.attempts ?? []), ...v1TasksToAttempts(options.tasks, now, options.backend)];
    const attempts = [...(existing?.attempts ?? [])];
    for (const attempt of nextAttempts) {
      if (attempts.some((candidate) => candidate.attemptId === attempt.attemptId)) continue;
      attempts.push(normalizeAttemptSeed(attempt, now, options.backend));
    }
    const latestAttemptId = options.activeAttemptId ?? existing?.latestAttemptId ?? attempts.at(-1)?.attemptId ?? null;
    const activeAttemptId = options.activeAttemptId ?? existing?.activeAttemptId ?? (latestAttemptId && ["pending", "running"].includes(attempts.find((attempt) => attempt.attemptId === latestAttemptId)?.status ?? "") ? latestAttemptId : null);
    const aggregate = aggregateStatus(attempts, latestAttemptId);
    const record: RunRecord = existing === null
      ? {
          schemaVersion: RUN_RECORD_SCHEMA_VERSION,
          runId: options.runId,
          ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
          mode: options.mode,
          status: attempts.length > 0 ? aggregate.status : "pending",
          failureKind: attempts.length > 0 ? aggregate.failureKind : null,
          dependency: options.dependency ?? null,
          ...(options.backend === undefined ? {} : { backend: options.backend }),
          cwd: paths.cwd,
          runsDir: toSafeRelativePath(paths.cwd, paths.runsDir),
          startedAt: now,
          updatedAt: now,
          completedAt: attempts.length > 0 ? aggregate.completedAt : null,
          activeAttemptId,
          latestAttemptId,
          attempts: sortAttempts(attempts),
        }
      : {
          ...existing,
          ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
          mode: existing.mode ?? options.mode,
          backend: existing.backend ?? options.backend,
          dependency: existing.dependency ?? options.dependency ?? null,
          cwd: paths.cwd,
          runsDir: toSafeRelativePath(paths.cwd, paths.runsDir),
          status: attempts.length > 0 ? aggregate.status : existing.status,
          failureKind: attempts.length > 0 ? aggregate.failureKind : existing.failureKind,
          completedAt: attempts.length > 0 ? aggregate.completedAt : existing.completedAt,
          updatedAt: now,
          activeAttemptId,
          latestAttemptId,
          attempts: sortAttempts(attempts),
        };
    return { record, value: record };
  });
}

export async function upsertRunAttempt(options: UpsertAttemptOptions): Promise<RunRecord> {
  const now = new Date().toISOString();
  return await withRunMutation(options, async (existing, paths) => {
    const startedAt = toIso(options.startedAt, new Date());
    const completedAt = options.completedAt === undefined ? (options.status === "pending" || options.status === "running" ? null : now) : options.completedAt === null ? null : toIso(options.completedAt);
    const attemptPatch: Partial<RunAttemptRecord> = {
      status: options.status,
      backend: options.backend,
      failureKind: options.failureKind ?? null,
      updatedAt: now,
      completedAt,
      heartbeatAt: options.heartbeatAt === undefined ? undefined : toIso(options.heartbeatAt),
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
      runsDir: toSafeRelativePath(paths.cwd, paths.runsDir),
      startedAt,
      updatedAt: now,
      completedAt: null,
      activeAttemptId: options.attemptId,
      latestAttemptId: options.attemptId,
      attempts: [],
    };
    const attempts = [...baseRecord.attempts];
    const index = attempts.findIndex((attempt) => attempt.attemptId === options.attemptId);
    if (index >= 0) {
      attempts[index] = {
        ...mergeDefined(attempts[index], attemptPatch),
        process: mergeProcessMetadata(attempts[index].process, options.process),
      };
    } else {
      attempts.push(mergeDefined({
        attemptId: options.attemptId,
        status: options.status,
        backend: options.backend,
        failureKind: options.failureKind ?? null,
        startedAt,
        updatedAt: now,
        completedAt,
      }, attemptPatch));
    }
    const latestAttemptId = options.activate === false ? baseRecord.latestAttemptId : options.attemptId;
    const activeAttemptId = options.status === "pending" || options.status === "running" ? options.attemptId : (baseRecord.activeAttemptId === options.attemptId ? null : baseRecord.activeAttemptId);
    const aggregate = aggregateStatus(attempts, latestAttemptId);
    const record: RunRecord = {
      ...baseRecord,
      backend: baseRecord.backend ?? options.backend,
      cwd: paths.cwd,
      runsDir: toSafeRelativePath(paths.cwd, paths.runsDir),
      status: aggregate.status,
      failureKind: aggregate.failureKind,
      updatedAt: now,
      completedAt: aggregate.completedAt,
      activeAttemptId,
      latestAttemptId,
      attempts: sortAttempts(attempts),
    };
    return { record, value: record };
  });
}

/** @deprecated Use upsertRunAttempt. */
export async function upsertRunTask(options: UpsertTaskOptions): Promise<RunRecord> {
  const { taskId, ...rest } = options;
  return await upsertRunAttempt({ ...rest, attemptId: taskId });
}

export async function updateAttemptProcess(ref: RunRef & { attemptId: string; process: ProcessMetadata }): Promise<RunRecord> {
  return await upsertRunAttempt({ ...ref, status: "running", process: ref.process, completedAt: null, heartbeatAt: new Date() });
}

/** @deprecated Use updateAttemptProcess. */
export async function updateTaskProcess(ref: RunRef & { taskId: string; process: ProcessMetadata }): Promise<RunRecord> {
  const { taskId, ...rest } = ref;
  return await updateAttemptProcess({ ...rest, attemptId: taskId });
}

export async function recordAttemptHeartbeat(ref: RunRef & { attemptId: string }): Promise<RunRecord> {
  return await upsertRunAttempt({ ...ref, status: "running", heartbeatAt: new Date(), completedAt: null, activate: false });
}

export async function finishAttemptFromResult(baseRef: RunRef, result: ResultEnvelope): Promise<RunRecord> {
  return await upsertRunAttempt({
    ...baseRef,
    attemptId: result.attemptId,
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
    activate: true,
  });
}

/** @deprecated Use finishAttemptFromResult. */
export async function finishTaskFromResult(baseRef: RunRef, result: ResultEnvelope): Promise<RunRecord> {
  return await finishAttemptFromResult(baseRef, result);
}

export async function commitAttemptResultIfActive(baseRef: RunRef, result: ResultEnvelope): Promise<{ committed: boolean; record: RunRecord | null }> {
  const paths = runPaths(baseRef);
  await mkdir(paths.runDir, { recursive: true });
  return await withFileLock(paths.lockPath, async () => {
    const existing = await readRecordPath(paths);
    if (existing === null) return { committed: false, record: null };
    if (existing.activeAttemptId !== result.attemptId && existing.latestAttemptId !== result.attemptId) {
      await appendJsonLine(paths.eventsPath, { schemaVersion: RUN_EVENT_SCHEMA_VERSION, timestamp: new Date().toISOString(), type: "attempt.stale_result_ignored", runId: result.runId, attemptId: result.attemptId, status: result.status, message: "stale attempt result ignored" });
      return { committed: false, record: existing };
    }
    const record = await finishAttemptFromResultUnlocked(existing, paths, result);
    await writeRecordPath(paths.runJsonPath, record);
    return { committed: true, record };
  });
}

async function finishAttemptFromResultUnlocked(existing: RunRecord, paths: RunPaths, result: ResultEnvelope): Promise<RunRecord> {
  const now = new Date().toISOString();
  const attempts = [...existing.attempts];
  const index = attempts.findIndex((attempt) => attempt.attemptId === result.attemptId);
  const attempt: RunAttemptRecord = {
    ...(index >= 0 ? attempts[index] : { attemptId: result.attemptId, startedAt: result.startedAt, updatedAt: now, completedAt: null, status: result.status, failureKind: result.failureKind }),
    status: result.status,
    backend: result.backend,
    failureKind: result.failureKind,
    startedAt: result.startedAt,
    updatedAt: now,
    completedAt: result.completedAt,
    artifactCwd: result.cwd,
    resultPath: artifactPath(result, "result"),
    stdoutPath: artifactPath(result, "stdout"),
    stderrPath: artifactPath(result, "stderr"),
    outputPath: artifactPath(result, "output"),
    workspace: result.workspace,
    tmux: result.tmux,
  };
  if (index >= 0) attempts[index] = attempt;
  else attempts.push(attempt);
  return {
    ...existing,
    cwd: paths.cwd,
    runsDir: toSafeRelativePath(paths.cwd, paths.runsDir),
    backend: existing.backend ?? result.backend,
    status: result.status,
    failureKind: result.failureKind,
    updatedAt: now,
    completedAt: result.completedAt,
    activeAttemptId: null,
    latestAttemptId: result.attemptId,
    attempts: sortAttempts(attempts),
  };
}

export async function setRunDependency(ref: RunRef, dependency: AsyncDependency): Promise<RunRecord> {
  const now = new Date().toISOString();
  return await withRunMutation(ref, async (existing, paths) => {
    if (existing === null) throw new Error(`No run found with id: ${ref.runId}`);
    const record = { ...existing, dependency, updatedAt: now, cwd: paths.cwd, runsDir: toSafeRelativePath(paths.cwd, paths.runsDir) };
    return { record, value: record };
  });
}

export async function recordInterruptRequest(ref: RunRef, signal: NodeJS.Signals, reason: string | null): Promise<RunRecord> {
  const now = new Date().toISOString();
  return await withRunMutation(ref, async (existing, paths) => {
    if (existing === null) throw new Error(`No run found with id: ${ref.runId}`);
    const record = { ...existing, updatedAt: now, cwd: paths.cwd, runsDir: toSafeRelativePath(paths.cwd, paths.runsDir), interrupt: { requestedAt: now, signal, reason } };
    return { record, value: record };
  });
}

async function appendJsonLine(path: string, event: RunEvent): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(event)}\n`);
}

export async function appendRunEvent(ref: RunRef, event: Omit<RunEvent, "schemaVersion" | "timestamp" | "runId"> & { timestamp?: string | Date }): Promise<RunEvent> {
  const paths = runPaths(ref);
  await mkdir(paths.runDir, { recursive: true });
  const timestamp = event.timestamp === undefined ? new Date().toISOString() : event.timestamp instanceof Date ? event.timestamp.toISOString() : event.timestamp;
  const full: RunEvent = {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    timestamp,
    type: event.type,
    runId: ref.runId,
    ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }),
    ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
    ...(event.status === undefined ? {} : { status: event.status }),
    ...(event.message === undefined ? {} : { message: event.message }),
    ...(event.data === undefined ? {} : { data: event.data }),
  };
  await appendJsonLine(paths.eventsPath, full);
  return full;
}

export async function readRunEvents(ref: RunRef, limit = 50): Promise<RunEvent[]> {
  const paths = runPaths(ref);
  try {
    const text = await readFile(paths.eventsPath, "utf8");
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit)
      .map((line) => JSON.parse(line) as RunEvent);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}
