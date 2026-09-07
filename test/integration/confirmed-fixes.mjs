#!/usr/bin/env node
// Opt-in live verification: never substitute a fixture provider or report skip
// as success. The disposable repo and evidence are retained for inspection.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { getEventListeners } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { getSubagentStatus, runSubagent } from "../../api.mjs";

const model = process.env.PI_SUBAGENT_CHECK_MODEL;
const thinking = process.env.PI_SUBAGENT_CHECK_THINKING;
assert.ok(
  model?.includes("/"),
  "Set PI_SUBAGENT_CHECK_MODEL to an explicit provider/model",
);
assert.ok(thinking, "Set PI_SUBAGENT_CHECK_THINKING explicitly");
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "pi-subagent-confirmed-live-"));
const cwd = join(root, "repo");
await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
console.log(
  JSON.stringify({
    evidenceRoot: root,
    requestedModel: model,
    requestedThinking: thinking,
  }),
);
await exec("git", ["init"], { cwd });
await writeFile(join(cwd, "seed.txt"), "base\n");
await writeFile(
  join(cwd, ".pi", "agents", "live-fixture.md"),
  "---\nname: live-fixture\ntools: read, write, bash\n---\nOperate only in this disposable fixture cwd. Do not commit, access the network, or spawn other agents. Follow the supplied task exactly.\n",
);
await exec("git", ["add", "seed.txt", ".pi/agents/live-fixture.md"], { cwd });
await exec(
  "git",
  [
    "-c",
    "user.name=Pi Check",
    "-c",
    "user.email=pi-check@example.invalid",
    "commit",
    "-m",
    "fixture",
  ],
  { cwd },
);

const common = {
  cwd,
  agent: "live-fixture",
  agentScope: "project",
  model,
  thinking,
  extensions: [],
  skills: [],
  timeoutMs: 120_000,
};
function assertActualModel(result) {
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.failureKind, null);
  assert.equal(
    `${result.metadata.provider}/${result.metadata.model}`,
    model,
    "the requested model must actually answer",
  );
  const usage = result.metadata.usage;
  assert.ok(
    usage &&
      (usage.totalTokens > 0 || usage.input > 0 || usage.inputTokens > 0),
    "actual provider token usage is required",
  );
}
async function outputOf(result) {
  return readFile(
    join(cwd, result.artifacts.find((ref) => ref.type === "output").path),
    "utf8",
  );
}

// The same inherited agent must be refused for true and execute for default
// false. The refusal is checked before the actual live call below.
await assert.rejects(
  runSubagent({
    ...common,
    backend: "inline",
    tools: [],
    confirmProjectAgents: true,
    tasks: [{ task: "Do not execute" }],
  }),
  /Project-local subagent definitions/u,
);
const controller = new AbortController();
const listenersBefore = getEventListeners(controller.signal, "abort").length;
const parallel = await runSubagent({
  ...common,
  backend: "inline",
  tools: [],
  signal: controller.signal,
  tasks: [{ task: "Reply exactly: inline-live-confirmed" }],
});
assert.equal(parallel.results.length, 1);
const inline = parallel.results[0];
assertActualModel(inline);
assert.match(await outputOf(inline), /inline-live-confirmed/u);
assert.equal(
  getEventListeners(controller.signal, "abort").length,
  listenersBefore,
);
console.log(
  JSON.stringify({
    scenario: "inline-inherited-agent",
    status: "passed",
    runId: inline.runId,
    metadata: inline.metadata,
  }),
);

// The live agent performs actual local tool calls. All three outputs are staged
// so an unstaged-only diff is necessarily insufficient; the text patch >1MiB
// also detects truncation. No external effects beyond the model request.
const fixtureScript =
  'const fs=require("node:fs");fs.writeFileSync("seed.txt","LIVE_STAGED_OK\\n");fs.writeFileSync("large.txt","LIVE-LINE\\n".repeat(120000)+"LIVE-PATCH-TAIL\\n");fs.writeFileSync("bytes.bin",Buffer.from([0,255,128,1]));';
const runsDir = ".live-evidence";
const headless = await runSubagent({
  ...common,
  backend: "headless",
  worktree: true,
  runsDir,
  tools: ["bash"],
  captureToolCalls: true,
  task: `Use bash to run this exact command in the current disposable cwd: node -e '${fixtureScript}' && git add seed.txt large.txt bytes.bin\nDo not commit or edit other files. Then reply exactly: worktree-live-confirmed`,
});
assertActualModel(headless);
assert.match(await outputOf(headless), /worktree-live-confirmed/u);
assert.equal(headless.workspace.worktreeCleanupStatus, "removed");
await assert.rejects(access(headless.workspace.worktreePath), {
  code: "ENOENT",
});
await assert.rejects(
  access(join(cwd, ".pi", "agent", "runs", headless.runId)),
  { code: "ENOENT" },
);
const resultRefs = headless.artifacts.filter((ref) => ref.type === "result");
assert.equal(resultRefs.length, 1);
for (const ref of headless.artifacts) {
  assert.ok(
    ref.path.startsWith(`${runsDir}/`),
    `${ref.type} must use the custom root`,
  );
  await access(join(cwd, ref.path));
}
assert.deepEqual(
  JSON.parse(await readFile(join(cwd, resultRefs[0].path), "utf8")),
  headless,
);
const snapshot = await getSubagentStatus({
  cwd,
  runsDir,
  runId: headless.runId,
});
assert.equal(snapshot.status, "completed");
assert.equal(snapshot.resultPath, resultRefs[0].path);
const patch = headless.artifacts.find((ref) => ref.type === "worktree-diff");
assert.ok(patch.bytes > 1024 * 1024);
assert.equal(patch.bytes, (await stat(join(cwd, patch.path))).size);
const verificationRepo = join(root, "verify-patch");
await exec("git", ["clone", "--no-hardlinks", cwd, verificationRepo]);
await exec("git", ["apply", "--check", join(cwd, patch.path)], {
  cwd: verificationRepo,
});
await exec("git", ["apply", join(cwd, patch.path)], { cwd: verificationRepo });
assert.equal(
  await readFile(join(verificationRepo, "seed.txt"), "utf8"),
  "LIVE_STAGED_OK\n",
);
assert.equal(
  await readFile(join(verificationRepo, "large.txt"), "utf8"),
  "LIVE-LINE\n".repeat(120000) + "LIVE-PATCH-TAIL\n",
);
assert.deepEqual(
  await readFile(join(verificationRepo, "bytes.bin")),
  Buffer.from([0, 255, 128, 1]),
);
const summary = {
  scenario: "headless-staged-large-binary-custom-root",
  status: "passed",
  runId: headless.runId,
  patchBytes: patch.bytes,
  metadata: headless.metadata,
  evidenceRoot: root,
};
await writeFile(
  join(root, "summary.json"),
  JSON.stringify({ model, thinking, inline, headless }, null, 2),
);
console.log(JSON.stringify(summary));
