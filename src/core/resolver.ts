import { resolve } from "node:path";
import type { ResolveOutput, ResolvedBackend } from "./constants.ts";
import { validateResolveInput } from "./validation.ts";
import { resolveWorktreeIntent } from "../workspace/intent.ts";

function completed(backend: ResolvedBackend): ResolveOutput {
  return { backend, status: "completed" };
}

function failed(error: string, backend: ResolvedBackend): ResolveOutput {
  return { backend, status: "failed", failureKind: "validation", error };
}

/**
 * Inline execution runs the child session inside the parent process and
 * inherits the parent's ambient extensions. An extension that re-registers a
 * built-in tool binds it to the parent's process cwd, so inline cannot
 * guarantee that tools operate in an isolated worktree or in any cwd other
 * than the process cwd. Worktree isolation therefore requires an
 * out-of-process backend.
 */
function requiresOutOfProcessBackend(input: { cwd?: string } & Parameters<typeof resolveWorktreeIntent>[0]): "worktree" | "cwd" | undefined {
  if (resolveWorktreeIntent(input) === "worktree") return "worktree";
  if (typeof input.cwd === "string" && resolve(input.cwd) !== resolve(process.cwd())) return "cwd";
  return undefined;
}

export function resolveBackend(raw: unknown = {}): ResolveOutput {
  const validated = validateResolveInput(raw);
  if (!validated.ok) return validated.failure;

  const input = validated.input;
  const requested = input.backend ?? "auto";
  const isolation = requiresOutOfProcessBackend(input);

  if (requested === "inline" && isolation === "worktree") {
    return failed(
      "inline execution cannot isolate a worktree: it shares the parent process and its extensions, so tools would run in the parent cwd. Use backend headless or tmux, or drop the worktree request.",
      "inline",
    );
  }
  if (requested !== "auto") return completed(requested);

  if (input.visible) return completed("tmux");
  if (input.sandbox) return completed("headless");
  if (isolation !== undefined) return completed("headless");
  return completed("inline");
}
