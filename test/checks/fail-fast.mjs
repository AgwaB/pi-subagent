#!/usr/bin/env node
import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runParallelSubagentTasks } from "../../src/orchestrate/run.ts";
import { startAsyncParallelSubagentRuns } from "../../src/orchestrate/async.ts";

async function makeCwd() {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subagent-fail-fast-"));
	await mkdir(join(cwd, ".pi/agents"), { recursive: true });
	await writeFile(
		join(cwd, ".pi/agents/limited.md"),
		`---\nname: limited\ntools: read\n---\nLimited test agent.\n`,
	);
	return cwd;
}

let cwd;
let oldIndexDir;
try {
	cwd = await makeCwd();
	oldIndexDir = process.env.PI_SUBAGENT_RUN_INDEX_DIR;
	const indexDir = join(cwd, "run-index");
	process.env.PI_SUBAGENT_RUN_INDEX_DIR = indexDir;
	const common = {
		backend: "inline",
		agent: "limited",
		agentScope: "project",
		tools: ["bash"],
		parentSessionId: "session-fail-fast",
		correlationId: "corr-fail-fast",
	};

	const noFailFast = await runParallelSubagentTasks(
		{
			...common,
			concurrency: 2,
			tasks: [{ task: "bad A" }, { task: "bad B" }],
		},
		cwd,
	);
	assert.equal(noFailFast.totalTasks, 2);
	assert.equal(noFailFast.startedCount, 2);
	assert.equal(noFailFast.skippedCount, 0);
	assert.equal(noFailFast.failFastTriggered, false);
	assert.deepEqual(
		noFailFast.results.map((result) => result.status),
		["failed", "failed"],
	);
	assert.equal(new Set(noFailFast.runIds).size, 2);
	const firstFailure = noFailFast.results[0];
	assert.ok(firstFailure, "expected a synthesized failed result");
	const firstFailureDir = join(cwd, ".pi/agent/runs", firstFailure.runId);
	const firstFailureRecord = JSON.parse(
		await readFile(join(firstFailureDir, "run.json"), "utf8"),
	);
	assert.equal(firstFailureRecord.parentSessionId, "session-fail-fast");
	assert.equal(firstFailureRecord.correlationId, "corr-fail-fast");
	const firstFailureEvents = (
		await readFile(join(firstFailureDir, "events.jsonl"), "utf8")
	)
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.ok(
		firstFailureEvents.some((event) => event.type === "run.started"),
		"synthesized parallel error run should record run.started",
	);
	assert.ok(
		firstFailureEvents.some((event) => event.type === "run.failed"),
		"synthesized parallel error run should record run.failed",
	);
	const firstFailureLocator = JSON.parse(
		await readFile(join(indexDir, `${firstFailure.runId}.json`), "utf8"),
	);
	assert.equal(firstFailureLocator.parentSessionId, "session-fail-fast");
	assert.equal(firstFailureLocator.correlationId, "corr-fail-fast");

	const failFast = await runParallelSubagentTasks(
		{
			...common,
			concurrency: 1,
			failFast: true,
			tasks: [{ task: "bad first" }, { task: "must be skipped" }],
		},
		cwd,
	);
	assert.equal(failFast.totalTasks, 2);
	assert.equal(failFast.startedCount, 1);
	assert.equal(failFast.skippedCount, 1);
	assert.equal(failFast.failFastTriggered, true);
	assert.equal(failFast.results.length, 1);
	assert.equal(failFast.results[0]?.status, "failed");

	const cancelSiblings = await runParallelSubagentTasks(
		{
			...common,
			concurrency: 1,
			cancelSiblingsOnFailure: true,
			tasks: [{ task: "bad first" }, { task: "must be skipped" }],
		},
		cwd,
	);
	assert.equal(cancelSiblings.failFastTriggered, true);
	assert.equal(cancelSiblings.skippedCount, 1);
	assert.equal(cancelSiblings.results[0]?.status, "failed");

	const aborted = new AbortController();
	aborted.abort();
	const parentAbort = await runParallelSubagentTasks(
		{
			backend: "inline",
			failFast: true,
			tasks: [{ task: "parent aborted before start" }],
		},
		cwd,
		aborted.signal,
	);
	assert.equal(parentAbort.results[0]?.status, "cancelled");
	assert.equal(parentAbort.results[0]?.failureKind, "abort");
	assert.equal(parentAbort.failFastTriggered, false);

	const asyncCwd = await makeCwd();
	await assert.rejects(
		() =>
			startAsyncParallelSubagentRuns(
				{
					backend: "inline",
					async: true,
					tasks: [
						{ task: "would spawn" },
						{ task: "invalid backend", backend: "bogus" },
					],
				},
				asyncCwd,
			),
		/parallel tasks\[1\] backend resolution failed/,
	);
	const runEntries = await readdir(join(asyncCwd, ".pi/agent/runs"), {
		withFileTypes: true,
	}).catch(() => []);
	assert.equal(
		runEntries.length,
		0,
		"async parallel prevalidation should fail before spawning earlier siblings",
	);

	const badCwd = join(asyncCwd, "not-a-directory");
	await writeFile(badCwd, "file blocks cwd directory creation");
	let partialError;
	try {
		await startAsyncParallelSubagentRuns(
			{
				backend: "inline",
				async: true,
				concurrency: 2,
				tasks: [
					{ task: "spawn then fail later" },
					{ task: "bad cwd", cwd: badCwd },
					{ task: "spawned sibling must be accounted" },
				],
			},
			asyncCwd,
		);
	} catch (error) {
		partialError = error;
	}
	assert.ok(partialError, "mid-launch async failure should reject");
	assert.ok(
		partialError.startedRunIds?.length >= 1,
		"mid-launch async failure should expose already-started run ids",
	);
	assert.equal(
		partialError.startedResults?.length,
		partialError.startedRunIds?.length,
	);
	const partialRunEntries = await readdir(join(asyncCwd, ".pi/agent/runs"), {
		withFileTypes: true,
	}).catch(() => []);
	assert.equal(
		partialRunEntries.filter((entry) => entry.isDirectory()).length,
		partialError.startedRunIds?.length,
		"async mid-launch failure should not return before sibling spawns are accounted",
	);
	await rm(asyncCwd, { recursive: true, force: true });

	console.log(
		JSON.stringify({ name: "check-fail-fast", status: "completed" }, null, 2),
	);
} finally {
	if (oldIndexDir === undefined) delete process.env.PI_SUBAGENT_RUN_INDEX_DIR;
	else process.env.PI_SUBAGENT_RUN_INDEX_DIR = oldIndexDir;
	if (cwd !== undefined) await rm(cwd, { recursive: true, force: true });
}
