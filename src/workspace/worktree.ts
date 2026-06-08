import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { createTaskArtifactStore, type ArtifactRef, type ResultEnvelope } from "../artifacts/index.ts";
import type { ResolveInput, WorkspaceMode, WorktreePolicy } from "../core/constants.ts";

const execFileAsync = promisify(execFile);

export interface WorkspaceResolutionInput {
  cwd: string;
  input: ResolveInput;
  mode: "single" | "parallel";
  taskIndex?: number;
  runId?: string;
}

export interface ResolvedWorkspace {
  mode: Exclude<WorkspaceMode, "auto">;
  baseCwd: string;
  cwd: string;
  worktreePath: string | null;
}

export class WorkspacePolicyError extends Error {
  readonly failureKind = "validation" as const;
}

function workspaceMode(input: ResolveInput): WorkspaceMode {
  const workspace = input.workspace;
  if (typeof workspace === "string") return workspace;
  return workspace?.mode ?? "shared";
}

function hasExplicitWorkspaceAuto(input: ResolveInput): boolean {
  return input.workspace === "auto" || (typeof input.workspace === "object" && input.workspace !== null && input.workspace.mode === "auto");
}

function hasExplicitWorkspaceShared(input: ResolveInput): boolean {
  return input.workspace === "shared" || (typeof input.workspace === "object" && input.workspace !== null && input.workspace.mode === "shared");
}

function explicitWorkspacePath(input: ResolveInput): string | undefined {
  const workspace = input.workspace;
  if (typeof workspace === "object" && workspace !== null) return workspace.path;
  if (typeof input.worktree === "string") return input.worktree;
  return undefined;
}

function worktreePolicy(input: ResolveInput): WorktreePolicy {
  return input.worktreePolicy ?? "auto";
}

function resolveWorktreeIntent(input: ResolveInput, mode: "single" | "parallel"): "shared" | "worktree" {
  const policy = worktreePolicy(input);
  const workspace = workspaceMode(input);

  if (policy === "required") return "worktree";
  if (input.worktree === true || typeof input.worktree === "string") return "worktree";
  if (workspace === "worktree") return "worktree";

  if (mode === "parallel" && (policy === "never" || hasExplicitWorkspaceShared(input))) {
    throw new WorkspacePolicyError("parallel subagent execution cannot mutate a shared checkout; use workspace:auto/worktree or worktreePolicy:required to isolate tasks.");
  }

  if (policy === "never" || workspace === "shared") {
    return mode === "parallel" ? "worktree" : "shared";
  }

  if (mode === "parallel") return "worktree";
  if (hasExplicitWorkspaceAuto(input) && input.sandbox !== undefined && input.sandbox !== null) return "worktree";
  return "shared";
}

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

async function gitRoot(cwd: string): Promise<string> {
  try {
    const inside = await gitOutput(cwd, ["rev-parse", "--is-inside-work-tree"]);
    if (inside !== "true") throw new Error("not inside a git worktree");
    return await gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WorkspacePolicyError(`worktree workspace requires a git checkout cwd; ${message}`);
  }
}

function defaultWorktreePath(root: string, runId: string | undefined, taskIndex: number | undefined): string {
  const safeRunId = (runId ?? `run-${Date.now().toString(36)}`).replace(/[^A-Za-z0-9._-]/g, "-");
  const safeTask = `task-${(taskIndex ?? 0) + 1}`;
  return join(dirname(root), ".pi-subagent-worktrees", `${root.split(/[\\/]/).pop() ?? "repo"}-${safeRunId}-${safeTask}`);
}

export async function resolveWorkspace(options: WorkspaceResolutionInput): Promise<ResolvedWorkspace> {
  const baseCwd = resolve(options.cwd);
  const intent = resolveWorktreeIntent(options.input, options.mode);

  if (intent === "shared") {
    return { mode: "shared", baseCwd, cwd: baseCwd, worktreePath: null };
  }

  const root = await gitRoot(baseCwd);
  const requestedPath = explicitWorkspacePath(options.input);
  const worktreePath = resolve(requestedPath && !isAbsolute(requestedPath) ? join(baseCwd, requestedPath) : (requestedPath ?? defaultWorktreePath(root, options.runId, options.taskIndex)));
  await mkdir(dirname(worktreePath), { recursive: true });
  await execFileAsync("git", ["-C", root, "worktree", "add", "--detach", worktreePath, "HEAD"]);
  return { mode: "worktree", baseCwd, cwd: worktreePath, worktreePath };
}

async function gitOutputAllowFailure(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
    return `${stdout}${stderr}`;
  } catch (error) {
    const anyError = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
    const stdout = typeof anyError.stdout === "string" ? anyError.stdout : "";
    const stderr = typeof anyError.stderr === "string" ? anyError.stderr : "";
    const message = typeof anyError.message === "string" ? anyError.message : String(error);
    return `${stdout}${stderr}${stdout || stderr ? "" : message}`;
  }
}

async function captureWorktreeArtifacts(result: ResultEnvelope, worktreePath: string): Promise<ArtifactRef[]> {
  const store = await createTaskArtifactStore({ cwd: result.cwd, runId: result.runId, taskId: result.taskId });
  await gitOutputAllowFailure(worktreePath, ["add", "-N", "--", "."]);
  const status = await gitOutputAllowFailure(worktreePath, ["status", "--short"]);
  const diffStat = await gitOutputAllowFailure(worktreePath, ["diff", "--stat", "--", "."]);
  const diff = await gitOutputAllowFailure(worktreePath, ["diff", "--binary", "--", "."]);
  return [
    await store.writeTextArtifact("worktree-status", status.length > 0 ? status : "(clean)\n"),
    await store.writeTextArtifact("worktree-diff", `${diffStat.trimEnd()}${diffStat.trim() && diff.trim() ? "\n\n" : ""}${diff}`),
  ];
}

export async function finalizeWorktreeResult(workspace: ResolvedWorkspace, result: ResultEnvelope): Promise<ResultEnvelope> {
  if (workspace.mode !== "worktree" || workspace.worktreePath === null) return result;

  const store = await createTaskArtifactStore({ cwd: result.cwd, runId: result.runId, taskId: result.taskId });
  const artifacts = [...result.artifacts];
  let cleanupStatus: "removed" | "kept" | "failed" = result.status === "completed" ? "removed" : "kept";
  let cleanupError: string | undefined;

  try {
    artifacts.push(...await captureWorktreeArtifacts(result, workspace.worktreePath));
  } catch (error) {
    cleanupStatus = "failed";
    cleanupError = `failed to capture worktree artifacts: ${error instanceof Error ? error.message : String(error)}`;
  }

  if (result.status === "completed" && cleanupError === undefined) {
    try {
      const root = await gitRoot(workspace.baseCwd);
      await execFileAsync("git", ["-C", root, "worktree", "remove", "--force", workspace.worktreePath]);
    } catch (error) {
      cleanupStatus = "failed";
      cleanupError = `failed to remove worktree: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const statusRef = artifacts.find((artifact) => artifact.type === "worktree-status");
  const diffRef = artifacts.find((artifact) => artifact.type === "worktree-diff");

  return await store.writeResult({
    backend: result.backend,
    status: result.status,
    failureKind: result.failureKind,
    cwd: result.cwd,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    durationMs: result.durationMs,
    workspace: {
      ...result.workspace,
      worktreeCleanupStatus: cleanupStatus,
      ...(statusRef === undefined ? {} : { worktreeStatusPath: statusRef.path }),
      ...(diffRef === undefined ? {} : { worktreeDiffPath: diffRef.path }),
      ...(cleanupError === undefined ? {} : { worktreeCleanupError: cleanupError }),
    },
    sandbox: result.sandbox,
    exitCode: result.exitCode,
    signal: result.signal,
    artifacts,
    tmux: result.tmux,
    completion: result.completion,
  });
}
