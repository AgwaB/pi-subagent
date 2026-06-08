import type { ResolveOutput, ResolvedBackend } from "./constants.ts";
import { validateResolveInput } from "./validation.ts";

function completed(backend: ResolvedBackend): ResolveOutput {
  return { backend, status: "completed" };
}

export function resolveBackend(raw: unknown = {}): ResolveOutput {
  const validated = validateResolveInput(raw);
  if (!validated.ok) return validated.failure;

  const input = validated.input;
  const requested = input.backend ?? "auto";

  if (requested !== "auto") return completed(requested);

  if (input.visible) return completed("tmux");
  if (input.sandbox) return completed("headless");
  return completed("inline");
}
