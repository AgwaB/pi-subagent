import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";

const indexDir = await mkdtemp(join(tmpdir(), "pi-subagent-prune-index-"));
process.env.PI_SUBAGENT_RUN_INDEX_DIR = indexDir;

const { beginRunRecord, upsertRunAttempt } = await import("../../src/artifacts/registry.ts");
const { readRunLocator, writeRunLocator } = await import("../../src/orchestrate/run-ref.ts");
const { formatPruneSubagentRunsSummary, pruneSubagentRuns } = await import("../../src/orchestrate/prune.ts");
const { pruneSubagentRuns: apiPrune } = await import("../../api.mjs");

const cwd = await mkdtemp(join(tmpdir(), "pi-subagent-prune-cwd-"));
const otherCwd = await mkdtemp(join(tmpdir(), "pi-subagent-prune-other-"));
const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-09-02T00:00:00.000Z");

async function seedRun(runId, { status, ageDays, activeAttempt = false, bytes = 100, locatorCwd = cwd }) {
	const startedAt = new Date(now - ageDays * DAY - 60_000);
	const completedAt = new Date(now - ageDays * DAY);
	await beginRunRecord({ cwd, runId, mode: "single", backend: "headless", startedAt, attempts: [] });
	await upsertRunAttempt({
		cwd,
		runId,
		attemptId: "attempt-1",
		status: activeAttempt ? "running" : status,
		backend: "headless",
		failureKind: status === "failed" ? "model" : null,
		startedAt,
		completedAt: activeAttempt ? null : completedAt,
		activate: true,
		onlyIfActive: false,
	});
	const attemptDir = join(cwd, ".pi/agent/runs", runId, "attempts", "attempt-1");
	await mkdir(attemptDir, { recursive: true });
	await writeFile(join(attemptDir, "output.log"), "x".repeat(bytes));
	await writeRunLocator({ runId, cwd: locatorCwd });
}

try {
	// Terminal runs from newest to oldest: t0 (1d) … t5 (60d); one active; one unreadable.
	const ages = [1, 5, 10, 20, 40, 60];
	for (const [index, ageDays] of ages.entries())
		await seedRun(`run_t${index}`, { status: index % 2 === 0 ? "completed" : "failed", ageDays, bytes: 100 * (index + 1) });
	await seedRun("run_active", { status: "running", ageDays: 90, activeAttempt: true });
	await mkdir(join(cwd, ".pi/agent/runs", "run_unreadable"), { recursive: true });
	await writeFile(join(cwd, ".pi/agent/runs", "run_unreadable", "run.json"), "{not json");
	await seedRun("run_foreign_locator", { status: "completed", ageDays: 70, locatorCwd: otherCwd });

	// 1. Dry run with keep=2 selects the five oldest terminal runs and deletes nothing.
	const dry = await pruneSubagentRuns({ cwd, keep: 2, now });
	assert.equal(dry.status, "dry-run");
	assert.equal(dry.scanned, 9);
	assert.equal(dry.terminal, 7);
	assert.deepEqual(dry.selected.map((run) => run.runId), ["run_t2", "run_t3", "run_t4", "run_t5", "run_foreign_locator"]);
	assert.deepEqual(dry.skippedActive, ["run_active"]);
	assert.deepEqual(dry.skippedUnreadable, ["run_unreadable"]);
	assert.deepEqual(dry.deletedRunIds, []);
	assert.equal(dry.selected[0].bytes >= 300, true, "bytes are measured for selected runs");
	assert.equal((await readdir(join(cwd, ".pi/agent/runs"))).length, 9, "dry run deletes nothing");
	const text = formatPruneSubagentRunsSummary(dry);
	assert.match(text, /dry run/u);
	assert.match(text, /Re-run with yes: true/u);

	// 2. olderThanDays narrows the selection within the beyond-keep set.
	const aged = await pruneSubagentRuns({ cwd, keep: 2, olderThanDays: 30, now });
	assert.deepEqual(aged.selected.map((run) => run.runId), ["run_t4", "run_t5", "run_foreign_locator"]);

	// 3. Validation.
	await assert.rejects(pruneSubagentRuns({ cwd, keep: -1 }), /keep must be a non-negative integer/u);
	await assert.rejects(pruneSubagentRuns({ cwd, keep: 1.5 }), /keep must be a non-negative integer/u);
	await assert.rejects(pruneSubagentRuns({ cwd, olderThanDays: -1 }), /olderThanDays must be a non-negative number/u);
	await assert.rejects(pruneSubagentRuns({ cwd, runsDir: "../outside" }), /runsDir must be inside cwd/u);

	// 4. Deletion removes the run directories and only locators owned by this cwd/runsDir.
	const pruned = await pruneSubagentRuns({ cwd, keep: 2, olderThanDays: 30, yes: true, now });
	assert.equal(pruned.status, "pruned");
	assert.deepEqual(pruned.deletedRunIds, ["run_t4", "run_t5", "run_foreign_locator"]);
	assert.equal(pruned.deletedBytes, pruned.selected.reduce((sum, run) => sum + run.bytes, 0));
	assert.ok(pruned.deletedBytes >= 500 + 600 + 100, "deleted bytes cover the seeded outputs");
	assert.deepEqual(pruned.deleteErrors, []);
	for (const runId of pruned.deletedRunIds)
		await assert.rejects(stat(join(cwd, ".pi/agent/runs", runId)), /ENOENT/u);
	assert.equal(await readRunLocator("run_t4"), null, "owned locator removed");
	assert.notEqual(await readRunLocator("run_foreign_locator"), null, "locator owned by another cwd is left alone");
	assert.notEqual(await readRunLocator("run_t0"), null, "kept run keeps its locator");
	await stat(join(cwd, ".pi/agent/runs", "run_active"));
	await stat(join(cwd, ".pi/agent/runs", "run_unreadable"));
	assert.match(formatPruneSubagentRunsSummary(pruned), /Deleted: 3 run\(s\), \d+ bytes/u);

	// 5. The tool action defaults to a dry run, resolves cwd, and validates its knobs.
	const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
	const mod = await jiti.import(resolve("src/index.ts"));
	let registeredTool;
	(mod.default ?? mod)({ registerCommand() {}, registerTool(tool) { registeredTool = tool; } });
	const toolDry = await registeredTool.execute(
		"prune-dry",
		{ action: "prune", keep: 0 },
		new AbortController().signal,
		() => undefined,
		{ cwd },
	);
	assert.equal(toolDry.isError, false);
	assert.equal(toolDry.details.summary.status, "dry-run");
	assert.deepEqual(toolDry.details.summary.selected.map((run) => run.runId).sort(), ["run_t0", "run_t1", "run_t2", "run_t3"]);
	assert.equal((await readdir(join(cwd, ".pi/agent/runs"))).length, 6, "tool dry run deletes nothing");
	const toolInvalid = await registeredTool.execute(
		"prune-invalid",
		{ action: "prune", keep: -1 },
		new AbortController().signal,
		() => undefined,
		{ cwd },
	);
	assert.equal(toolInvalid.isError, true);
	assert.match(toolInvalid.content[0].text, /keep must be a non-negative integer/u);
	const toolYes = await registeredTool.execute(
		"prune-yes",
		{ action: "prune", keep: 0, yes: true, cwd: "." },
		new AbortController().signal,
		() => undefined,
		{ cwd },
	);
	assert.equal(toolYes.isError, false);
	assert.equal(toolYes.details.summary.status, "pruned");
	assert.deepEqual(toolYes.details.summary.deletedRunIds.sort(), ["run_t0", "run_t1", "run_t2", "run_t3"]);
	assert.equal((await readdir(join(cwd, ".pi/agent/runs"))).sort().join(","), "run_active,run_unreadable");

	// 6. Slash-command argument parsing and the registered /subagent prune handler.
	assert.deepEqual(mod.parsePruneCommandArgs(""), {});
	assert.deepEqual(mod.parsePruneCommandArgs(" --yes --keep 5 --older-than=7.5 "), { yes: true, keep: 5, olderThanDays: 7.5 });
	assert.throws(() => mod.parsePruneCommandArgs("--keep"), /--keep requires a non-negative number/u);
	assert.throws(() => mod.parsePruneCommandArgs("--keep 1.5"), /--keep requires a non-negative integer/u);
	assert.throws(() => mod.parsePruneCommandArgs("--older-than -1"), /--older-than requires a non-negative number/u);
	assert.throws(() => mod.parsePruneCommandArgs("--force"), /unknown prune option --force/u);
	let registeredCommand;
	const notices = [];
	(mod.default ?? mod)({ registerCommand(name, command) { registeredCommand = command; }, registerTool() {} });
	await seedRun("run_cmd_old", { status: "completed", ageDays: 10 });
	await registeredCommand.handler("prune --keep 0", { cwd, ui: { notify: (message, level) => notices.push({ message, level }) } });
	assert.equal(notices.at(-1).level, "info");
	assert.match(notices.at(-1).message, /dry run/u);
	await stat(join(cwd, ".pi/agent/runs", "run_cmd_old"));
	await registeredCommand.handler("prune --keep 0 --yes", { cwd, ui: { notify: (message, level) => notices.push({ message, level }) } });
	assert.match(notices.at(-1).message, /Deleted: 1 run\(s\)/u);
	await assert.rejects(stat(join(cwd, ".pi/agent/runs", "run_cmd_old")), /ENOENT/u);
	await registeredCommand.handler("prune --bogus", { cwd, ui: { notify: (message, level) => notices.push({ message, level }) } });
	assert.equal(notices.at(-1).level, "error");
	await registeredCommand.handler("nonsense", { cwd, ui: { notify: (message, level) => notices.push({ message, level }) } });
	assert.equal(notices.at(-1).level, "warning");
	assert.match(notices.at(-1).message, /Usage: \/subagent panel \| \/subagent prune/u);

	// 7. Default keep is 50 and the api.mjs export is the same function.
	const viaApi = await apiPrune({ cwd });
	assert.equal(viaApi.keep, 50);
	assert.equal(viaApi.status, "dry-run");
	assert.deepEqual(viaApi.selected, []);
} finally {
	await rm(indexDir, { recursive: true, force: true });
	await rm(cwd, { recursive: true, force: true });
	await rm(otherCwd, { recursive: true, force: true });
}
console.log("prune checks passed");
