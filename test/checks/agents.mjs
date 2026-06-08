#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentSystemPrompt, loadAgentByName } from "../../src/agents.ts";
import { buildPiArgv } from "../../src/runners/headless-model.ts";

const tempRoot = await mkdtemp(join(tmpdir(), "pi-subagent-agents-"));
try {
  const cwd = join(tempRoot, "repo");
  const agentsDir = join(cwd, ".pi", "agents", "review");
  await mkdir(agentsDir, { recursive: true });
  await writeFile(join(agentsDir, "security.md"), `---
name: security-reviewer
description: Security specialist for check coverage
model: check-provider/check-model
thinking: high
tools:
  - read
  - grep
systemPromptMode: append
---
SMOKE_AGENT_PROMPT_MARKER
Always mention injected-agent-ok.
`);

  const agent = await loadAgentByName("review.security", cwd, "project");
  assert.ok(agent, "project agent should load by dotted path alias");
  assert.equal(agent.name, "security-reviewer");
  assert.equal(agent.source, "project");
  assert.equal(agent.model, "check-provider/check-model");
  assert.equal(agent.thinking, "high");
  assert.deepEqual(agent.tools, ["read", "grep"]);
  assert.match(buildAgentSystemPrompt(agent), /SMOKE_AGENT_PROMPT_MARKER/);

  const argv = buildPiArgv({ agent: "review.security", task: "check injection", cwd, agentDefinition: agent });
  const appendIndex = argv.indexOf("--append-system-prompt");
  assert.ok(appendIndex > 0, "agent system prompt should be appended");
  assert.match(argv[appendIndex + 1], /SMOKE_AGENT_PROMPT_MARKER/);
  assert.deepEqual(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 2), ["--model", "check-provider/check-model"]);
  assert.deepEqual(argv.slice(argv.indexOf("--thinking"), argv.indexOf("--thinking") + 2), ["--thinking", "high"]);
  assert.deepEqual(argv.slice(argv.indexOf("--tools"), argv.indexOf("--tools") + 2), ["--tools", "read,grep"]);
  assert.equal(argv.includes("--no-tools"), false);

  const ignoredOverrideArgv = buildPiArgv({ agent: "review.security", task: "check ignored override", cwd, agentDefinition: agent, tools: ["read"] });
  assert.deepEqual(ignoredOverrideArgv.slice(ignoredOverrideArgv.indexOf("--tools"), ignoredOverrideArgv.indexOf("--tools") + 2), ["--tools", "read,grep"]);

  const ignoredNoToolsArgv = buildPiArgv({ agent: "review.security", task: "check ignored no tools", cwd, agentDefinition: agent, tools: [] });
  assert.deepEqual(ignoredNoToolsArgv.slice(ignoredNoToolsArgv.indexOf("--tools"), ignoredNoToolsArgv.indexOf("--tools") + 2), ["--tools", "read,grep"]);
  assert.equal(ignoredNoToolsArgv.includes("--no-tools"), false);

  const agentsOpenDir = join(cwd, ".pi", "agents");
  await writeFile(join(agentsOpenDir, "open.md"), `---
name: open-agent
description: Agent with no tool declaration
---
OPEN_AGENT_PROMPT_MARKER
`);
  const openAgent = await loadAgentByName("open", cwd, "project");
  assert.ok(openAgent, "agent without tools should load");
  assert.equal(openAgent.tools, undefined);
  const openArgv = buildPiArgv({ agent: "open", task: "check default tools", cwd, agentDefinition: openAgent, tools: ["read"] });
  assert.equal(openArgv.includes("--tools"), false, "agent without declared tools should ignore call tools and use default tool surface");
  assert.equal(openArgv.includes("--no-tools"), false, "agent without declared tools should not disable tools");

  const agentlessArgv = buildPiArgv({ agent: "headless-worker", task: "check agentless tools", cwd, tools: ["read"] });
  assert.deepEqual(agentlessArgv.slice(agentlessArgv.indexOf("--tools"), agentlessArgv.indexOf("--tools") + 2), ["--tools", "read"]);

  const agentlessNoToolsArgv = buildPiArgv({ agent: "headless-worker", task: "check agentless no tools", cwd, tools: [] });
  assert.equal(agentlessNoToolsArgv.includes("--tools"), false);
  assert.equal(agentlessNoToolsArgv.includes("--no-tools"), true);

  const noAgentArgv = buildPiArgv({ agent: "missing-compatible", task: "check default tools", cwd });
  assert.equal(noAgentArgv.includes("--tools"), false, "missing agent definition without call tools should not constrain tools");
  assert.equal(noAgentArgv.includes("--no-tools"), false, "missing agent definition without call tools should not disable tools");

  const globalOnly = await loadAgentByName("review.security", cwd, "global");
  assert.equal(globalOnly, undefined, "global scope should not load project agent");

  console.log(JSON.stringify({ name: "check-agents", status: "completed", agent: agent.displayName }, null, 2));
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
