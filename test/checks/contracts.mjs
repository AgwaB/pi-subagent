#!/usr/bin/env node
import assert from "node:assert/strict";
import { createResultEnvelope } from "../../src/artifacts/index.ts";
import { validateResolveInput } from "../../src/core/validation.ts";
import {
	createRunStatusSnapshot,
	isTerminalStatus,
	statusFailedClosed,
	statusSucceeded,
	summarizeChildEvents,
} from "../../src/orchestrate/index.ts";
import {
	detectContextLengthExceeded,
	parsePiJsonLines,
} from "../../src/runners/headless-model.ts";

const plannedInput = {
	backend: "auto",
	agent: "typescript-expert",
	task: "inspect public contracts",
	roleContext: "read-only reviewer",
	agentScope: "project",
	confirmProjectAgents: true,
	mode: "parallel",
	tasks: [
		{
			agent: "typescript-expert",
			task: "review schemas",
			roleContext: "contract checker",
		},
		{ agent: "contract-reader", task: "review schemas", timeoutMs: 1000 },
	],
	concurrency: 2,
	failFast: true,
	cancelSiblingsOnFailure: true,
	asyncDependency: "needed-before-final",
	visible: false,
	sandbox: true,
	workspace: { mode: "auto", path: "." },
	worktree: true,
	worktreePolicy: "auto",
	cwd: process.cwd(),
	async: true,
	onComplete: "return",
	timeoutMs: 5000,
	model: "kimi-coding/kimi-for-coding",
	tools: ["read", "grep"],
	systemPrompt: "Compiled system prompt",
	skills: ["/tmp/skill"],
	extensions: ["/tmp/extension.ts"],
	captureToolCalls: true,
	runsDir: ".pi/custom-runs",
	correlationId: "corr_contracts",
	reasoningLevel: "xhigh",
};

const validation = validateResolveInput(plannedInput);
assert.equal(validation.ok, true);
assert.equal(validation.input.agent, plannedInput.agent);
assert.equal(validation.input.tasks.length, 2);
assert.equal(validation.input.concurrency, 2);
assert.equal(validation.input.failFast, true);
assert.equal(validation.input.cancelSiblingsOnFailure, true);
assert.equal(validation.input.asyncDependency, "needed-before-final");
assert.equal(validation.input.workspace.mode, "auto");
assert.equal(validation.input.model, "kimi-coding/kimi-for-coding");
assert.deepEqual(validation.input.tools, ["read", "grep"]);
assert.equal(validation.input.thinking, "xhigh");
assert.equal(validation.input.systemPrompt, "Compiled system prompt");
assert.deepEqual(validation.input.skills, ["/tmp/skill"]);
assert.deepEqual(validation.input.extensions, ["/tmp/extension.ts"]);
assert.equal(validation.input.captureToolCalls, true);
assert.equal(validation.input.runsDir, ".pi/custom-runs");
assert.equal(validation.input.correlationId, "corr_contracts");

const sessionIdValidation = validateResolveInput({
	agent: "worker",
	task: "inspect",
	sessionId: "abc-123_ok",
});
assert.equal(sessionIdValidation.ok, true);
assert.equal(sessionIdValidation.input.sessionId, "abc-123_ok");

const emptySessionIdValidation = validateResolveInput({
	agent: "worker",
	task: "inspect",
	sessionId: "",
});
assert.equal(emptySessionIdValidation.ok, false);
assert.match(
	emptySessionIdValidation.failure.error,
	/sessionId must be a non-empty string/,
);

const badSessionIdValidation = validateResolveInput({
	agent: "worker",
	task: "inspect",
	sessionId: "bad id",
});
assert.equal(badSessionIdValidation.ok, false);
assert.match(
	badSessionIdValidation.failure.error,
	/sessionId must contain only letters/,
);

const taskSessionValidation = validateResolveInput({
	mode: "parallel",
	tasks: [
		{ agent: "worker", task: "a", sessionId: "child-a" },
		{ agent: "worker", task: "b", sessionId: "child-b" },
	],
});
assert.equal(taskSessionValidation.ok, true);
assert.equal(taskSessionValidation.input.tasks[0].sessionId, "child-a");
assert.equal(taskSessionValidation.input.tasks[1].sessionId, "child-b");

const sharedParallelSessionValidation = validateResolveInput({
	mode: "parallel",
	sessionId: "shared-session",
	tasks: [{ agent: "worker", task: "a" }],
});
assert.equal(sharedParallelSessionValidation.ok, false);
assert.match(
	sharedParallelSessionValidation.failure.error,
	/top-level sessionId is not supported with parallel tasks/,
);

const badTaskSessionValidation = validateResolveInput({
	mode: "parallel",
	tasks: [{ agent: "worker", task: "a", sessionId: "bad id" }],
});
assert.equal(badTaskSessionValidation.ok, false);
assert.match(
	badTaskSessionValidation.failure.error,
	/tasks\[0\]\.sessionId must contain only letters/,
);

const badFailFastValidation = validateResolveInput({
	agent: "worker",
	task: "inspect",
	failFast: "yes",
});
assert.equal(badFailFastValidation.ok, false);
assert.match(badFailFastValidation.failure.error, /failFast must be a boolean/);

const taskModelValidation = validateResolveInput({
	mode: "parallel",
	tasks: [
		{
			agent: "scout",
			task: "audit",
			model: "kimi-coding/kimi-for-coding",
			thinking: "high",
			tools: [],
			captureToolCalls: true,
		},
	],
});
assert.equal(taskModelValidation.ok, true);
assert.equal(
	taskModelValidation.input.tasks[0].model,
	"kimi-coding/kimi-for-coding",
);
assert.equal(taskModelValidation.input.tasks[0].thinking, "high");
assert.deepEqual(taskModelValidation.input.tasks[0].tools, []);
assert.equal(taskModelValidation.input.tasks[0].captureToolCalls, true);

const benignContextWindowOutput = parsePiJsonLines(
	[
		JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Subagents are isolated context windows." },
				],
			},
		}),
		"",
	].join("\n"),
);
assert.equal(
	benignContextWindowOutput.finalAssistantText,
	"Subagents are isolated context windows.",
);
assert.equal(
	detectContextLengthExceeded({
		stderrText: "",
		errors: benignContextWindowOutput.errors,
	}),
	false,
);
assert.equal(
	detectContextLengthExceeded({ stderrText: "Error: context length exceeded" }),
	true,
);
assert.equal(
	detectContextLengthExceeded({
		stderrText: "Error: request payload is too large for the context limit",
	}),
	true,
);
assert.equal(
	detectContextLengthExceeded({
		stderrText: "The context window is documented here, not exceeded.",
	}),
	false,
);

const childSummary = summarizeChildEvents([
	{
		schemaVersion: 2,
		timestamp: "2026-01-01T00:00:00.000Z",
		type: "child.started",
		runId: "run_parent",
		status: "running",
		data: { childRunId: "run_child" },
	},
	{
		schemaVersion: 2,
		timestamp: "2026-01-01T00:00:01.000Z",
		type: "child.failed",
		runId: "run_parent",
		status: "failed",
		data: { childRunId: "run_child", failureKind: "model" },
	},
]);
assert.equal(childSummary?.total, 1);
assert.equal(childSummary?.failed, 1);
assert.equal(childSummary?.latestFailure?.childRunId, "run_child");

// Sandbox object form: explicit per-run network egress (C-style caller control).
const sandboxObject = validateResolveInput({
	sandbox: {
		allowedDomains: ["api.anthropic.com", "*.npmjs.org", "localhost"],
	},
	agent: "worker",
	task: "inspect",
});
assert.equal(sandboxObject.ok, true);
assert.deepEqual(sandboxObject.input.sandbox, {
	allowedDomains: ["api.anthropic.com", "*.npmjs.org", "localhost"],
});

const sandboxEmptyObject = validateResolveInput({
	sandbox: {},
	agent: "worker",
	task: "inspect",
});
assert.equal(sandboxEmptyObject.ok, true);
assert.deepEqual(sandboxEmptyObject.input.sandbox, {});

const sandboxTaskObject = validateResolveInput({
	mode: "parallel",
	tasks: [
		{
			agent: "scout",
			task: "audit",
			sandbox: { allowedDomains: ["api.openai.com"] },
		},
	],
});
assert.equal(sandboxTaskObject.ok, true);
assert.deepEqual(sandboxTaskObject.input.tasks[0].sandbox, {
	allowedDomains: ["api.openai.com"],
});

const sandboxBadDomain = validateResolveInput({
	sandbox: { allowedDomains: ["https://api.anthropic.com"] },
	agent: "worker",
	task: "inspect",
});
assert.equal(sandboxBadDomain.ok, false);
assert.match(sandboxBadDomain.failure.error, /must be a bare domain/);

const sandboxBroadWildcard = validateResolveInput({
	sandbox: { allowedDomains: ["*.com"] },
	agent: "worker",
	task: "inspect",
});
assert.equal(sandboxBroadWildcard.ok, false);
assert.match(sandboxBroadWildcard.failure.error, /must be a bare domain/);

const sandboxUnknownKey = validateResolveInput({
	sandbox: { domains: ["api.anthropic.com"] },
	agent: "worker",
	task: "inspect",
});
assert.equal(sandboxUnknownKey.ok, false);
assert.match(sandboxUnknownKey.failure.error, /unsupported sandbox option/);

// Inline backend still rejects any sandbox form.
const inlineObjectSandbox = validateResolveInput({
	backend: "inline",
	sandbox: { allowedDomains: ["api.anthropic.com"] },
	agent: "worker",
	task: "inspect",
});
assert.equal(inlineObjectSandbox.ok, false);
assert.match(
	inlineObjectSandbox.failure.error,
	/inline backend cannot provide/,
);

// Result envelope records the sandbox network policy.
const sandboxedResult = createResultEnvelope({
	runId: "run_contracts_002",
	attemptId: "attempt-contracts-002",
	backend: "headless",
	status: "completed",
	failureKind: null,
	cwd: process.cwd(),
	startedAt: "2026-06-07T00:00:00.000Z",
	completedAt: "2026-06-07T00:00:00.010Z",
	sandbox: { enabled: true, allowedDomains: ["api.anthropic.com"] },
	artifacts: [],
	metadata: {
		contextLengthExceeded: false,
		contextOverflowRecovered: true,
		recoveredStreamErrors: ["context_length_exceeded: compacted"],
		parentSessionId: "parent-contracts",
		sessionId: "contract-session",
		session: {
			id: "contract-session",
			requested: true,
			disposition: "resumed",
		},
	},
});
assert.deepEqual(sandboxedResult.metadata.session, {
	id: "contract-session",
	requested: true,
	disposition: "resumed",
});
assert.equal(sandboxedResult.metadata.parentSessionId, "parent-contracts");
assert.equal(sandboxedResult.metadata.sessionId, "contract-session");
assert.equal(sandboxedResult.metadata.contextOverflowRecovered, true);
assert.deepEqual(sandboxedResult.metadata.recoveredStreamErrors, [
	"context_length_exceeded: compacted",
]);
assert.deepEqual(sandboxedResult.sandbox, {
	enabled: true,
	allowedDomains: ["api.anthropic.com"],
});

const invalid = validateResolveInput({ mode: "fanout" });
assert.equal(invalid.ok, false);
assert.equal(invalid.failure.failureKind, "validation");
assert.match(invalid.failure.error, /unsupported mode/);

const chain = validateResolveInput({ chain: [{ task: "summarize findings" }] });
assert.equal(chain.ok, false);
assert.equal(chain.failure.failureKind, "validation");
assert.match(chain.failure.error, /chain mode is not supported/);

const result = createResultEnvelope({
	runId: "run_contracts_001",
	attemptId: "attempt-contracts-001",
	backend: "headless",
	status: "failed",
	failureKind: "validation",
	cwd: process.cwd(),
	startedAt: "2026-06-07T00:00:00.000Z",
	completedAt: "2026-06-07T00:00:00.010Z",
	artifacts: [
		{
			type: "result",
			path: ".pi/agent/runs/run_contracts_001/attempts/attempt-contracts-001/result.json",
		},
	],
	metadata: { contextLengthExceeded: false },
});
const snapshot = createRunStatusSnapshot(result);
assert.equal(snapshot.runId, result.runId);
assert.equal(snapshot.attemptId, "attempt-contracts-001");
assert.equal(
	snapshot.resultPath,
	".pi/agent/runs/run_contracts_001/attempts/attempt-contracts-001/result.json",
);
assert.equal(isTerminalStatus("failed"), true);
assert.equal(statusSucceeded("completed"), true);
assert.equal(statusFailedClosed("failed", "validation"), true);

console.log(
	JSON.stringify(
		{
			name: "check-contracts",
			status: "completed",
			plannedKeys: Object.keys(plannedInput).length,
			statusHelpers: 4,
		},
		null,
		2,
	),
);
