#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkspace, WorkspacePolicyError } from "../../src/workspace/worktree.ts";

const tempRoot = await mkdtemp(join(tmpdir(), "pi-subagent-workspace-policy-"));
try {
  // Plain directory, no git checkout.
  const plainDir = join(tempRoot, "plain");
  await mkdir(plainDir, { recursive: true });

  // Default resolves to shared, with or without git (parallel fanout is usually read-only).
  const sharedDefault = await resolveWorkspace({ cwd: plainDir, input: {}, runId: "run_ws_default", taskIndex: 0 });
  assert.equal(sharedDefault.mode, "shared");
  assert.equal(sharedDefault.cwd, plainDir);
  assert.equal(sharedDefault.worktreePath, null);

  // Explicit shared is honored.
  const sharedExplicit = await resolveWorkspace({ cwd: plainDir, input: { workspace: "shared" }, runId: "run_ws_shared", taskIndex: 0 });
  assert.equal(sharedExplicit.mode, "shared");

  // worktreePolicy "never" resolves to shared.
  const sharedNever = await resolveWorkspace({ cwd: plainDir, input: { worktreePolicy: "never" }, runId: "run_ws_never", taskIndex: 0 });
  assert.equal(sharedNever.mode, "shared");

  // Explicit isolation requests in a non-git cwd fail loudly; never silently downgrade.
  for (const input of [{ worktree: true }, { workspace: "worktree" }, { worktreePolicy: "required" }]) {
    await assert.rejects(
      resolveWorkspace({ cwd: plainDir, input, runId: "run_ws_isolated", taskIndex: 0 }),
      (error) => error instanceof WorkspacePolicyError && /requires a git checkout/.test(error.message),
      `explicit isolation ${JSON.stringify(input)} must fail in a non-git cwd`,
    );
  }

  // workspace:auto + sandbox implies isolation, so it must also fail loudly without git.
  await assert.rejects(
    resolveWorkspace({ cwd: plainDir, input: { workspace: "auto", sandbox: true }, runId: "run_ws_auto_sandbox", taskIndex: 0 }),
    (error) => error instanceof WorkspacePolicyError,
  );

  console.log(JSON.stringify({ name: "check-workspace-policy", status: "completed" }, null, 2));
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
