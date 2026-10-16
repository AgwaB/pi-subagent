#!/usr/bin/env node
// `max` is a first-class thinking level (Pi 0.80.6+): the tool schema, input
// validation, agent frontmatter, and model suffixes accept it, and headless and
// inline children receive it unchanged.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";
import { parseAgentMarkdown } from "../../src/agents.ts";
import { THINKING_LEVELS } from "../../src/core/constants.ts";
import { validateResolveInput } from "../../src/core/validation.ts";
import { buildPiArgv } from "../../src/runners/headless-model.ts";
import { runInlineModel, setInlineSdkImporterForTests } from "../../src/runners/inline.ts";

assert.deepEqual(THINKING_LEVELS, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const mod = await jiti.import(resolve("src/index.ts"));
let tool;
(mod.default ?? mod)({ registerCommand() {}, registerTool(registered) { tool = registered; } });
for (const key of ["thinking", "thinkingLevel", "reasoningLevel"]) {
	const literals = (tool.parameters.properties[key]?.anyOf ?? []).map((schema) => schema.const);
	assert.ok(literals.includes("max"), `tool schema ${key} must offer max`);
}

for (const key of ["thinking", "thinkingLevel", "reasoningLevel"]) {
	const validation = validateResolveInput({ agent: "scout", task: "t", [key]: "max" });
	assert.equal(validation.ok, true, key);
	assert.equal(validation.input.thinking, "max", key);
}
const perTask = validateResolveInput({ tasks: [{ agent: "scout", task: "t", thinking: "max" }] });
assert.equal(perTask.ok, true);
assert.equal(perTask.input.tasks[0].thinking, "max");
const rejected = validateResolveInput({ agent: "scout", task: "t", thinking: "ultra" });
assert.equal(rejected.ok, false);
assert.match(rejected.failure.error, /"xhigh", "max"\./);

const agent = parseAgentMarkdown("---\nname: max-agent\ndescription: Max thinking agent\nthinking: max\n---\nBody\n", "/tmp/max-agent.md", "global");
assert.equal(agent?.thinking, "max");

const argv = buildPiArgv({ agent: "scout", task: "t", cwd: tmpdir(), thinking: "max" });
assert.deepEqual(argv.slice(argv.indexOf("--thinking"), argv.indexOf("--thinking") + 2), ["--thinking", "max"]);

let captured;
const session = {
	messages: [],
	subscribe() { return () => undefined; },
	async prompt() {
		session.messages.push({ role: "assistant", content: [{ type: "text", text: "ok" }], provider: "fake", model: "model", stopReason: "stop" });
	},
	abort() { return Promise.resolve(); },
	dispose() {},
};
setInlineSdkImporterForTests(async () => ({
	module: {
		ModelRegistry: class {
			async refresh() {}
			find(provider, id) { return provider === "fake" && id === "model" ? { provider, id } : undefined; }
			getAvailable() { return [{ provider: "fake", id: "model" }]; }
		},
		ModelRuntime: { async create() { return {}; } },
		SessionManager: { inMemory() { return {}; } },
		DefaultResourceLoader: class { async reload() {} },
		getAgentDir() { return "/nonexistent-agent-dir"; },
		async createAgentSession(options) { captured = options; return { session, diagnostics: [] }; },
	},
	source: "<fake>",
}));
const cwd = await mkdtemp(join(tmpdir(), "pi-subagent-thinking-max-"));
try {
	const explicit = await runInlineModel({ agent: "scout", task: "t", cwd, thinking: "max" });
	assert.equal(explicit.status, "completed");
	assert.equal(captured.thinkingLevel, "max");
	const suffix = await runInlineModel({ agent: "scout", task: "t", cwd, model: "fake/model:max" });
	assert.equal(suffix.status, "completed");
	assert.equal(captured.thinkingLevel, "max");
	assert.deepEqual(captured.model, { provider: "fake", id: "model" });
	console.log(JSON.stringify({ name: "check-thinking-levels", status: "completed" }, null, 2));
} finally {
	setInlineSdkImporterForTests(undefined);
	await rm(cwd, { recursive: true, force: true });
}
