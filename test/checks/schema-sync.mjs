#!/usr/bin/env node
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createJiti } from "jiti";
import { validateResolveInput } from "../../src/core/validation.ts";

const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	moduleCache: false,
});
const mod = await jiti.import(resolve("src/index.ts"));
const registerSubagentEngine = mod.default ?? mod;

let registeredTool;
registerSubagentEngine({
	registerCommand() {},
	registerTool(tool) {
		registeredTool = tool;
	},
});
assert.ok(registeredTool, "subagent tool must register");

const schemaKeys = Object.keys(registeredTool.parameters.properties ?? {});
assert.ok(schemaKeys.length > 0, "tool schema must expose properties");

// Every schema-advertised key must be accepted by the unsupported-keys gate,
// i.e. either consumed by run input validation or by lifecycle actions.
const probeValues = {
	backend: "auto",
	visible: true,
	sandbox: true,
	agent: "worker",
	task: "inspect",
	roleContext: "role",
	agentScope: "auto",
	confirmProjectAgents: true,
	mode: "single",
	tasks: [{ agent: "worker", task: "inspect" }],
	concurrency: 2,
	failFast: true,
	cancelSiblingsOnFailure: true,
	asyncDependency: "background",
	workspace: "shared",
	worktree: true,
	worktreePolicy: "auto",
	cwd: ".",
	async: true,
	onComplete: "return",
	timeoutMs: 1000,
	model: "provider/model",
	tools: ["read"],
	systemPrompt: "prompt",
	skills: ["skill"],
	extensions: ["ext"],
	runsDir: ".pi/agent/runs",
	correlationId: "corr",
	captureToolCalls: true,
	thinking: "low",
	thinkingLevel: "low",
	reasoningLevel: "low",
};
const lifecycleKeys = new Set([
	"action",
	"runId",
	"attemptId",
	"taskId",
	"pollIntervalMs",
	"reason",
	"signal",
	"escalateAfterMs",
	"killAfterMs",
]);

for (const key of schemaKeys) {
	if (lifecycleKeys.has(key)) continue;
	assert.ok(
		key in probeValues,
		`schema key "${key}" missing probe value; add it to this check`,
	);
	const single =
		key === "tasks" || key === "concurrency"
			? { [key]: probeValues[key], tasks: probeValues.tasks }
			: { agent: "worker", task: "inspect", [key]: probeValues[key] };
	const validation = validateResolveInput(single);
	assert.equal(
		validation.ok,
		true,
		`schema key "${key}" must be accepted by validateResolveInput: ${validation.ok ? "" : validation.failure.error}`,
	);
}

// captureToolCalls is reachable end to end: schema, validation, and task items.
assert.ok(
	schemaKeys.includes("captureToolCalls"),
	"tool schema exposes captureToolCalls",
);
const taskSchemaKeys = Object.keys(
	registeredTool.parameters.properties.tasks.items.properties ?? {},
);
assert.ok(
	taskSchemaKeys.includes("captureToolCalls"),
	"task schema exposes captureToolCalls",
);
const taskLevel = validateResolveInput({
	tasks: [{ agent: "worker", task: "inspect", captureToolCalls: true }],
});
assert.equal(taskLevel.ok, true);
assert.equal(taskLevel.input.tasks[0].captureToolCalls, true);

console.log(
	JSON.stringify(
		{
			name: "check-schema-sync",
			status: "completed",
			schemaKeys: schemaKeys.length,
		},
		null,
		2,
	),
);
