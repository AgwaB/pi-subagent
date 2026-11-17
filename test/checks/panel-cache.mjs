#!/usr/bin/env node
// Regression: the live panel caches parsed index locators and finished indexed
// runs between refreshes (re-reading thousands of unchanged files made every
// refresh slow). Every change to the underlying files must still show up,
// active runs must never come from the cache, `r` and the periodic
// revalidation must bypass it, and slow loads must back off the timer.
import assert from "node:assert/strict";
import {
	appendFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	moduleCache: false,
});
const { listRunLocators } = await jiti.import(
	resolve("src/orchestrate/run-ref.ts"),
);
const { SubagentPanel } = await jiti.import(resolve("src/panel.ts"));

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const stripAnsi = (text) => text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");

function locatorJson(runId, cwd, extra = {}) {
	return `${JSON.stringify({ schemaVersion: 1, runId, cwd, updatedAt: new Date().toISOString(), ...extra }, null, 2)}\n`;
}

async function writeIndexedRun(indexDir, cwd, runId, options) {
	const attemptId = "attempt-1";
	const runDir = join(cwd, ".pi/agent/runs", runId);
	const attemptDir = join(runDir, "attempts", attemptId);
	await mkdir(attemptDir, { recursive: true });
	const now = new Date().toISOString();
	const active = options.status === "running";
	const resultRel = `.pi/agent/runs/${runId}/attempts/${attemptId}/result.json`;
	const outputRel = `.pi/agent/runs/${runId}/attempts/${attemptId}/output.log`;
	await writeFile(join(cwd, outputRel), "log\n");
	const result = {
		schemaVersion: 2,
		runId,
		attemptId,
		backend: "headless",
		status: options.status,
		failureKind: null,
		cwd,
		startedAt: now,
		completedAt: active ? null : now,
		durationMs: active ? null : 1000,
		workspace: { mode: "shared", cwd, worktreePath: null },
		sandbox: { enabled: false },
		exitCode: 0,
		signal: null,
		metadata: { model: options.model ?? "model-a" },
		artifacts: [
			{ type: "output", path: outputRel },
			{ type: "result", path: resultRel },
		],
	};
	await writeFile(join(cwd, resultRel), `${JSON.stringify(result, null, 2)}\n`);
	const record = {
		schemaVersion: 2,
		runId,
		parentSessionId: options.parentSessionId,
		mode: "single",
		status: options.status,
		backend: "headless",
		cwd,
		runsDir: ".pi/agent/runs",
		startedAt: now,
		updatedAt: now,
		completedAt: active ? null : now,
		attempts: [
			{
				attemptId,
				status: options.status,
				backend: "headless",
				startedAt: now,
				updatedAt: now,
				...(active ? { heartbeatAt: now } : {}),
				completedAt: active ? null : now,
				artifactCwd: cwd,
				resultPath: resultRel,
				outputPath: outputRel,
				workspace: result.workspace,
			},
		],
	};
	await writeFile(
		join(runDir, "run.json"),
		`${JSON.stringify(record, null, 2)}\n`,
	);
	await writeFile(
		join(indexDir, `${runId}.json`),
		locatorJson(runId, cwd, { parentSessionId: options.parentSessionId }),
	);
	return { runDir, resultPath: join(cwd, resultRel) };
}

const tempRoot = await mkdtemp(join(tmpdir(), "pi-subagent-panel-cache-"));
const oldIndexDir = process.env.PI_SUBAGENT_RUN_INDEX_DIR;
let panel;
try {
	const indexDir = join(tempRoot, "run-index");
	const cwd = join(tempRoot, "workspace");
	await mkdir(indexDir, { recursive: true });
	await mkdir(cwd, { recursive: true });
	process.env.PI_SUBAGENT_RUN_INDEX_DIR = indexDir;

	// ---- locator cache -------------------------------------------------------
	await writeFile(
		join(indexDir, "run_loc_a.json"),
		locatorJson("run_loc_a", join(tempRoot, "a")),
	);
	await writeFile(
		join(indexDir, "run_loc_b.json"),
		locatorJson("run_loc_b", join(tempRoot, "b")),
	);
	const locatorCache = new Map();
	const byId = (listed, runId) =>
		listed.locators.find((l) => l.runId === runId);
	let listed = await listRunLocators({ cache: locatorCache });
	assert.equal(listed.locators.length, 2);
	const firstA = byId(listed, "run_loc_a");
	listed = await listRunLocators({ cache: locatorCache });
	assert.equal(
		byId(listed, "run_loc_a"),
		firstA,
		"unchanged locator should be reused",
	);
	await writeFile(
		join(indexDir, "run_loc_a.json"),
		locatorJson("run_loc_a", join(tempRoot, "a-moved")),
	);
	listed = await listRunLocators({ cache: locatorCache });
	assert.equal(
		byId(listed, "run_loc_a").cwd,
		join(tempRoot, "a-moved"),
		"rewritten locator should be re-read",
	);
	const cachedB = byId(listed, "run_loc_b");
	listed = await listRunLocators({ cache: locatorCache, fresh: true });
	assert.notEqual(
		byId(listed, "run_loc_b"),
		cachedB,
		"fresh listing should re-read every file",
	);
	assert.deepEqual(byId(listed, "run_loc_b"), cachedB);
	await unlink(join(indexDir, "run_loc_a.json"));
	await unlink(join(indexDir, "run_loc_b.json"));
	listed = await listRunLocators({ cache: locatorCache });
	assert.equal(listed.locators.length, 0);
	assert.equal(locatorCache.size, 0, "deleted locators should be evicted");
	listed = await listRunLocators();
	assert.equal(
		listed.locators.length,
		0,
		"listing without a cache still works",
	);

	// ---- finished-run cache through the panel --------------------------------
	const sessionId = "session-cache";
	const done = await writeIndexedRun(indexDir, cwd, "run_done", {
		status: "completed",
		parentSessionId: sessionId,
	});
	await writeIndexedRun(indexDir, cwd, "run_live", {
		status: "running",
		parentSessionId: sessionId,
	});
	panel = new SubagentPanel(
		cwd,
		{},
		{ requestRender() {} },
		() => {},
		sessionId,
	);
	// Drive loads explicitly; the live timer would make hit counts racy.
	clearInterval(panel.timer);
	const idle = async () => {
		while (panel.loading) await sleep(5);
	};
	const reload = async (options) => {
		await idle();
		await panel.refresh(options);
		await idle();
	};
	const text = () => stripAnsi(panel.render(160).join("\n"));
	const hits = () => panel.loadCache.runHits;
	await idle();
	assert.match(text(), /run_live/);
	assert.match(text(), /run_done/);
	assert.equal(hits(), 0, "the first load reads everything");

	await reload();
	assert.equal(hits(), 1, "only the finished run is served from the cache");
	await reload();
	assert.equal(hits(), 2, "the active run is re-read on every load");

	panel.handleInput("down"); // select run_done (active runs sort first)
	assert.match(text(), /model-a/);
	const resultText = await readFile(done.resultPath, "utf8");
	await writeFile(
		done.resultPath,
		resultText.replace("model-a", "model-changed"),
	);
	await reload();
	assert.equal(hits(), 2, "a changed result.json must miss the cache");
	assert.match(text(), /model-changed/, "result.json change should render");

	await appendFile(
		join(done.runDir, "events.jsonl"),
		`${JSON.stringify({ schemaVersion: 2, timestamp: new Date().toISOString(), type: "child.failed", runId: "run_done", status: "failed", message: "child failed", data: { childRunId: "run_child", taskId: "t1" } })}\n`,
	);
	await reload();
	assert.match(
		text(),
		/run_done\s+done\+child/,
		"events.jsonl change should render",
	);

	const runJsonPath = join(done.runDir, "run.json");
	const runJson = JSON.parse(await readFile(runJsonPath, "utf8"));
	await writeFile(
		runJsonPath,
		`${JSON.stringify({ ...runJson, status: "failed" }, null, 2)}\n`,
	);
	await reload();
	assert.match(
		text(),
		/run_done\s+failed\+child/,
		"run.json change should render",
	);

	await reload();
	const beforeManual = hits();
	assert.ok(beforeManual > 2, "an unchanged finished run is cached again");
	panel.handleInput("r");
	await idle();
	assert.equal(hits(), beforeManual, "`r` must bypass the cache");

	panel.lastLoadMs = 0;
	panel.lastFreshLoadAt.set("session", performance.now() - 31_000);
	await reload({ background: true });
	assert.equal(
		hits(),
		beforeManual,
		"periodic revalidation must bypass the cache",
	);
	panel.lastLoadMs = 0; // isolate from the backoff checked below
	await reload({ background: true });
	assert.equal(
		hits(),
		beforeManual + 1,
		"background loads use the cache between revalidations",
	);

	panel.lastLoadMs = 60_000;
	panel.lastLoadEndedAt = performance.now();
	await reload({ background: true });
	assert.equal(
		hits(),
		beforeManual + 1,
		"a slow last load should back off timer ticks",
	);
	await reload();
	assert.equal(
		hits(),
		beforeManual + 2,
		"user-requested loads ignore the backoff",
	);

	await rm(done.runDir, { recursive: true, force: true });
	await reload();
	assert.doesNotMatch(text(), /run_done/, "a deleted run must disappear");
	assert.equal(
		[...panel.loadCache.runs.keys()].some((key) => key.includes("run_done")),
		false,
		"a deleted run should be evicted from the cache",
	);

	console.log(
		JSON.stringify(
			{
				name: "check-panel-cache",
				status: "completed",
				checks: [
					"locator cache reuse/reload/fresh/evict",
					"finished-run cache hit and active-run bypass",
					"result.json/events.jsonl/run.json changes invalidate",
					"manual refresh and periodic revalidation bypass",
					"slow-load timer backoff",
					"deleted run eviction",
				],
			},
			null,
			2,
		),
	);
} finally {
	panel?.dispose();
	if (oldIndexDir === undefined) delete process.env.PI_SUBAGENT_RUN_INDEX_DIR;
	else process.env.PI_SUBAGENT_RUN_INDEX_DIR = oldIndexDir;
	await rm(tempRoot, { recursive: true, force: true });
}
