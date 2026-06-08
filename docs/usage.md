# pi-subagent Usage

Detailed usage reference for the public Pi tool **`subagent`**.

## Install

```bash
pi install npm:pi-subagent
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
| `run` (default) | Start a new subagent (single or parallel). | `agent`/`task` or `tasks`; plus `sandbox`, `worktree`, `model`, `async`, etc. |
| `status` | Read a run's current state. | `runId`, optional `taskId` |
| `logs` | Read a run's captured logs. | `runId`, optional `taskId` |
| `wait` | Block until a run finishes. | `runId`, optional `timeoutMs`, `pollIntervalMs` |
| `interrupt` | Signal a process-backed run. | `runId`, optional `signal`, `escalateAfterMs`, `killAfterMs`, `reason` |
| `mark-background` | Mark a run as not needed before the final answer. | `runId` |

State is file-based under `.pi/agent/runs/<run-id>/`. `status`/`logs`/`wait` read those files; `interrupt` sends a real OS signal; `mark-background` updates run metadata.

## Calling the tool

The examples below show `subagent` argument objects. Pi usually builds these from natural-language requests; extensions or tests can pass the same object as `params` to the registered tool's `execute` function.

## Single task

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

Parallel tasks use isolated git worktrees by default so worker mutations do not collide in the base checkout. Explicit shared-checkout parallel mutation is rejected.

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

## Common run options

| Option | Use |
|---|---|
| `cwd` | Run from a specific project directory. Existing-run actions also accept `cwd` to find that run registry. |
| `timeoutMs` | Limit worker execution time for `run`; limit polling duration for `action: "wait"`. |
| `visible` | Use a visible tmux-backed worker (`visible: true`). |
| `concurrency` | Cap parallel task fan-out. |
| `model` | Select a Pi model/provider for model-backed workers. |
| `thinking` / `thinkingLevel` / `reasoningLevel` | Set the reasoning level. |
| `tools` | Agentless tool allowlist. Ignored when `agent` is set; use agent frontmatter instead. |
| `roleContext` | Add one-off role instructions without creating an agent file. |
| `agentScope` | Restrict agent lookup to `auto`, `global`, or `project`. |
| `confirmProjectAgents` | Set `false` to skip the project-agent confirmation prompt for trusted repositories. |

## Sandbox

```json
{
  "sandbox": true,
  "agent": "checker",
  "task": "Run a local check and report the artifact paths."
}
```

Rules:

- `sandbox: true` enables sandboxing. `false`, `null`, or omission disables it.
- Process-backed workers (`headless`, `tmux`) can be sandboxed.
- `inline + sandbox` fails validation because an in-process SDK worker cannot provide per-worker OS sandboxing.
- The public API intentionally does not expose sandbox engine selection yet.

## Workspaces and worktrees

There are three inputs for worktree isolation, in order of preference:

| Input | When to use |
|---|---|
| `worktree` | Primary switch. `true` to isolate; or a string path for an explicit worktree location. |
| `workspace` | Advanced. `"shared" | "worktree" | "auto"`, or `{ mode, path }` for an explicit path. |
| `worktreePolicy` | Advanced. `"auto" | "required" | "never"` to force or forbid isolation. |

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

Parallel runs use worktrees by default. Non-git workspaces cannot create git worktrees and fail safely when worktree isolation is required.

Worktree cleanup is managed:

```text
completed -> capture status/diff artifacts, then remove the worktree
failed/cancelled -> capture status/diff artifacts, keep the worktree for debugging
```

Worktree evidence is recorded in `result.json` under `workspace.worktreeCleanupStatus`, `workspace.worktreeStatusPath`, and `workspace.worktreeDiffPath`.

## Backend selection

Backend is optional. When omitted, the engine uses auto-selection:

| Input condition | Resolved backend |
|---|---|
| `visible: true` | `tmux` |
| `sandbox: true` | `headless`, unless tmux/visible is explicit |
| normal `agent`/`task` | `inline` |

Supported explicit backend values are `auto`, `inline`, `headless`, and `tmux`. Most users should omit `backend`. Use `visible: true` only when you want a tmux-backed visible worker.

## Agent definitions

When `agent` names a Pi agent markdown file, the engine injects that agent's body as system prompt context and inherits supported frontmatter such as `model`, `thinking`, and `tools`.

`tools` can be declared in the agent file as that agent's tool allowlist. When `agent` is set, call-level `tools` is ignored; define tools in the agent file instead. If the agent file omits `tools`, the worker uses Pi's default tool surface.

For agentless model-backed runs, call-level `tools` can set the tool allowlist. Use `tools: []` to run an agentless task with no tools.

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

Project-local agents are repository-controlled. In interactive Pi sessions, the engine asks for confirmation before using them unless `confirmProjectAgents:false` is set.

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

## Artifacts

Runs write durable evidence under:

```text
.pi/agent/runs/<run-id>/
├── run.json
├── events.jsonl
└── <task-id>/
    ├── result.json
    ├── stdout.log
    ├── stderr.log
    └── output.log
```

Tool responses return compact status and artifact references rather than raw logs.

## TUI monitor

```text
/subagent panel
```

The panel is read-only. It shows all/completed/failed filters, run/task details, workspace/artifact paths, dependency metadata, event tail, and log tail. The panel is for human inspection; existing-run tool actions remain the programmatic interface.

## Development validation

In this source checkout:

```bash
npm run validate
npm run validate:stress
npm pack --dry-run --json
```
