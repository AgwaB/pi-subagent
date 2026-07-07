#!/usr/bin/env node
import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildPiArgv,
	runHeadlessModel,
	toolResultBudgetExtensionPath,
} from "../../src/runners/headless-model.ts";
import {
	evictionPlaceholder,
	normalizeToolResultBudget,
	readToolResultBudgetEnv,
	TOOL_RESULT_BUDGET_ENV,
	ToolResultBudgetEnforcer,
} from "../../src/runners/tool-result-budget.ts";
import toolResultBudgetExtension from "../../src/runners/tool-result-budget-extension.ts";
import { validateResolveInput } from "../../src/core/validation.ts";

const EVICTION_MARKER = "[evicted tool result:";

function toolResult(toolCallId, toolName, chars) {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "x".repeat(chars) }],
		isError: false,
		timestamp: 1,
	};
}

function transcript(...toolResults) {
	return structuredClone([
		{ role: "user", content: "task" },
		{ role: "assistant", content: [{ type: "text", text: "working" }] },
		...toolResults,
	]);
}

function textOf(message) {
	return message.content.map((part) => part.text ?? "").join("");
}

// --- option normalization: valid accepted, invalid ignored with warning ---
assert.deepEqual(normalizeToolResultBudget(undefined), {});
assert.deepEqual(normalizeToolResultBudget({ maxTotalChars: 2048.9 }), {
	budget: { maxTotalChars: 2048 },
});
for (const invalid of [
	null,
	true,
	42,
	"2048",
	[],
	{},
	{ maxTotalChars: 0 },
	{ maxTotalChars: -5 },
	{ maxTotalChars: Number.NaN },
	{ maxTotalChars: Number.POSITIVE_INFINITY },
	{ maxTotalChars: "2048" },
]) {
	const normalized = normalizeToolResultBudget(invalid);
	assert.equal(normalized.budget, undefined);
	assert.match(normalized.warning, /toolResultBudget ignored/);
}

// --- env parsing for the child extension ---
assert.equal(readToolResultBudgetEnv({}), undefined);
assert.equal(
	readToolResultBudgetEnv({
		[TOOL_RESULT_BUDGET_ENV.maxTotalChars]: "not-a-number",
	}),
	undefined,
);
assert.deepEqual(
	readToolResultBudgetEnv({
		[TOOL_RESULT_BUDGET_ENV.maxTotalChars]: "2000",
		[TOOL_RESULT_BUDGET_ENV.statePath]: "/tmp/state.json",
		[TOOL_RESULT_BUDGET_ENV.forceEvictFraction]: "0.25",
	}),
	{ maxTotalChars: 2000, statePath: "/tmp/state.json", forceEvictFraction: 0.25 },
);

// --- validation passthrough (never fails, top-level and task-level) ---
const validBudgetInput = validateResolveInput({
	agent: "worker",
	task: "inspect",
	toolResultBudget: { maxTotalChars: 4096 },
});
assert.equal(validBudgetInput.ok, true);
assert.deepEqual(validBudgetInput.input.toolResultBudget, {
	maxTotalChars: 4096,
});
const invalidBudgetInput = validateResolveInput({
	agent: "worker",
	task: "inspect",
	toolResultBudget: { maxTotalChars: "junk" },
});
assert.equal(invalidBudgetInput.ok, true, "invalid budget must not fail validation");
const taskBudgetInput = validateResolveInput({
	tasks: [{ agent: "worker", task: "inspect", toolResultBudget: { maxTotalChars: 512 } }],
});
assert.equal(taskBudgetInput.ok, true);
assert.deepEqual(taskBudgetInput.input.tasks[0].toolResultBudget, {
	maxTotalChars: 512,
});

// --- enforcer: budget off means untouched (baseline sanity) ---
{
	const messages = transcript(
		toolResult("t1", "fetch_content", 1000),
		toolResult("t2", "read", 1000),
	);
	const huge = new ToolResultBudgetEnforcer({ maxTotalChars: 1_000_000 });
	const state = huge.enforce(messages);
	assert.equal(state.evictedCount, 0);
	assert.equal(JSON.stringify(messages).includes(EVICTION_MARKER), false);
}

// --- enforcer: oldest evicted first, newest kept, telemetry recorded ---
{
	const enforcer = new ToolResultBudgetEnforcer({ maxTotalChars: 2000 });
	const first = transcript(
		toolResult("t1", "fetch_content", 1000),
		toolResult("t2", "read", 1000),
	);
	let state = enforcer.enforce(first);
	assert.equal(state.evictedCount, 0, "within budget: nothing evicted");
	assert.equal(state.retainedChars, 2000);

	// Appending t3 pushes cumulative chars over budget: evict oldest (t1) only.
	const second = transcript(
		toolResult("t1", "fetch_content", 1000),
		toolResult("t2", "read", 1000),
		toolResult("t3", "web_search", 600),
	);
	state = enforcer.enforce(second);
	assert.equal(
		textOf(second[2]),
		evictionPlaceholder("fetch_content", 1000),
		"oldest tool result replaced with placeholder",
	);
	assert.equal(second[2].role, "toolResult", "role preserved");
	assert.equal(second[2].toolCallId, "t1", "toolCallId preserved");
	assert.equal(textOf(second[3]), "x".repeat(1000), "middle result intact");
	assert.equal(textOf(second[4]), "x".repeat(600), "newest result intact");
	assert.equal(state.evictedCount, 1);
	assert.equal(state.evictedChars, 1000);
	assert.equal(state.retainedChars, 1600);
	assert.equal(state.toolResults, 3);
	assert.equal(state.evictableCount, 1);

	// Sticky across calls on a fresh clone; no double counting.
	const third = transcript(
		toolResult("t1", "fetch_content", 1000),
		toolResult("t2", "read", 1000),
		toolResult("t3", "web_search", 600),
	);
	state = enforcer.enforce(third);
	assert.equal(textOf(third[2]), evictionPlaceholder("fetch_content", 1000));
	assert.equal(state.evictedCount, 1);
	assert.equal(state.evictedChars, 1000);
}

// --- enforcer: the newest result is never evicted, even alone over budget ---
{
	const enforcer = new ToolResultBudgetEnforcer({ maxTotalChars: 100 });
	const solo = transcript(toolResult("big", "fetch_content", 5000));
	const state = enforcer.enforce(solo);
	assert.equal(state.evictedCount, 0);
	assert.equal(textOf(solo[2]), "x".repeat(5000));

	const pair = transcript(
		toolResult("big", "fetch_content", 5000),
		toolResult("bigger", "read", 9000),
	);
	const pairState = enforcer.enforce(pair);
	assert.equal(textOf(pair[2]), evictionPlaceholder("fetch_content", 5000));
	assert.equal(textOf(pair[3]), "x".repeat(9000), "newest kept although over budget");
	assert.equal(pairState.evictedCount, 1);
	assert.equal(pairState.evictableCount, 0);
}

// --- enforcer: forced eviction (~25% of retained chars) for recovery ---
{
	const enforcer = new ToolResultBudgetEnforcer({
		maxTotalChars: 1_000_000,
		forceEvictFraction: 0.25,
	});
	const messages = transcript(
		toolResult("t1", "fetch_content", 1000),
		toolResult("t2", "read", 1000),
		toolResult("t3", "web_search", 1000),
		toolResult("t4", "read", 1000),
	);
	const state = enforcer.enforce(messages);
	assert.equal(state.evictedCount, 1, "4000 chars * 25% => evict oldest 1000");
	assert.equal(state.forcedEvictionApplied, true);
	assert.equal(textOf(messages[2]), evictionPlaceholder("fetch_content", 1000));
	// One-shot: a later call must not force-evict again.
	const again = transcript(
		toolResult("t1", "fetch_content", 1000),
		toolResult("t2", "read", 1000),
		toolResult("t3", "web_search", 1000),
		toolResult("t4", "read", 1000),
	);
	const againState = enforcer.enforce(again);
	assert.equal(againState.evictedCount, 1);
}

const tempRoot = await mkdtemp(join(tmpdir(), "pi-subagent-tool-result-budget-"));
try {
	// --- real extension module end to end (env config + state file) ---
	{
		const statePath = join(tempRoot, "extension-state.json");
		process.env[TOOL_RESULT_BUDGET_ENV.maxTotalChars] = "2000";
		process.env[TOOL_RESULT_BUDGET_ENV.statePath] = statePath;
		try {
			let contextHandler;
			toolResultBudgetExtension({
				on(event, handler) {
					if (event === "context") contextHandler = handler;
				},
			});
			assert.ok(contextHandler, "extension registers a context handler");
			const messages = transcript(
				toolResult("t1", "fetch_content", 1500),
				toolResult("t2", "read", 1500),
			);
			const result = contextHandler({ type: "context", messages });
			assert.equal(result.messages, messages);
			assert.equal(textOf(messages[2]), evictionPlaceholder("fetch_content", 1500));
			assert.equal(textOf(messages[3]), "x".repeat(1500));
			const state = JSON.parse(await readFile(statePath, "utf8"));
			assert.equal(state.evictedCount, 1);
			assert.equal(state.evictedChars, 1500);
			assert.equal(state.retainedChars, 1500);
			assert.equal(state.evictableCount, 0);
		} finally {
			delete process.env[TOOL_RESULT_BUDGET_ENV.maxTotalChars];
			delete process.env[TOOL_RESULT_BUDGET_ENV.statePath];
			delete process.env[TOOL_RESULT_BUDGET_ENV.forceEvictFraction];
		}
	}

	// --- argv wiring: budget adds the extension, off/invalid stays identical ---
	const baseArgvOptions = { agent: "argv-worker", task: "inspect argv" };
	const plainArgv = buildPiArgv(baseArgvOptions);
	assert.deepEqual(
		buildPiArgv({ ...baseArgvOptions, toolResultBudget: { maxTotalChars: -1 } }),
		plainArgv,
		"invalid budget must leave argv byte-identical",
	);
	const budgetArgv = buildPiArgv({
		...baseArgvOptions,
		toolResultBudget: { maxTotalChars: 2000 },
	});
	const extensionPath = toolResultBudgetExtensionPath();
	assert.ok(budgetArgv.includes("--extension"));
	assert.ok(budgetArgv.includes(extensionPath));
	await access(extensionPath);
	assert.equal(plainArgv.includes("--extension"), false);
	assert.equal(plainArgv.includes(extensionPath), false);

	const cwd = join(tempRoot, "workspace");
	await mkdir(cwd, { recursive: true });

	// --- (a) budget off: default behavior untouched, no placeholder anywhere ---
	const plainPi = join(tempRoot, "fake-pi-plain.mjs");
	const envLeakMarker = join(tempRoot, "env-leak-marker");
	await writeFile(
		plainPi,
		`#!/usr/bin/env node
import { writeFileSync } from "node:fs";
if (process.env[${JSON.stringify(TOOL_RESULT_BUDGET_ENV.maxTotalChars)}] !== undefined)
  writeFileSync(${JSON.stringify(envLeakMarker)}, "leaked");
process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "fetch_content", args: { url: "https://example.test" } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "fetch_content", result: { content: [{ type: "text", text: "x".repeat(5000) }] }, isError: false }) + "\\n");
process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "plain-run-ok" }], provider: "fake", model: "fake/model", stopReason: "stop" } }) + "\\n");
`,
		"utf8",
	);
	await chmod(plainPi, 0o700);

	const plain = await runHeadlessModel({
		cwd,
		runId: "run_trb_budget_off",
		attemptId: "attempt-budget-off",
		piCommand: plainPi,
		agent: "budget-worker",
		task: "run without a budget",
		timeoutMs: 30_000,
	});
	assert.equal(plain.status, "completed");
	assert.equal(plain.metadata.toolResultBudget, undefined);
	assert.equal(plain.metadata.contextRecovered, undefined);
	assert.equal(
		JSON.stringify(plain).includes(EVICTION_MARKER),
		false,
		"budget off: no eviction placeholder may ever appear",
	);
	const plainResultJson = await readFile(
		join(cwd, plain.artifacts.find((artifact) => artifact.type === "result").path),
		"utf8",
	);
	assert.equal(plainResultJson.includes(EVICTION_MARKER), false);
	await assert.rejects(access(envLeakMarker), "budget env must not be set when budget is off");

	// --- (d) invalid budget value: ignored with recorded warning ---
	const invalidBudget = await runHeadlessModel({
		cwd,
		runId: "run_trb_invalid_budget",
		attemptId: "attempt-invalid-budget",
		piCommand: plainPi,
		agent: "budget-worker",
		task: "run with an invalid budget",
		timeoutMs: 30_000,
		toolResultBudget: { maxTotalChars: -5 },
	});
	assert.equal(invalidBudget.status, "completed");
	assert.equal(invalidBudget.metadata.toolResultBudget.enabled, false);
	assert.match(
		invalidBudget.metadata.toolResultBudget.warning,
		/toolResultBudget ignored/,
	);
	assert.equal(invalidBudget.metadata.contextRecovered, undefined);
	await assert.rejects(access(envLeakMarker), "invalid budget must not enable budget env");

	// --- (c) context-length failure with budget on: one eviction + retry ---
	const recoveryCounter = join(tempRoot, "recovery-counter");
	const recoveryPi = join(tempRoot, "fake-pi-recovery.mjs");
	await writeFile(
		recoveryPi,
		`#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
const counterPath = ${JSON.stringify(recoveryCounter)};
const statePath = process.env[${JSON.stringify(TOOL_RESULT_BUDGET_ENV.statePath)}] ?? "";
const force = process.env[${JSON.stringify(TOOL_RESULT_BUDGET_ENV.forceEvictFraction)}];
const first = !existsSync(counterPath);
writeFileSync(counterPath, first ? "1" : "2");
if (first) {
  if (force !== undefined) {
    process.stdout.write(JSON.stringify({ type: "error", error: { message: "unexpected force-evict on first call" } }) + "\\n");
  } else {
    if (statePath) writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, maxTotalChars: 2000, toolResults: 3, retainedChars: 1900, evictedCount: 1, evictedChars: 1000, evictableCount: 2, forcedEvictionApplied: false }));
    process.stdout.write(JSON.stringify({ type: "error", error: { message: "context_length_exceeded: cannot continue" } }) + "\\n");
  }
} else if (force !== "0.25") {
  process.stdout.write(JSON.stringify({ type: "error", error: { message: "context_length_exceeded: retry missing force-evict env" } }) + "\\n");
} else {
  if (statePath) writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, maxTotalChars: 2000, toolResults: 3, retainedChars: 475, evictedCount: 2, evictedChars: 1700, evictableCount: 1, forcedEvictionApplied: true }));
  process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "recovered-after-eviction" }], provider: "fake", model: "fake/model", stopReason: "stop" } }) + "\\n");
}
`,
		"utf8",
	);
	await chmod(recoveryPi, 0o700);

	const recovered = await runHeadlessModel({
		cwd,
		runId: "run_trb_recovery",
		attemptId: "attempt-recovery",
		piCommand: recoveryPi,
		agent: "budget-worker",
		task: "overflow then recover",
		timeoutMs: 30_000,
		toolResultBudget: { maxTotalChars: 2000 },
	});
	assert.equal(recovered.status, "completed");
	assert.equal(recovered.failureKind, null);
	assert.equal(recovered.metadata.contextRecovered, true);
	assert.equal(recovered.metadata.contextLengthExceeded, false);
	assert.equal(await readFile(recoveryCounter, "utf8"), "2", "exactly one retry");
	assert.deepEqual(recovered.metadata.toolResultBudget, {
		enabled: true,
		maxTotalChars: 2000,
		toolResults: 3,
		retainedChars: 475,
		evictedCount: 2,
		evictedChars: 1700,
		evictableCount: 1,
		forcedEvictionApplied: true,
	});
	const recoveredOutput = await readFile(
		join(cwd, recovered.artifacts.find((artifact) => artifact.type === "output").path),
		"utf8",
	);
	assert.equal(recoveredOutput, "recovered-after-eviction");

	// --- (c) retry also fails: fail as today, single-recovery guard holds ---
	const alwaysFailCounter = join(tempRoot, "always-fail-counter");
	const alwaysFailPi = join(tempRoot, "fake-pi-always-fail.mjs");
	await writeFile(
		alwaysFailPi,
		`#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const counterPath = ${JSON.stringify(alwaysFailCounter)};
const statePath = process.env[${JSON.stringify(TOOL_RESULT_BUDGET_ENV.statePath)}] ?? "";
const previous = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) : 0;
writeFileSync(counterPath, String(previous + 1));
if (statePath) writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, maxTotalChars: 2000, toolResults: 4, retainedChars: 1900, evictedCount: 1, evictedChars: 900, evictableCount: 3, forcedEvictionApplied: false }));
process.stdout.write(JSON.stringify({ type: "error", error: { message: "context_length_exceeded: cannot continue" } }) + "\\n");
`,
		"utf8",
	);
	await chmod(alwaysFailPi, 0o700);

	const stillFailing = await runHeadlessModel({
		cwd,
		runId: "run_trb_still_failing",
		attemptId: "attempt-still-failing",
		piCommand: alwaysFailPi,
		agent: "budget-worker",
		task: "overflow twice",
		timeoutMs: 30_000,
		toolResultBudget: { maxTotalChars: 2000 },
	});
	assert.equal(stillFailing.status, "failed");
	assert.equal(stillFailing.failureKind, "model");
	assert.equal(stillFailing.metadata.contextLengthExceeded, true);
	assert.equal(stillFailing.metadata.contextRecovered, undefined);
	assert.equal(
		await readFile(alwaysFailCounter, "utf8"),
		"2",
		"single-recovery guard: no more than one retry per run",
	);

	// --- (c) nothing evictable: no retry, fail as today ---
	const noEvictableCounter = join(tempRoot, "no-evictable-counter");
	const noEvictablePi = join(tempRoot, "fake-pi-no-evictable.mjs");
	await writeFile(
		noEvictablePi,
		`#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const counterPath = ${JSON.stringify(noEvictableCounter)};
const statePath = process.env[${JSON.stringify(TOOL_RESULT_BUDGET_ENV.statePath)}] ?? "";
const previous = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) : 0;
writeFileSync(counterPath, String(previous + 1));
if (statePath) writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, maxTotalChars: 2000, toolResults: 1, retainedChars: 1900, evictedCount: 0, evictedChars: 0, evictableCount: 0, forcedEvictionApplied: false }));
process.stdout.write(JSON.stringify({ type: "error", error: { message: "context_length_exceeded: cannot continue" } }) + "\\n");
`,
		"utf8",
	);
	await chmod(noEvictablePi, 0o700);

	const noEvictable = await runHeadlessModel({
		cwd,
		runId: "run_trb_no_evictable",
		attemptId: "attempt-no-evictable",
		piCommand: noEvictablePi,
		agent: "budget-worker",
		task: "overflow without evictable results",
		timeoutMs: 30_000,
		toolResultBudget: { maxTotalChars: 2000 },
	});
	assert.equal(noEvictable.status, "failed");
	assert.equal(noEvictable.metadata.contextRecovered, undefined);
	assert.equal(
		await readFile(noEvictableCounter, "utf8"),
		"1",
		"no evictable tool results: never retried",
	);

	console.log(
		JSON.stringify(
			{ name: "check-tool-result-budget", status: "completed" },
			null,
			2,
		),
	);
} finally {
	await rm(tempRoot, { recursive: true, force: true });
}
