# pi-subagent

**Minimal subagent runtime for Pi.**

[![npm](https://img.shields.io/npm/v/pi-subagent.svg)](https://www.npmjs.com/package/pi-subagent)

`pi-subagent` adds one focused tool: `subagent`. It gives Pi the essentials for isolated worker runs — parallel fan-out, sandbox/worktree controls, durable artifacts, and async status.

It is intentionally small, so you can add it to a project when you need subagents and remove it when you do not.

npm package: [`pi-subagent`](https://www.npmjs.com/package/pi-subagent)

## Installation

```bash
pi install npm:pi-subagent
```

Then reload Pi.

Requires Node.js `>=22.19.0`.

For local development, add this package as a Pi extension source and reload Pi.

## Quick usage

Use it when you want Pi to spin up a separate worker instead of doing everything in the parent session:

```text
Run three isolated reviewers in parallel for this change.
```

```text
Run this check in a sandboxed worker and report the artifact paths.
```

```text
Start a background audit and let me inspect it in /subagent panel.
```


## What it does

Tool: `subagent`

### Sandbox

Run workers in an isolated local execution boundary.

```json
{
  "sandbox": true,
  "agent": "checker",
  "task": "Run a local check and report the artifact paths."
}
```

### Worktree

Isolate parallel or mutating tasks in managed git worktrees.

```json
{
  "worktree": true,
  "agent": "implementer",
  "task": "Make the requested local change in an isolated worktree."
}
```

### Agent

Inject Pi subagent markdown definitions from global or project agent directories.

```json
{
  "agent": "reviewer-security",
  "task": "Review the current diff for security risks."
}
```

Agent markdown can live in `~/.pi/agent/agents/*.md` or `.pi/agents/*.md`. Agent-level `tools` declarations control that agent's tool surface. If omitted, Pi's default tools are available.

### Type

Use one structured schema for single, parallel, async, and existing-run calls. `action` defaults to `run`.

Single:

```json
{
  "agent": "reviewer",
  "task": "Review the current diff and summarize the highest-risk issues."
}
```

Parallel:

```json
{
  "tasks": [
    { "agent": "reviewer-security", "task": "Review the current diff for security risks." },
    { "agent": "reviewer-performance", "task": "Review the current diff for performance risks." },
    { "agent": "reviewer-test-coverage", "task": "Review the current diff for missing tests." }
  ]
}
```

Existing run:

```json
{ "action": "status", "runId": "run_..." }
```

### Panel

Inspect runs, tasks, artifacts, and log tails in a read-only live TUI.

Open the read-only run monitor:

```text
/subagent panel
```

![/subagent panel](./assets/subagent-panel.png)

## Detailed docs

- [`docs/usage.md`](./docs/usage.md) — full argument reference, `action` behavior, backend selection, sandbox/worktree behavior, artifacts, and validation notes.

