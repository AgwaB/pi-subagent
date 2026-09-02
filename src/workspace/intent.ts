import type { ResolveInput, WorkspaceMode, WorktreePolicy } from "../core/constants.ts";

function workspaceMode(input: ResolveInput): WorkspaceMode {
  const workspace = input.workspace;
  if (typeof workspace === "string") return workspace;
  return workspace?.mode ?? "shared";
}

function hasExplicitWorkspaceAuto(input: ResolveInput): boolean {
  return input.workspace === "auto" || (typeof input.workspace === "object" && input.workspace !== null && input.workspace.mode === "auto");
}

function worktreePolicy(input: ResolveInput): WorktreePolicy {
  return input.worktreePolicy ?? "auto";
}

/**
 * Whether the input asks for an isolated managed worktree. Pure: no
 * filesystem access, safe to consult from backend resolution.
 */
export function resolveWorktreeIntent(input: ResolveInput): "shared" | "worktree" {
  const policy = worktreePolicy(input);
  const workspace = workspaceMode(input);

  // Explicit isolation requests are honored or fail loudly in a non-git cwd;
  // they are never silently downgraded to shared.
  if (policy === "required") return "worktree";
  if (input.worktree === true || typeof input.worktree === "string") return "worktree";
  if (workspace === "worktree") return "worktree";
  if (policy === "never") return "shared";
  if (hasExplicitWorkspaceAuto(input) && input.sandbox !== undefined && input.sandbox !== null) return "worktree";
  return "shared";
}
