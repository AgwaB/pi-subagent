import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const indexDir = await mkdtemp(join(tmpdir(), "pi-subagent-locator-sweep-"));
process.env.PI_SUBAGENT_RUN_INDEX_DIR = indexDir;

const {
	awaitRunLocatorSweepForTests,
	pruneStaleRunLocators,
	resetRunLocatorSweepForTests,
	writeRunLocator,
} = await import("../../src/orchestrate/run-ref.ts");

const cwd = await mkdtemp(join(tmpdir(), "pi-subagent-locator-cwd-"));
const DAY = 24 * 60 * 60 * 1000;

async function seedLocator(runId, ageDays) {
	const path = join(indexDir, `${runId}.json`);
	await writeFile(
		path,
		`${JSON.stringify({ schemaVersion: 1, runId, cwd, updatedAt: new Date(Date.now() - ageDays * DAY).toISOString() }, null, 2)}\n`,
	);
	const when = new Date(Date.now() - ageDays * DAY);
	await utimes(path, when, when);
}

try {
	// 1. Bounded explicit sweep removes only entries older than the threshold.
	for (let i = 0; i < 6; i += 1) await seedLocator(`run_stale_${i}`, 45);
	for (let i = 0; i < 3; i += 1) await seedLocator(`run_fresh_${i}`, 2);
	await writeFile(join(indexDir, "not-a-locator.txt"), "ignore\n");
	assert.equal(await pruneStaleRunLocators({ maxDeletes: 4 }), 4, "sweep honors maxDeletes");
	assert.equal(await pruneStaleRunLocators(), 2, "second sweep finishes the stale set");
	const remaining = (await readdir(indexDir)).sort();
	assert.deepEqual(remaining, ["not-a-locator.txt", "run_fresh_0.json", "run_fresh_1.json", "run_fresh_2.json"]);

	// 2. Writing a locator schedules one background sweep per process.
	for (let i = 0; i < 3; i += 1) await seedLocator(`run_old_${i}`, 60);
	resetRunLocatorSweepForTests();
	const started = process.hrtime.bigint();
	await writeRunLocator({ runId: "run_new_locator", cwd });
	const writeMs = Number(process.hrtime.bigint() - started) / 1e6;
	assert.ok(writeMs < 250, `locator write must not wait for the sweep (${writeMs.toFixed(1)} ms)`);
	assert.equal(await awaitRunLocatorSweepForTests(), 3, "background sweep pruned the stale entries");
	await stat(join(indexDir, "run_new_locator.json"));
	for (let i = 0; i < 3; i += 1) await seedLocator(`run_old_again_${i}`, 60);
	await writeRunLocator({ runId: "run_second_locator", cwd });
	assert.equal(await awaitRunLocatorSweepForTests(), 3, "a later write in the same process does not sweep again");
	assert.equal((await readdir(indexDir)).filter((name) => name.startsWith("run_old_again_")).length, 3);

	// 3. Threshold override: PI_SUBAGENT_RUN_LOCATOR_PRUNE_AFTER_MS=-1 disables pruning.
	process.env.PI_SUBAGENT_RUN_LOCATOR_PRUNE_AFTER_MS = "-1";
	assert.equal(await pruneStaleRunLocators(), 0, "negative threshold disables the sweep");
	delete process.env.PI_SUBAGENT_RUN_LOCATOR_PRUNE_AFTER_MS;
} finally {
	await rm(indexDir, { recursive: true, force: true });
	await rm(cwd, { recursive: true, force: true });
}
console.log("run locator sweep checks passed");
