import type { FailureKind, ResolvedBackend, Status } from "../core/constants.ts";

export const RESULT_SCHEMA_VERSION = 1 as const;
export const ARTIFACT_TYPES = ["result", "stdout", "stderr", "output", "worktree-status", "worktree-diff"] as const;
export const WORKSPACE_MODES = ["shared", "worktree", "auto"] as const;

export type ArtifactType = (typeof ARTIFACT_TYPES)[number];
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

export interface ArtifactRef {
  type: ArtifactType;
  path: string;
  bytes?: number;
}

export type WorktreeCleanupStatus = "not-needed" | "removed" | "kept" | "failed";

export interface ResultWorkspace {
  mode: WorkspaceMode;
  cwd: string;
  worktreePath: string | null;
  worktreeCleanupStatus?: WorktreeCleanupStatus;
  worktreeStatusPath?: string;
  worktreeDiffPath?: string;
  worktreeCleanupError?: string;
}

export interface ResultSandbox {
  enabled: boolean;
}

export interface ResultTmuxMetadata {
  sessionName: string;
  sessionId: string | null;
  paneId: string | null;
}

export interface CompletionMetadata {
  onComplete: string | null;
  notified: boolean;
  updatesSent: number;
}

export interface ResultEnvelopeInput {
  runId: string;
  taskId: string;
  backend: ResolvedBackend;
  status: Status;
  failureKind?: FailureKind | null;
  cwd: string;
  startedAt?: string | Date;
  completedAt?: string | Date | null;
  durationMs?: number | null;
  workspace?: Partial<ResultWorkspace> | null;
  sandbox?: Partial<ResultSandbox> | null;
  exitCode?: number | null;
  signal?: string | null;
  artifacts?: ArtifactRef[];
  tmux?: ResultTmuxMetadata;
  completion?: CompletionMetadata;
}

export interface ResultEnvelope {
  schemaVersion: typeof RESULT_SCHEMA_VERSION;
  runId: string;
  taskId: string;
  backend: ResolvedBackend;
  status: Status;
  failureKind: FailureKind | null;
  cwd: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  workspace: ResultWorkspace;
  sandbox: ResultSandbox;
  exitCode: number | null;
  signal: string | null;
  artifacts: ArtifactRef[];
  tmux?: ResultTmuxMetadata;
  completion?: CompletionMetadata;
}

function toIsoTimestamp(value: string | Date, fieldName: string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} must be a valid ISO timestamp or Date.`);
  }
  return date.toISOString();
}

function normalizeDuration(value: number | null | undefined): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("durationMs must be a non-negative finite number when provided.");
  }
  return value;
}

function normalizeWorkspace(input: ResultEnvelopeInput): ResultWorkspace {
  const workspace = input.workspace ?? {};
  return {
    mode: workspace.mode ?? "shared",
    cwd: workspace.cwd ?? input.cwd,
    worktreePath: workspace.worktreePath ?? null,
    ...(workspace.worktreeCleanupStatus === undefined ? {} : { worktreeCleanupStatus: workspace.worktreeCleanupStatus }),
    ...(workspace.worktreeStatusPath === undefined ? {} : { worktreeStatusPath: workspace.worktreeStatusPath }),
    ...(workspace.worktreeDiffPath === undefined ? {} : { worktreeDiffPath: workspace.worktreeDiffPath }),
    ...(workspace.worktreeCleanupError === undefined ? {} : { worktreeCleanupError: workspace.worktreeCleanupError }),
  };
}

function normalizeSandbox(input: ResultEnvelopeInput): ResultSandbox {
  if (input.sandbox === undefined || input.sandbox === null) {
    return { enabled: false };
  }

  return {
    enabled: input.sandbox.enabled ?? true,
  };
}

function dedupeArtifactRefs(refs: ArtifactRef[]): ArtifactRef[] {
  const seen = new Set<string>();
  const deduped: ArtifactRef[] = [];

  for (const ref of refs) {
    const key = `${ref.type}:${ref.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(ref);
  }

  return deduped;
}

export function mergeArtifactRefs(...groups: readonly ArtifactRef[][]): ArtifactRef[] {
  return dedupeArtifactRefs(groups.flat());
}

export function createResultEnvelope(input: ResultEnvelopeInput): ResultEnvelope {
  const startedAt = toIsoTimestamp(input.startedAt ?? new Date(), "startedAt");
  const completedAt =
    input.completedAt === undefined
      ? input.status === "pending" || input.status === "running"
        ? null
        : new Date().toISOString()
      : input.completedAt === null
        ? null
        : toIsoTimestamp(input.completedAt, "completedAt");

  const explicitDurationMs = normalizeDuration(input.durationMs);
  const durationMs =
    explicitDurationMs !== undefined
      ? explicitDurationMs
      : completedAt === null
        ? null
        : Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));

  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    runId: input.runId,
    taskId: input.taskId,
    backend: input.backend,
    status: input.status,
    failureKind: input.failureKind ?? null,
    cwd: input.cwd,
    startedAt,
    completedAt,
    durationMs,
    workspace: normalizeWorkspace(input),
    sandbox: normalizeSandbox(input),
    exitCode: input.exitCode ?? null,
    signal: input.signal ?? null,
    artifacts: dedupeArtifactRefs(input.artifacts ?? []),
    ...(input.tmux === undefined ? {} : { tmux: input.tmux }),
    ...(input.completion === undefined ? {} : { completion: input.completion }),
  };
}
