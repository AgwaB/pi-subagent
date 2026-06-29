# pi-subagent Usage

Detailed usage reference for the public Pi tool **`subagent`**.

## Install

```bash
pi install npm:@agwab/pi-subagent
```

Reload Pi after installation.

Requires Node.js `>=22.19.0`.

## Tool surface

Tool name:

```text
subagent
```

TUI command:

```text
/subagent panel
```

## Actions

Every call has an `action`. The default is `run`, so omitting `action` starts a new subagent.

| `action` | Purpose | Key parameters |
|---|---|---|
| `run` (default) | Start a new subagent run, or launch independent runs in parallel. | `agent`/`task` or `tasks`; plus `sandbox`, `worktree`, `model`, `async`, etc. |
| `status` | Read a run's current state. | `runId`, optional `cwd`, `attemptId` |
| `logs` | Read a run's captured logs. | `runId`, optional `cwd`, `attemptId` |
| `wait` | Block until a run finishes. | `runId`, optional `cwd`, `timeoutMs`, `pollIntervalMs` |
| `interrupt` | Signal a process-backed run. | `runId`, optional `cwd`, `attemptId`, `signal`, `escalateAfterMs`, `killAfterMs`, `reason` |
| `mark-background` | Mark a run as not needed before the final answer. | `runId`, optional `cwd` |
| `reconcile` | Re-read durable artifacts and repair stale/orphaned state when possible. | `runId`, optional `cwd` |

State is file-based under `.pi/agent/runs/<run-id>/`. `status`/`logs`/`wait` read those files; `interrupt` sends a real OS signal; `mark-background` updates run metadata; `reconcile` repairs local metadata from durable attempt artifacts without relaunching work. Recent runs also write a global locator pointer, so existing-run actions can often resolve a `runId` even when `cwd` is omitted or the run was launched from another cwd.

Model:

```text
run = one subagent execution
attempt = one launch attempt
correlationId = optional external trace label
```

`taskId` remains accepted as a deprecated read alias for older artifacts.

## Calling the tool

The examples below show `subagent` argument objects. Pi usually builds these from natural-language requests; extensions or tests can pass the same object as `params` to the registered tool's `execute` function.

## Code API

Orchestrators can import the runtime directly from the `./api` subpath:

```ts
import {
  runSubagent,
  getSubagentStatus,
  getSubagentLogs,
  waitForSubagent,
  interruptSubagent,
  reconcileSubagentRun,
} from "@agwab/pi-subagent/api";

const run = await runSubagent({
  cwd: process.cwd(),
  agent: "reviewer",
  task: "Review the current diff.",
  async: true,
  onComplete: "detach",
});

const status = await getSubagentStatus({ cwd: process.cwd(), runId: run.runId });
const logs = await getSubagentLogs({ cwd: process.cwd(), runId: run.runId });
await waitForSubagent({ cwd: process.cwd(), runId: run.runId, timeoutMs: 300000 });
await interruptSubagent({ cwd: process.cwd(), runId: run.runId, reason: "caller cancelled" });
await reconcileSubagentRun({ cwd: process.cwd(), runId: run.runId });
```

`runSubagent` accepts the same run options as the tool, plus an optional `signal`. Existing-run helpers accept `runId`, optional `cwd`, optional `attemptId`, and optional `runsDir`; when `cwd` is omitted they use the global locator index first and fall back to the current cwd for legacy records. The API is intentionally object-only and does not expose the lower-level runner internals.

The code API is ESM-only. Import `@agwab/pi-subagent/api`; do not deep-import internal files such as `src/orchestrate/*` because only documented package subpaths are public.

Project-local agents are repository-controlled. Project-local agent confirmation is disabled by default; use trusted repositories or constrain lookup with `agentScope:"global"`. The code API has no interactive prompt, so setting `confirmProjectAgents:true` rejects project-local agents instead of prompting.

## Single run

```json
{
  "agent": "reviewer",
  "task": "Review the current diff and summarize the highest-risk issues."
}
```

## Parallel fan-out

```json
{
  "tasks": [
    { "agent": "reviewer-security", "task": "Security review." },
    { "agent": "reviewer-performance", "task": "Performance review." },
    { "agent": "reviewer-test-coverage", "task": "Test coverage review." }
  ]
}
```

Parallel launches are independent runs started concurrently. The response contains `runIds` and per-run results; there is no aggregate run, aggregate task, dependency scheduling, or fan-in status.

Parallel runs use isolated git worktrees by default so worker mutations do not collide in the base checkout. Explicit shared-checkout parallel mutation is rejected.

Use `concurrency` to cap parallel fan-out:

```json
{
  "concurrency": 2,
  "tasks": [
    { "agent": "reviewer-security", "task": "Security review." },
    { "agent": "reviewer-performance", "task": "Performance review." }
  ]
}
```

Chain/sequential execution is intentionally not supported by this engine. If step B needs output from step A, keep that sequencing in the parent agent or a workflow layer.

## Async and existing runs

Start a detached run by calling `subagent` with `async: true`, `onComplete: "detach"`, or `onComplete: "notify"`:

```json
{
  "agent": "reviewer",
  "task": "Audit the repository and write a concise risk report.",
  "async": true,
  "asyncDependency": "needed-before-final"
}
```

`asyncDependency` can be `needed-before-final`, `background`, or `unclassified`. `onComplete` can be `return`, `detach`, or `notify`. `notify` sends an internal Pi notification/update when the run completes; it does not call external webhooks.

Check status with another `subagent` tool call:

```json
{ "action": "status", "runId": "run_..." }
```

Read logs:

```json
{ "action": "logs", "runId": "run_..." }
```

Wait for completion:

```json
{ "action": "wait", "runId": "run_...", "timeoutMs": 300000 }
```

Mark a run as background metadata:

```json
{ "action": "mark-background", "runId": "run_..." }
```

Interrupt a process-backed run:

```json
{ "action": "interrupt", "runId": "run_..." }
```

`interrupt` is conservative. It can signal runs with registered process metadata. Unsupported or already-terminal runs return explicit status rather than pretending cancellation succeeded.

### Existing-run resolution

For `status`, `logs`, `wait`, `interrupt`, `mark-background`, and `reconcile`, the lookup order is:

1. Use the explicit `cwd`/`runsDir` when provided.
2. Otherwise, check the current cwd's `.pi/agent/runs` for legacy/local records.
3. Otherwise, resolve `runId` through the global locator index and read the pointed-to run directory.

The locator index is only a pointer for finding runs across cwd boundaries. `run.json`, `events.jsonl`, and attempt `result.json` files remain the source of truth.

## Common run options

| Option | Use |
|---|---|
| `cwd` | Run from a specific project directory. Existing-run actions accept `cwd` to force a registry location; if omitted, recent runs can be found by global locator and older runs fall back to the current cwd. |
| `timeoutMs` | Limit worker execution time for `run`; limit polling duration for `action: "wait"`. Omit it for no runtime kill deadline; `wait` alone defaults to 60s polling. |
| `visible` | Use a visible tmux-backed worker (`visible: true`). |
| `concurrency` | Cap parallel run fan-out. |
| `model` | Select a Pi model/provider for model-backed workers. |
| `thinking` / `thinkingLevel` / `reasoningLevel` | Set the reasoning level. |
| `tools` | Tool allowlist. With a named agent this may only narrow agent-declared tools; it cannot expand authority. For agentless runs it sets the full tool allowlist. |
| `roleContext` | Add one-off role instructions without creating an agent file. |
| `agentScope` | Restrict agent lookup to `auto`, `global`, or `project`. |
| `confirmProjectAgents` | Defaults to `false`. Set `true` to require project-agent confirmation in interactive tool calls; code API calls with `true` reject project-local agents because they cannot prompt. |
| `systemPrompt` | Full system prompt override. When provided, it wins over any agent file prompt; named-agent frontmatter such as `tools`, `model`, and `thinking` may still apply. |
| `skills` | Additional Pi skill paths to load in the child. Omit to use normal ambient discovery; pass `[]` to disable child skills. |
| `extensions` | Additional Pi extension paths to load in the child. Omit to use normal ambient discovery; pass `[]` to disable child extensions. |
| `runsDir` | Safe relative artifact root under `cwd`; default `.pi/agent/runs`. |
| `correlationId` | Optional external trace label, e.g. a workflow run id. It has no scheduling or aggregation semantics. |
| `captureToolCalls` | Optional redacted debug telemetry for child tool calls. Defaults to `false`; when `true`, supported live event backends write completed tool call summaries as artifacts without full args/results or update streams. |

## Sandbox

```json
{
  "sandbox": true,
  "agent": "checker",
  "task": "Run a local check and report the artifact paths."
}
```

Rules:

- `sandbox: true` enables sandboxing with **no network access** (deny-all). `false`, `null`, or omission disables sandboxing.
- `sandbox: { allowedDomains: [...] }` enables sandboxing with explicit network egress.
- Process-backed workers (`headless`, `tmux`) can be sandboxed.
- `inline + sandbox` fails validation because an in-process SDK worker cannot provide per-worker OS sandboxing.
- The public API intentionally does not expose sandbox engine selection yet.

### Sandbox network policy

The whole child Pi process runs inside the sandbox boundary, so the model API call itself needs network access. A sandboxed model-backed run must therefore allow its provider endpoint explicitly:

```json
{
  "sandbox": { "allowedDomains": ["api.anthropic.com"] },
  "agent": "implementer",
  "task": "Make the requested local change and run the checks."
}
```

Rules:

- Domains are bare hostnames (`api.anthropic.com`) or `*.example.com`-style wildcards. Protocols, paths, ports, and broad wildcards such as `*.com` are rejected.
- `deniedDomains` is not exposed; the policy is allow-only.
- `sandbox: true` keeps deny-all network. Use it for offline work: running local checks, formatting, builds against vendored dependencies.
- The effective `allowedDomains` are recorded in the result envelope (`result.sandbox.allowedDomains`) for audit.

Guidance:

- The caller decides per run, following least privilege: list the model provider endpoint the child will use, plus any extra domains the task itself needs (for example `github.com` or `*.npmjs.org` for installs).
- Do not sandbox open-ended research tasks; the domains they need cannot be enumerated in advance, and headless workers cannot prompt for approval. Use an unsandboxed worker with worktree isolation instead (filesystem safety without network limits).

## Workspaces and worktrees

There are three inputs for worktree isolation, in order of preference:

| Input | When to use |
|---|---|
| `worktree` | Primary switch. `true` to isolate; or a string path for an explicit worktree location. |
| `workspace` | Advanced. `"shared" \| "worktree" \| "auto"`, or `{ mode, path }` for an explicit path. |
| `worktreePolicy` | Advanced. `"auto" \| "required" \| "never"` to force or forbid isolation. |

Most calls only need `worktree`:

```json
{
  "worktree": true,
  "agent": "implementer",
  "task": "Make the requested local change in an isolated worktree."
}
```

Advanced forms:

```json
{ "workspace": "worktree" }
{ "workspace": { "mode": "worktree", "path": ".pi-subagent-worktrees/task-a" } }
{ "worktreePolicy": "required" }
```

The default workspace is `shared` for both single and parallel runs, so fanout works in any directory, including non-git workspaces. Parallel fanout is usually read-only (reviews, analysis); when parallel tasks mutate files, request worktree isolation explicitly so tasks do not write into the same checkout concurrently.

Explicit isolation requests (`worktree: true`, `workspace: "worktree"`, `worktreePolicy: "required"`) are never silently downgraded: in a non-git cwd they fail with a validation error instead of falling back to shared. Note that shared-workspace runs do not produce `worktree-status`/`worktree-diff` artifacts, so mutating tasks lose change-evidence capture without worktree isolation.

Worktree cleanup is managed:

```text
completed -> capture status/diff artifacts, then remove the worktree
failed/cancelled -> capture status/diff artifacts, keep the worktree for debugging
```

Worktree evidence is recorded in `result.json` under `workspace.worktreeCleanupStatus`, `workspace.worktreeStatusPath`, and `workspace.worktreeDiffPath`.

Kept worktrees (from failed or cancelled runs) live in `.pi-subagent-worktrees/` **next to** the repository root, not inside it, and are never pruned automatically. To clean up after debugging:

```bash
git worktree list                      # inspect registered worktrees
rm -rf ../.pi-subagent-worktrees/<dir> # remove the kept checkout
git worktree prune                     # clear stale registrations
```

## Backend selection

Backend is optional. When omitted, the engine uses auto-selection:

| Input condition | Resolved backend |
|---|---|
| `visible: true` | `tmux` |
| `sandbox: true` | `headless`, unless tmux/visible is explicit |
| normal `agent`/`task` | `inline` |

Supported explicit backend values are `auto`, `inline`, `headless`, and `tmux`. Most users should omit `backend`. Use `visible: true` only when you want a tmux-backed visible worker.

Child sessions load Pi's normal ambient extensions and skills by default, so package tools such as web access are available when enabled in Pi settings. Pass `extensions: []` or `skills: []` for a hermetic child. Recursive subagent spawning is blocked by excluding the `subagent` tool from child sessions.

## Agent definitions

When `agent` names a Pi agent markdown file, the engine injects that agent's body as system prompt context and inherits supported frontmatter such as `model`, `thinking`, and `tools`.

`tools` declared in the agent file are that agent's authority ceiling. Call-level `tools` may narrow the set, including `tools: []`, but cannot add tools the agent did not declare. If an agent file omits `tools`, call-level `tools` is rejected for that named agent; omit `tools` to use Pi's default surface.

For agentless model-backed runs, call-level `tools` can set the full tool allowlist. Use `tools: []` to run an agentless task with no tools.

`systemPrompt` is a full override for orchestrators that compile prompts themselves. When provided, it is passed as the final system prompt and no agent prompt is appended. If `agent` is also provided, the agent file is still loaded for approval and frontmatter policy (`tools`, `model`, `thinking`), but its body is not appended to the prompt.

Use `roleContext` for extra worker role instructions without creating a reusable agent file:

```json
{
  "roleContext": "Act as a strict release-readiness reviewer.",
  "task": "Review the current package metadata."
}
```

Agent lookup supports:

```text
~/.pi/agent/agents/*.md   # global agents
.pi/agents/*.md          # project-local agents
```

Use `agentScope` to constrain lookup:

```text
auto | global | project
```

Project-local agents are repository-controlled. The engine uses them without prompting by default; set `confirmProjectAgents:true` in interactive Pi sessions to require confirmation, or use `agentScope:"global"` to avoid project-local agents entirely.

## Model controls

Model-backed runs accept optional model controls:

```json
{
  "agent": "scout",
  "task": "Audit this repo.",
  "model": "kimi-coding/kimi-for-coding",
  "thinking": "xhigh"
}
```

Aliases:

```text
thinking | thinkingLevel | reasoningLevel
```

Supported thinking levels:

```text
off | minimal | low | medium | high | xhigh
```

These options may also be set per task in `tasks[]`.

Timeout notes:

- `timeoutMs` on a run is the worker execution deadline. If omitted, pi-subagent does not impose a run timeout.
- `action:"wait"` uses `timeoutMs` as a polling deadline and defaults to 60 seconds.
- `onComplete:"notify"` uses an internal completion monitor with a long safety window (up to 24h when no `timeoutMs` is set); it does not kill the worker. The monitor polls in the parent process and has no cancellation handle, so long-lived SDK embeddings should prefer `onComplete:"detach"` plus explicit `action:"status"`/`"wait"` polling. Orchestrators that need a 4h or other SLA should pass `timeoutMs` explicitly on the run.

## Artifacts

Runs write durable evidence under:

```text
.pi/agent/runs/<run-id>/
├── run.json
├── events.jsonl
└── attempts/
    └── <attempt-id>/
        ├── result.json
        ├── worker.json
        ├── stdout.log
        ├── stderr.log
        └── output.log
```

`run.json` records a `parentSessionId` field: the Pi session id of the session that launched the run, injected from the tool context (not a model-settable argument). Consumers (e.g. status panels) can use it to scope a shared per-`cwd` runs directory to the session that owns each run. The field is omitted when no session id is available, and older records simply lack it.

Recent runs also write a small locator file under Pi's global subagent-run index. A locator contains the `runId`, absolute `cwd`, optional `runsDir`, optional `parentSessionId`, optional `correlationId`, and `updatedAt`. It is not authoritative evidence and can become stale if the pointed-to run directory is moved or deleted; use `run.json`, `events.jsonl`, and attempt `result.json` as the source of truth.

Older `schemaVersion: 1` artifacts under `<run-id>/<task-id>/` are still readable for compatibility.

Tool responses return compact status and artifact references rather than raw logs.

## TUI monitor

```text
/subagent panel
```

The panel shows run/attempt details, workspace/artifact paths, dependency metadata, event tail, and log tail. It has three scopes:

- `session`: runs whose `run.json.parentSessionId` matches the current Pi session. This is the default when a session id is available.
- `cwd`: runs under the current workspace's `.pi/agent/runs`, including legacy records that lack `parentSessionId`.
- `all`: the global locator index plus current-cwd legacy records.

Status filters are `all`, `running`, `completed`, and `failed`. The panel keeps a fixed-height layout, uses an internally scrollable detail pane, and never renders raw `parentSessionId` values.

Stale or malformed locators are counted in the header and skipped. Active runs whose process metadata is dead and whose heartbeat/update timestamp is stale are rendered read-only as `failed` with failure `stale`; the panel does not mutate or delete records. Use `action:"reconcile"` to repair local registry state from durable artifacts when possible.

The panel is for human inspection; existing-run tool actions remain the programmatic interface.

## Development validation

In this source checkout:

```bash
npm install --legacy-peer-deps   # peer deps (pi-coding-agent) are required for typecheck
npm run check                    # typecheck + static checks
npm run check:all                # plus model-backed integration checks (needs model auth)
npm run validate
npm pack --dry-run --json
```
