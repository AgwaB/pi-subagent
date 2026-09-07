#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentSystemPrompt, loadAgentByName } from "../../src/agents.ts";
import { buildPiArgv } from "../../src/runners/headless-model.ts";
import { runSubagent, SubagentValidationError } from "../../api.mjs";
import { createJiti } from "jiti";

const tempRoot = await mkdtemp(join(tmpdir(), "pi-subagent-agents-"));
const originalPath = process.env.PATH;
try {
	const sharedAgentsDir = join(tempRoot, ".pi", "agents");
	await mkdir(sharedAgentsDir, { recursive: true });
	await writeFile(
		join(sharedAgentsDir, "inherited.md"),
		`---
name: inherited
---
SHOULD_NOT_LOAD_FROM_SHARED_PARENT
`,
	);

	const emptyRepo = join(tempRoot, "empty-repo");
	await mkdir(join(emptyRepo, ".git"), { recursive: true });
	const inherited = await loadAgentByName("inherited", emptyRepo, "project");
	assert.equal(
		inherited,
		undefined,
		"project agents must not be inherited from above the git boundary",
	);

	const cwd = join(tempRoot, "repo");
	await mkdir(join(cwd, ".git"), { recursive: true });
	const agentsDir = join(cwd, ".pi", "agents", "review");
	await mkdir(agentsDir, { recursive: true });
	await writeFile(
		join(agentsDir, "security.md"),
		`---
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
`,
	);

	const agent = await loadAgentByName("review.security", cwd, "project");
	assert.ok(agent, "project agent should load by dotted path alias");
	assert.equal(agent.name, "security-reviewer");
	assert.equal(agent.source, "project");
	assert.equal(agent.model, "check-provider/check-model");
	assert.equal(agent.thinking, "high");
	assert.deepEqual(agent.tools, ["read", "grep"]);
	assert.match(buildAgentSystemPrompt(agent), /SMOKE_AGENT_PROMPT_MARKER/);

	const argv = buildPiArgv({
		agent: "review.security",
		task: "check injection",
		cwd,
		agentDefinition: agent,
	});
	assert.deepEqual(
		argv.slice(
			argv.indexOf("--exclude-tools"),
			argv.indexOf("--exclude-tools") + 2,
		),
		["--exclude-tools", "subagent"],
	);
	assert.equal(
		argv.includes("--no-extensions"),
		false,
		"ambient extensions should be loaded by default",
	);
	assert.equal(
		argv.includes("--no-skills"),
		false,
		"ambient skills should be loaded by default",
	);
	const appendIndex = argv.indexOf("--append-system-prompt");
	assert.ok(appendIndex > 0, "agent system prompt should be appended");
	assert.match(argv[appendIndex + 1], /SMOKE_AGENT_PROMPT_MARKER/);
	assert.deepEqual(
		argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 2),
		["--model", "check-provider/check-model"],
	);
	assert.deepEqual(
		argv.slice(argv.indexOf("--thinking"), argv.indexOf("--thinking") + 2),
		["--thinking", "high"],
	);
	assert.deepEqual(
		argv.slice(argv.indexOf("--tools"), argv.indexOf("--tools") + 2),
		["--tools", "read,grep"],
	);
	assert.equal(argv.includes("--no-tools"), false);

	const narrowedOverrideArgv = buildPiArgv({
		agent: "review.security",
		task: "check narrowed override",
		cwd,
		agentDefinition: agent,
		tools: ["read"],
	});
	assert.deepEqual(
		narrowedOverrideArgv.slice(
			narrowedOverrideArgv.indexOf("--tools"),
			narrowedOverrideArgv.indexOf("--tools") + 2,
		),
		["--tools", "read"],
	);

	const noToolsArgv = buildPiArgv({
		agent: "review.security",
		task: "check no tools",
		cwd,
		agentDefinition: agent,
		tools: [],
	});
	assert.equal(noToolsArgv.includes("--tools"), false);
	assert.equal(noToolsArgv.includes("--no-tools"), true);

	const agentsOpenDir = join(cwd, ".pi", "agents");
	await writeFile(
		join(agentsOpenDir, "open.md"),
		`---
name: open-agent
description: Agent with no tool declaration
---
OPEN_AGENT_PROMPT_MARKER
`,
	);
	const openAgent = await loadAgentByName("open", cwd, "project");
	assert.ok(openAgent, "agent without tools should load");
	assert.equal(openAgent.tools, undefined);
	const openArgv = buildPiArgv({
		agent: "open",
		task: "check default tools",
		cwd,
		agentDefinition: openAgent,
		tools: ["read"],
	});
	assert.deepEqual(
		openArgv.slice(openArgv.indexOf("--tools"), openArgv.indexOf("--tools") + 2),
		["--tools", "read"],
	);

	const agentlessArgv = buildPiArgv({
		agent: "headless-worker",
		task: "check agentless tools",
		cwd,
		tools: ["read"],
	});
	assert.deepEqual(
		agentlessArgv.slice(
			agentlessArgv.indexOf("--tools"),
			agentlessArgv.indexOf("--tools") + 2,
		),
		["--tools", "read"],
	);

	const agentlessNoToolsArgv = buildPiArgv({
		agent: "headless-worker",
		task: "check agentless no tools",
		cwd,
		tools: [],
	});
	assert.equal(agentlessNoToolsArgv.includes("--tools"), false);
	assert.equal(agentlessNoToolsArgv.includes("--no-tools"), true);

	const noAgentArgv = buildPiArgv({
		agent: "missing-compatible",
		task: "check default tools",
		cwd,
	});
	assert.equal(
		noAgentArgv.includes("--tools"),
		false,
		"missing agent definition without call tools should not constrain tools",
	);
	assert.equal(
		noAgentArgv.includes("--no-tools"),
		false,
		"missing agent definition without call tools should not disable tools",
	);

	const explicitPromptArgv = buildPiArgv({
		agent: "review.security",
		task: "raw task prompt",
		cwd,
		agentDefinition: agent,
		systemPrompt: "COMPILED_SYSTEM_PROMPT",
		skills: ["/tmp/skill"],
		extensions: ["/tmp/ext.ts"],
	});
	assert.equal(
		explicitPromptArgv.includes("--append-system-prompt"),
		false,
		"systemPrompt should suppress agent prompt append",
	);
	assert.deepEqual(
		explicitPromptArgv.slice(
			explicitPromptArgv.indexOf("--system-prompt"),
			explicitPromptArgv.indexOf("--system-prompt") + 2,
		),
		["--system-prompt", "COMPILED_SYSTEM_PROMPT"],
	);
	assert.deepEqual(
		explicitPromptArgv.slice(
			explicitPromptArgv.indexOf("--skill"),
			explicitPromptArgv.indexOf("--skill") + 2,
		),
		["--skill", "/tmp/skill"],
	);
	assert.deepEqual(
		explicitPromptArgv.slice(
			explicitPromptArgv.indexOf("--extension"),
			explicitPromptArgv.indexOf("--extension") + 2,
		),
		["--extension", "/tmp/ext.ts"],
	);
	assert.equal(explicitPromptArgv.includes("--no-skills"), false);
	assert.equal(explicitPromptArgv.includes("--no-extensions"), false);
	assert.match(explicitPromptArgv.at(-1), /^raw task prompt$/);

	const hermeticArgv = buildPiArgv({
		agent: "review.security",
		task: "hermetic child",
		cwd,
		agentDefinition: agent,
		skills: [],
		extensions: [],
	});
	assert.equal(
		hermeticArgv.includes("--no-skills"),
		true,
		"skills: [] should disable child skills",
	);
	assert.equal(
		hermeticArgv.includes("--no-extensions"),
		true,
		"extensions: [] should disable child extensions",
	);

	await assert.rejects(
		() =>
			runSubagent({
				cwd,
				backend: "inline",
				agent: "review.security",
				agentScope: "project",
				confirmProjectAgents: false,
				task: "check expansion",
				tools: ["read", "write"],
			}),
		(error) =>
			error instanceof SubagentValidationError &&
			/caller tools expand/.test(error.message),
	);

	await assert.rejects(
		() =>
			runSubagent({
				cwd,
				backend: "inline",
				agent: "review.security",
				agentScope: "project",
				confirmProjectAgents: false,
				systemPrompt: "COMPILED",
				task: "check compiled prompt expansion",
				tools: ["write"],
			}),
		(error) =>
			error instanceof SubagentValidationError &&
			/caller tools expand/.test(error.message),
	);

	await assert.rejects(
		() =>
			runSubagent({
				cwd,
				backend: "inline",
				agent: "open",
				agentScope: "project",
				confirmProjectAgents: false,
				task: "check undefined tools",
				tools: ["read"],
			}),
		(error) =>
			error instanceof SubagentValidationError &&
			/does not declare a tools authority ceiling/.test(error.message),
	);

	const globalOnly = await loadAgentByName("review.security", cwd, "global");
	assert.equal(
		globalOnly,
		undefined,
		"global scope should not load project agent",
	);

	// Exercise both entry points without provider calls. The fake CLI runs only
	// after approval and task preparation have accepted the effective inputs.
	const bin = join(tempRoot, "bin");
	await mkdir(bin);
	await writeFile(
		join(bin, "pi"),
		`#!${process.execPath}\nconsole.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"approval-ok"}],stopReason:"stop"}}));\n`,
		{ mode: 0o755 },
	);
	process.env.PATH = `${bin}:${originalPath}`;
	const jiti = createJiti(import.meta.url, { interopDefault: true });
	const extension = await jiti.import("../../src/index.ts");
	let tool;
	(extension.default ?? extension)({
		registerCommand() {},
		registerTool(value) {
			tool = value;
		},
	});
	const common = {
		cwd,
		backend: "headless",
		agent: "review.security",
		agentScope: "project",
		tools: [],
		extensions: [],
		skills: [],
	};
	const approvalCases = [
		{ name: "default inherited", tasks: [{ task: "check" }], denied: false },
		{
			name: "false inherited",
			confirmProjectAgents: false,
			tasks: [{ task: "check" }],
			denied: false,
		},
		{
			name: "true single",
			confirmProjectAgents: true,
			task: "check",
			denied: true,
		},
		{
			name: "true explicit",
			confirmProjectAgents: true,
			tasks: [{ agent: "review.security", task: "check" }],
			denied: true,
		},
		{
			name: "true inherited",
			confirmProjectAgents: true,
			tasks: [{ task: "check" }],
			denied: true,
		},
		{
			name: "child false",
			confirmProjectAgents: true,
			tasks: [{ confirmProjectAgents: false, task: "check" }],
			denied: false,
		},
		{
			name: "child true",
			confirmProjectAgents: false,
			tasks: [{ confirmProjectAgents: true, task: "check" }],
			denied: true,
		},
		{
			name: "child global",
			confirmProjectAgents: true,
			tasks: [{ agentScope: "global", task: "check" }],
			denied: false,
		},
		{
			name: "child project",
			agent: "not-a-project-agent",
			agentScope: "global",
			confirmProjectAgents: true,
			tasks: [{ agent: "review.security", agentScope: "project", task: "check" }],
			denied: true,
		},
	];
	for (const { name, denied, ...overrides } of approvalCases) {
		const input = { ...common, ...overrides };
		if (denied) {
			await assert.rejects(
				runSubagent(input),
				/Project-local subagent definitions/u,
				`API: ${name}`,
			);
		} else {
			const result = await runSubagent(input);
			for (const child of result.results ?? [result])
				assert.equal(
					child.status,
					"completed",
					`API: ${name}: ${JSON.stringify(result)}`,
				);
		}
		const response = await tool.execute(
			`approval-${name}`,
			input,
			undefined,
			undefined,
			{ cwd, hasUI: false },
		);
		if (denied)
			assert.match(
				JSON.stringify(response),
				/Project-local subagent definitions/u,
				`tool: ${name}`,
			);
		else
			for (const child of response.details.results ?? [response.details])
				assert.equal(
					child.status,
					"completed",
					`tool: ${name}: ${JSON.stringify(response)}`,
				);
	}
	for (const approved of [false, true]) {
		let prompts = 0;
		const response = await tool.execute(
			"approval-ui",
			{ ...common, confirmProjectAgents: true, tasks: [{ task: "check" }] },
			undefined,
			undefined,
			{
				cwd,
				hasUI: true,
				ui: {
					confirm: async () => {
						prompts++;
						return approved;
					},
				},
			},
		);
		assert.equal(prompts, 1, "inherited agent gets one interactive approval");
		if (approved) assert.equal(response.details.results[0].status, "completed");
		else assert.match(JSON.stringify(response), /were not approved/u);
	}

	console.log(
		JSON.stringify(
			{ name: "check-agents", status: "completed", agent: agent.displayName },
			null,
			2,
		),
	);
} finally {
	if (originalPath === undefined) delete process.env.PATH;
	else process.env.PATH = originalPath;
	await rm(tempRoot, { recursive: true, force: true });
}
