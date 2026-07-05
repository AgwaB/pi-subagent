#!/usr/bin/env node
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendRunEvent,
	commitAttemptResultIfActive,
	createAttemptArtifactStore,
	finishAttemptFromResult,
	readRunRecord,
	recordAttemptHeartbeat,
	updateAttemptProcess,
} from "../../src/artifacts/index.ts";
import { startAsyncSubagentRun } from "../../src/orchestrate/async.ts";
import {
	getSubagentStatus,
	interruptSubagent,
	waitForSubagent,
} from "../../api.mjs";

const cwd = await mkdtemp(join(tmpdir(), "pi-subagent-lifecycle-"));
try {
	const runId = "run_lifecycle_terminal";
	const attemptId = "attempt_lifecycle_terminal";
	const store = await createAttemptArtifactStore({ cwd, runId, attemptId });
	const result = await store.writeResult({
		backend: "inline",
		status: "completed",
		failureKind: null,
		cwd,
		startedAt: "2026-01-01T00:00:00.000Z",
		completedAt: "2026-01-01T00:00:02.000Z",
		workspace: { mode: "shared", cwd, worktreePath: null },
		sandbox: { enabled: false },
		exitCode: 0,
		signal: null,
		artifacts: [],
		metadata: { contextLengthExceeded: false },
	});
	await finishAttemptFromResult({ cwd, runId }, result);
	await recordAttemptHeartbeat({ cwd, runId, attemptId });
	await updateAttemptProcess({
		cwd,
		runId,
		attemptId,
		process: { pid: 99999999, command: "late-heartbeat" },
	});
	const terminalRecord = await readRunRecord({ cwd, runId });
	assert.equal(terminalRecord?.status, "completed");
	assert.equal(terminalRecord?.completedAt, "2026-01-01T00:00:02.000Z");
	assert.equal(
		terminalRecord?.attempts[0]?.process?.command,
		undefined,
		"late process update must not mutate terminal attempt metadata",
	);
	const lateCancel = await store.writeResult({
		backend: "inline",
		status: "cancelled",
		failureKind: "user_cancelled",
		cwd,
		startedAt: "2026-01-01T00:00:00.000Z",
		completedAt: "2026-01-01T00:00:03.000Z",
		workspace: { mode: "shared", cwd, worktreePath: null },
		sandbox: { enabled: false },
		exitCode: null,
		signal: "SIGINT",
		artifacts: [],
		metadata: { contextLengthExceeded: false },
	});
	const lateCommit = await commitAttemptResultIfActive(
		{ cwd, runId },
		lateCancel,
	);
	assert.equal(lateCommit.committed, false);
	const afterLateCommit = await readRunRecord({ cwd, runId });
	assert.equal(
		afterLateCommit?.status,
		"completed",
		"late signal result must not overwrite an already-terminal attempt",
	);

	const eventsRun = "run_lifecycle_events";
	const eventsAttempt = "attempt_lifecycle_events";
	const eventsStore = await createAttemptArtifactStore({
		cwd,
		runId: eventsRun,
		attemptId: eventsAttempt,
	});
	const eventsResult = await eventsStore.writeResult({
		backend: "inline",
		status: "completed",
		failureKind: null,
		cwd,
		startedAt: "2026-01-01T00:00:00.000Z",
		completedAt: "2026-01-01T00:00:01.000Z",
		workspace: { mode: "shared", cwd, worktreePath: null },
		sandbox: { enabled: false },
		exitCode: 0,
		signal: null,
		artifacts: [],
		metadata: { contextLengthExceeded: false },
	});
	await finishAttemptFromResult({ cwd, runId: eventsRun }, eventsResult);
	await appendRunEvent(
		{ cwd, runId: eventsRun },
		{
			type: "child.failed",
			status: "failed",
			message: "temporary child failure",
			data: { childRunId: "run_child_lifecycle", failureKind: "model" },
		},
	);
	await appendFile(
		join(cwd, ".pi/agent/runs", eventsRun, "events.jsonl"),
		"{not-json}\n",
	);
	await appendRunEvent(
		{ cwd, runId: eventsRun },
		{
			type: "child.completed",
			status: "completed",
			message: "child recovered",
			data: { childRunId: "run_child_lifecycle" },
		},
	);
	const eventsStatus = await getSubagentStatus({
		cwd,
		runId: eventsRun,
		attemptId: eventsAttempt,
	});
	assert.equal(eventsStatus?.childSummary?.total, 1);
	assert.equal(eventsStatus?.childSummary?.failed, 0);
	assert.equal(eventsStatus?.childSummary?.completed, 1);
	assert.equal(eventsStatus?.childSummary?.latestFailure, null);

	const multiChildRun = "run_lifecycle_multi_child";
	const multiChildAttempt = "attempt_lifecycle_multi_child";
	const multiStore = await createAttemptArtifactStore({
		cwd,
		runId: multiChildRun,
		attemptId: multiChildAttempt,
	});
	const multiResult = await multiStore.writeResult({
		backend: "inline",
		status: "completed",
		failureKind: null,
		cwd,
		startedAt: "2026-01-01T00:00:00.000Z",
		completedAt: "2026-01-01T00:00:01.000Z",
		workspace: { mode: "shared", cwd, worktreePath: null },
		sandbox: { enabled: false },
		exitCode: 0,
		signal: null,
		artifacts: [],
		metadata: { contextLengthExceeded: false },
	});
	await finishAttemptFromResult({ cwd, runId: multiChildRun }, multiResult);
	for (const event of [
		{
			type: "child.failed",
			status: "failed",
			data: { childRunId: "child-a", failureKind: "model" },
		},
		{
			type: "child.failed",
			status: "failed",
			data: { childRunId: "child-b", failureKind: "timeout" },
		},
		{
			type: "child.completed",
			status: "completed",
			data: { childRunId: "child-b" },
		},
	]) {
		await appendRunEvent({ cwd, runId: multiChildRun }, event);
	}
	const multiStatus = await getSubagentStatus({
		cwd,
		runId: multiChildRun,
		attemptId: multiChildAttempt,
	});
	assert.equal(multiStatus?.childSummary?.failed, 1);
	assert.equal(multiStatus?.childSummary?.latestFailure?.childRunId, "child-a");

	const waited = await waitForSubagent({
		cwd,
		runId: eventsRun,
		attemptId: eventsAttempt,
		timeoutMs: 100,
		pollIntervalMs: 10,
	});
	assert.equal(waited.status, "completed");
	assert.equal(waited.outcome, "terminal");
	assert.equal(waited.snapshot?.durationMs, 1000);

	const bogusRunDir = join(
		cwd,
		".pi/agent/runs/run_bogus_status/attempts/attempt_bogus",
	);
	await mkdir(bogusRunDir, { recursive: true });
	await writeFile(
		join(bogusRunDir, "result.json"),
		`${JSON.stringify({ runId: "run_bogus_status", attemptId: "attempt_bogus", backend: "inline", status: "done", cwd })}\n`,
	);
	const bogus = await getSubagentStatus({
		cwd,
		runId: "run_bogus_status",
		attemptId: "attempt_bogus",
	});
	assert.equal(
		bogus,
		null,
		"bogus result status must not be coerced into a snapshot",
	);

	const asyncFalse = await startAsyncSubagentRun({
		cwd,
		backend: "inline",
		input: { sandbox: false, onComplete: "detach" },
	});
	assert.equal(asyncFalse.sandbox.enabled, false);
	await waitForSubagent({
		cwd,
		runId: asyncFalse.runId,
		attemptId: asyncFalse.attemptId,
		timeoutMs: 3000,
		pollIntervalMs: 50,
	});

	const previousDelay = process.env.PI_SUBAGENT_DURABLE_WORKER_START_DELAY_MS;
	process.env.PI_SUBAGENT_DURABLE_WORKER_START_DELAY_MS = "3000";
	try {
		const interruptible = await startAsyncSubagentRun({
			cwd,
			backend: "inline",
			input: {
				task: "This delayed worker should be interrupted.",
				onComplete: "detach",
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 250));
		const interrupted = await interruptSubagent({
			cwd,
			runId: interruptible.runId,
			attemptId: interruptible.attemptId,
			reason: "lifecycle test cancellation",
		});
		assert.equal(interrupted.status, "interrupt-requested");
		const interruptedWait = await waitForSubagent({
			cwd,
			runId: interruptible.runId,
			attemptId: interruptible.attemptId,
			timeoutMs: 5000,
			pollIntervalMs: 50,
		});
		assert.equal(interruptedWait.status, "completed");
		assert.equal(interruptedWait.snapshot?.status, "cancelled");
		assert.equal(interruptedWait.snapshot?.failureKind, "user_cancelled");
	} finally {
		if (previousDelay === undefined)
			delete process.env.PI_SUBAGENT_DURABLE_WORKER_START_DELAY_MS;
		else process.env.PI_SUBAGENT_DURABLE_WORKER_START_DELAY_MS = previousDelay;
	}

	console.log(
		JSON.stringify({ name: "check-lifecycle", status: "completed" }, null, 2),
	);
} finally {
	await rm(cwd, { recursive: true, force: true });
}
