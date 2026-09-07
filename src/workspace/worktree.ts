import { execFile, spawn } from "node:child_process";
import { appendFile, mkdir, open, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  createAttemptArtifactStore,
  type ArtifactRef,
  type ResultEnvelope,
} from "../artifacts/index.ts";
import type { ResolveInput, WorkspaceMode } from "../core/constants.ts";
import { resolveWorktreeIntent } from "./intent.ts";

const execFileAsync = promisify(execFile);

export interface WorkspaceResolutionInput {
  cwd: string;
  input: ResolveInput;
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

function explicitWorkspacePath(input: ResolveInput): string | undefined {
  const workspace = input.workspace;
  if (typeof workspace === "object" && workspace !== null)
    return workspace.path;
  if (typeof input.worktree === "string") return input.worktree;
  return undefined;
}

async function gitOutput(
  cwd: string,
  args: readonly string[],
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
  });
  return stdout.trim();
}

async function gitRoot(cwd: string): Promise<string> {
  try {
    const inside = await gitOutput(cwd, ["rev-parse", "--is-inside-work-tree"]);
    if (inside !== "true") throw new Error("not inside a git worktree");
    return await gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WorkspacePolicyError(
      `worktree isolation was requested but requires a git checkout cwd; use workspace:"shared" (or omit worktree options) to run without isolation. ${message}`,
    );
  }
}

function defaultWorktreePath(
  root: string,
  runId: string | undefined,
  taskIndex: number | undefined,
): string {
  const safeRunId = (runId ?? `run-${Date.now().toString(36)}`).replace(
    /[^A-Za-z0-9._-]/g,
    "-",
  );
  const safeSlot = `slot-${(taskIndex ?? 0) + 1}`;
  return join(
    dirname(root),
    ".pi-subagent-worktrees",
    `${root.split(/[\\/]/).pop() ?? "repo"}-${safeRunId}-${safeSlot}`,
  );
}

export async function resolveWorkspace(
  options: WorkspaceResolutionInput,
): Promise<ResolvedWorkspace> {
  const baseCwd = resolve(options.cwd);
  const intent = resolveWorktreeIntent(options.input);

  if (intent === "shared") {
    return { mode: "shared", baseCwd, cwd: baseCwd, worktreePath: null };
  }

  const root = await gitRoot(baseCwd);
  const requestedPath = explicitWorkspacePath(options.input);
  const worktreePath = resolve(
    requestedPath && !isAbsolute(requestedPath)
      ? join(baseCwd, requestedPath)
      : (requestedPath ??
          defaultWorktreePath(root, options.runId, options.taskIndex)),
  );
  await mkdir(dirname(worktreePath), { recursive: true });
  await execFileAsync("git", [
    "-C",
    root,
    "worktree",
    "add",
    "--detach",
    worktreePath,
    "HEAD",
  ]);
  return { mode: "worktree", baseCwd, cwd: worktreePath, worktreePath };
}

/** Write Git output directly to disk, without an in-memory patch size limit. */
async function appendGitFile(
  cwd: string,
  args: readonly string[],
  destination: string,
): Promise<void> {
  const output = await open(destination, "a");
  try {
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn("git", args, {
        cwd,
        stdio: ["ignore", output.fd, "pipe"],
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-64 * 1024);
      });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code === 0) resolvePromise();
        else
          reject(
            new Error(
              `git ${args.join(" ")} failed (${signal ?? code}): ${stderr.trim()}`,
            ),
          );
      });
    });
  } finally {
    await output.close();
  }
}

/**
 * Pi runtime state that a child session writes inside the worktree is not task
 * output: nested subagent runs and the workflow index would otherwise show up
 * as "new files" in every diff artifact.
 */
const WORKTREE_DIFF_EXCLUDES = [
  ":(glob,exclude)**/.pi/agent/runs/**",
  ":(glob,exclude)**/.pi/workflows/index.json",
  ":(glob,exclude)**/.pi/workflows/index.lock",
];

async function captureWorktreeArtifacts(
  result: ResultEnvelope,
  worktreePath: string,
  runsDir?: string,
): Promise<ArtifactRef[]> {
  const store = await createAttemptArtifactStore({
    cwd: result.cwd,
    runId: result.runId,
    attemptId: result.attemptId,
    runsDir,
  });
  const pathspec = [".", ...WORKTREE_DIFF_EXCLUDES];
  // Intent-to-add makes untracked files visible to diff HEAD, while HEAD makes
  // both staged and unstaged tracked changes part of the same complete patch.
  await gitOutput(worktreePath, ["add", "-N", "--", ...pathspec]);
  const statusPath = store.pathFor("worktree-status");
  await writeFile(statusPath, "");
  await appendGitFile(
    worktreePath,
    ["status", "--short", "--", ...pathspec],
    statusPath,
  );
  if ((await stat(statusPath)).size === 0)
    await writeFile(statusPath, "(clean)\n");
  const diffArgs = ["diff", "--no-ext-diff", "--no-textconv"];
  const diffPath = store.pathFor("worktree-diff");
  await writeFile(diffPath, "");
  await appendGitFile(
    worktreePath,
    [...diffArgs, "--stat", "HEAD", "--", ...pathspec],
    diffPath,
  );
  if ((await stat(diffPath)).size > 0) await appendFile(diffPath, "\n");
  await appendGitFile(
    worktreePath,
    [...diffArgs, "--binary", "HEAD", "--", ...pathspec],
    diffPath,
  );
  return [
    store.refFor("worktree-status", (await stat(statusPath)).size),
    store.refFor("worktree-diff", (await stat(diffPath)).size),
  ];
}

export async function discardPreparedWorkspace(
  workspace: ResolvedWorkspace,
): Promise<void> {
  if (workspace.mode !== "worktree" || workspace.worktreePath === null) return;
  const root = await gitRoot(workspace.baseCwd);
  await execFileAsync("git", [
    "-C",
    root,
    "worktree",
    "remove",
    "--force",
    workspace.worktreePath,
  ]);
}

export async function retainOwnedWorkspace(
  workspace: ResolvedWorkspace,
): Promise<void> {
  if (workspace.mode !== "worktree" || workspace.worktreePath === null) return;
  await gitOutput(workspace.baseCwd, ["worktree", "list", "--porcelain"]);
}

export async function finalizeWorktreeResult(
  workspace: ResolvedWorkspace,
  result: ResultEnvelope,
  runsDir?: string,
): Promise<ResultEnvelope> {
  if (workspace.mode !== "worktree" || workspace.worktreePath === null)
    return result;

  const store = await createAttemptArtifactStore({
    cwd: result.cwd,
    runId: result.runId,
    attemptId: result.attemptId,
    runsDir,
  });
  const artifacts = [...result.artifacts];
  let cleanupStatus: "removed" | "kept" | "failed" =
    result.status === "completed" ? "removed" : "kept";
  let cleanupError: string | undefined;

  try {
    artifacts.push(
      ...(await captureWorktreeArtifacts(
        result,
        workspace.worktreePath,
        runsDir,
      )),
    );
  } catch (error) {
    cleanupStatus = "failed";
    cleanupError = `failed to capture worktree artifacts: ${error instanceof Error ? error.message : String(error)}`;
  }

  if (result.status === "completed" && cleanupError === undefined) {
    try {
      const root = await gitRoot(workspace.baseCwd);
      await execFileAsync("git", [
        "-C",
        root,
        "worktree",
        "remove",
        "--force",
        workspace.worktreePath,
      ]);
    } catch (error) {
      cleanupStatus = "failed";
      cleanupError = `failed to remove worktree: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const statusRef = artifacts.find(
    (artifact) => artifact.type === "worktree-status",
  );
  const diffRef = artifacts.find(
    (artifact) => artifact.type === "worktree-diff",
  );

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
      ...(statusRef === undefined
        ? {}
        : { worktreeStatusPath: statusRef.path }),
      ...(diffRef === undefined ? {} : { worktreeDiffPath: diffRef.path }),
      ...(cleanupError === undefined
        ? {}
        : { worktreeCleanupError: cleanupError }),
    },
    sandbox: result.sandbox,
    exitCode: result.exitCode,
    signal: result.signal,
    artifacts,
    tmux: result.tmux,
    completion: result.completion,
    correlationId: result.correlationId,
    metadata: result.metadata,
  });
}
