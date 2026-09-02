import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";

const indexDir = await mkdtemp(join(tmpdir(), "pi-subagent-prune-index-"));
process.env.PI_SUBAGENT_RUN_INDEX_DIR = indexDir;

const { beginRunRecord, readRunRecord, upsertRunAttempt } = await import("../../src/artifacts/registry.ts");
const { readRunLocator, writeRunLocator } = await import("../../src/orchestrate/run-ref.ts");
const { formatPruneSubagentRunsSummary, pruneSubagentRuns } = await import("../../src/orchestrate/prune.ts");
const { pruneSubagentRuns: apiPrune } = await import("../../api.mjs");

const cwd = await mkdtemp(join(tmpdir(), "pi-subagent-prune-cwd-"));
// Run directories only: the hidden `.locks` directory is registry state.
const listRuns = async (dir) => (await readdir(dir)).filter((name) => !name.startsWith("."));
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
	// Age the record: ordering and olderThanDays use the record's updatedAt.
	const recordPath = join(cwd, ".pi/agent/runs", runId, "run.json");
	const record = JSON.parse(await readFile(recordPath, "utf8"));
	record.updatedAt = completedAt.toISOString();
	await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
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
	assert.equal((await listRuns(join(cwd, ".pi/agent/runs"))).length, 9, "dry run deletes nothing");
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
	assert.equal((await listRuns(join(cwd, ".pi/agent/runs"))).length, 6, "tool dry run deletes nothing");
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
	assert.equal((await listRuns(join(cwd, ".pi/agent/runs"))).sort().join(","), "run_active,run_unreadable");

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

	// 7. Symlinked runs roots are refused; symlinked run entries are skipped.
	const outside = await mkdtemp(join(tmpdir(), "pi-subagent-prune-outside-"));
	await mkdir(join(outside, "run_victim", "attempts"), { recursive: true });
	await writeFile(
		join(outside, "run_victim", "run.json"),
		JSON.stringify({ schemaVersion: 2, runId: "run_victim", mode: "single", backend: "headless", status: "completed", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:00.000Z", activeAttemptId: null, attempts: [] }),
	);
	const linkedCwd = await mkdtemp(join(tmpdir(), "pi-subagent-prune-linked-"));
	await mkdir(join(linkedCwd, ".pi", "agent"), { recursive: true });
	await symlink(outside, join(linkedCwd, ".pi", "agent", "runs"));
	await assert.rejects(
		pruneSubagentRuns({ cwd: linkedCwd, keep: 0, yes: true }),
		/refusing to prune through a symlink/u,
		"a symlinked runs root must not be followed",
	);
	await stat(join(outside, "run_victim", "run.json"));
	const linkedEntryCwd = await mkdtemp(join(tmpdir(), "pi-subagent-prune-linked-entry-"));
	await mkdir(join(linkedEntryCwd, ".pi", "agent", "runs"), { recursive: true });
	await symlink(join(outside, "run_victim"), join(linkedEntryCwd, ".pi", "agent", "runs", "run_link"));
	const linkedEntry = await pruneSubagentRuns({ cwd: linkedEntryCwd, keep: 0, yes: true });
	assert.equal(linkedEntry.scanned, 0, "symlinked run entries are not scanned");
	await stat(join(outside, "run_victim", "run.json"));
	assert.equal((await pruneSubagentRuns({ cwd: await mkdtemp(join(tmpdir(), "pi-subagent-prune-none-")), yes: true })).scanned, 0, "missing runs dir is a no-op");

	// 8. Malformed records are skipped as unreadable, never thrown or deleted.
	await mkdir(join(cwd, ".pi/agent/runs", "run_bad_shape"), { recursive: true });
	await writeFile(join(cwd, ".pi/agent/runs", "run_bad_shape", "run.json"), JSON.stringify({ schemaVersion: 2, runId: "run_bad_shape", status: "completed" }));
	const malformed = await pruneSubagentRuns({ cwd, keep: 0, yes: true, now });
	assert.ok(malformed.skippedUnreadable.includes("run_bad_shape"));
	await stat(join(cwd, ".pi/agent/runs", "run_bad_shape", "run.json"));

	// 8b. Terminal-looking records with malformed attempts, unknown statuses, a
	// dangling activeAttemptId, or an id that does not match the directory are
	// unreadable too, never deleted.
	const malformedShapes = {
		run_bad_attempt: { schemaVersion: 2, runId: "run_bad_attempt", status: "completed", attempts: [{ status: "completed" }], activeAttemptId: null },
		run_bad_status: { schemaVersion: 2, runId: "run_bad_status", status: "done", attempts: [], activeAttemptId: null },
		run_bad_active: { schemaVersion: 2, runId: "run_bad_active", status: "completed", attempts: [{ attemptId: "a1", status: "completed" }], activeAttemptId: "ghost" },
		run_bad_id: { schemaVersion: 2, runId: "run_other", status: "completed", attempts: [], activeAttemptId: null },
	};
	for (const [runId, record] of Object.entries(malformedShapes)) {
		await mkdir(join(cwd, ".pi/agent/runs", runId), { recursive: true });
		await writeFile(join(cwd, ".pi/agent/runs", runId, "run.json"), JSON.stringify({ mode: "single", backend: "headless", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:00.000Z", ...record }));
	}
	const malformedAll = await pruneSubagentRuns({ cwd, keep: 0, yes: true, now });
	for (const runId of Object.keys(malformedShapes)) {
		assert.ok(malformedAll.skippedUnreadable.includes(runId), `${runId} is unreadable: ${JSON.stringify(malformedAll)}`);
		await stat(join(cwd, ".pi/agent/runs", runId, "run.json"));
		await rm(join(cwd, ".pi/agent/runs", runId), { recursive: true, force: true });
	}

	// 9. Ordering and olderThanDays use the record's updatedAt, not completedAt.
	await seedRun("run_touched", { status: "completed", ageDays: 90 });
	{
		const recordPath = join(cwd, ".pi/agent/runs", "run_touched", "run.json");
		const record = JSON.parse(await readFile(recordPath, "utf8"));
		record.updatedAt = new Date(now - 1 * DAY).toISOString(); // touched recently (e.g. mark-background)
		await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
	}
	const touched = await pruneSubagentRuns({ cwd, keep: 0, olderThanDays: 30, now });
	assert.equal(touched.selected.some((run) => run.runId === "run_touched"), false, "recently updated run is not older than 30 days");
	await seedRun("run_stale_completed", { status: "completed", ageDays: 90 });
	const staleSel = await pruneSubagentRuns({ cwd, keep: 0, olderThanDays: 30, now });
	assert.deepEqual(staleSel.selected.map((run) => run.runId), ["run_stale_completed"]);

	// 10. A mutation that interleaves after validation can never be partially
	// deleted: deletion happens under the run lock and renames the directory
	// first, so a late mutation either fails (lock path gone) or starts a fresh
	// record in a new directory; the old attempt data is gone either way.
	const { removeRunIfStill } = await import("../../src/artifacts/registry.ts");
	let lateMutation;
	const outcome = await removeRunIfStill({ cwd, runId: "run_stale_completed" }, (record) => {
		// Interleave: a retry tries to reactivate the run while we hold the lock.
		lateMutation = upsertRunAttempt({
			cwd,
			runId: "run_stale_completed",
			attemptId: "attempt-2",
			status: "running",
			backend: "headless",
			failureKind: null,
			startedAt: new Date(),
			completedAt: null,
			activate: true,
			onlyIfActive: false,
		}).then(
			() => ({ ok: true }),
			(error) => ({ ok: false, error }),
		);
		return record.status === "completed";
	});
	assert.equal(outcome, "removed");
	const lateOutcome = await lateMutation;
	if (lateOutcome.ok) {
		// Timing-dependent (seen on Linux): the late mutation recreated the run
		// directory. It must be a fresh record that carries none of the pruned data.
		const recreated = await readRunRecord({ cwd, runId: "run_stale_completed" });
		assert.deepEqual(recreated?.attempts.map((attempt) => attempt.attemptId), ["attempt-2"], "recreated record holds only the late attempt");
		await assert.rejects(stat(join(cwd, ".pi/agent/runs", "run_stale_completed", "attempts", "attempt-1")), /ENOENT/u, "pruned attempt data is gone");
		await rm(join(cwd, ".pi/agent/runs", "run_stale_completed"), { recursive: true, force: true });
	} else {
		await assert.rejects(stat(join(cwd, ".pi/agent/runs", "run_stale_completed")), /ENOENT/u);
	}
	assert.equal((await readdir(join(cwd, ".pi/agent/runs", ".locks"))).some((name) => name.includes(".pruning-")), false, "no tombstone is left behind");
	await rm(outside, { recursive: true, force: true });
	await rm(linkedCwd, { recursive: true, force: true });
	await rm(linkedEntryCwd, { recursive: true, force: true });

	// 10b. Every registry writer that targets an existing run serializes with
	// the deletion and never recreates a directory for a pruned run: a late
	// event append fails, and late commit/refresh/terminal-event writers report
	// "not current" without leaving a ghost directory behind.
	{
		const {
			appendRunEvent,
			appendTerminalEventsIfCurrent,
			commitAttemptResultIfActive,
			refreshTerminalAttemptResultIfCurrent,
		} = await import("../../src/artifacts/registry.ts");
		const { createAttemptArtifactStore } = await import("../../src/artifacts/store.ts");
		await seedRun("run_late_writers", { status: "completed", ageDays: 90 });
		const lateStore = await createAttemptArtifactStore({ cwd, runId: "run_late_writers", attemptId: "attempt-1" });
		const lateResult = await lateStore.writeResult({
			backend: "headless",
			status: "completed",
			failureKind: null,
			cwd,
			startedAt: new Date(now - 90 * DAY),
			completedAt: new Date(now - 90 * DAY),
			workspace: { mode: "shared", cwd },
			sandbox: { enabled: false },
			exitCode: 0,
			signal: null,
			artifacts: [],
			metadata: { contextLengthExceeded: false },
		});
		const lateRef = { cwd, runId: "run_late_writers" };
		const lateWriters = [];
		const removed = await removeRunIfStill(lateRef, (record) => {
			// The locked writers start while the lock is held; they must wait.
			lateWriters.push(
				commitAttemptResultIfActive(lateRef, lateResult).then((value) => `commit:${value.committed}`),
				refreshTerminalAttemptResultIfCurrent(lateRef, lateResult).then((value) => `refresh:${value.refreshed}`),
				appendTerminalEventsIfCurrent(lateRef, { attemptId: "attempt-1", status: "completed", attemptMessage: "late", runMessage: "late" }).then((value) => `terminal:${value.current}`),
			);
			return record.status === "completed";
		});
		assert.equal(removed, "removed");
		const lateOutcomes = await Promise.all(lateWriters);
		assert.deepEqual(lateOutcomes, ["commit:false", "refresh:false", "terminal:false"]);
		// An unlocked event append after removal fails instead of creating a directory.
		await assert.rejects(
			appendRunEvent(lateRef, { type: "run.mark_background", status: "completed", message: "late" }),
			/ENOENT/u,
			"late event append must fail",
		);
		await assert.rejects(stat(join(cwd, ".pi/agent/runs", "run_late_writers")), /ENOENT/u, "no ghost directory is recreated by late writers");
	}

	// 11. Default keep is 50 and the api.mjs export is the same function.
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
