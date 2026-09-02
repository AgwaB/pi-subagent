#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	access,
	appendFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	appendRunEvent,
	beginRunRecord,
	commitAttemptResultIfActive,
	createAttemptArtifactStore,
	finishAttemptFromResult,
	readRunEvents,
	readRunRecord,
	recordAttemptHeartbeat,
	updateAttemptProcess,
	upsertRunAttempt,
} from "../../src/artifacts/index.ts";
import {
	captureProcessIdentity,
	verifyProcessIdentity,
} from "../../src/process-identity.ts";
import { startAsyncSubagentRun } from "../../src/orchestrate/async.ts";
import {
	discardSubagentExecution,
	prepareSubagentExecution,
} from "../../src/orchestrate/run.ts";
import {
	getSubagentStatus,
	interruptSubagent,
	runSubagent,
	waitForSubagent,
} from "../../api.mjs";

const cwd = await mkdtemp(join(tmpdir(), "pi-subagent-lifecycle-"));
const originalPath = process.env.PATH;
let stubbornChildPid;

function pidAlive(pid) {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function pathExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

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

	const stalePreparedRunId = "run_stale_prepared";
	const stalePreparedA = await prepareSubagentExecution({
		cwd,
		runId: stalePreparedRunId,
		attemptId: "attempt_prepared_a",
		input: { backend: "headless", task: "must not execute" },
	});
	await assert.rejects(
		prepareSubagentExecution({
			cwd,
			runId: stalePreparedRunId,
			attemptId: "attempt_prepared_b",
			input: { backend: "headless", task: "successor" },
		}),
		/already has active attempt/u,
		"a successor must not reserve authority while another attempt is active",
	);
	await upsertRunAttempt({
		cwd,
		runId: stalePreparedRunId,
		attemptId: stalePreparedA.attemptId,
		status: "cancelled",
		backend: "headless",
		failureKind: "user_cancelled",
		completedAt: new Date(),
		activate: true,
		onlyIfActive: true,
	});
	const stalePreparedB = await prepareSubagentExecution({
		cwd,
		runId: stalePreparedRunId,
		attemptId: "attempt_prepared_b",
		input: { backend: "headless", task: "successor" },
	});
	await discardSubagentExecution(stalePreparedA);
	const afterStaleDiscard = await readRunRecord({
		cwd,
		runId: stalePreparedRunId,
	});
	assert.equal(
		afterStaleDiscard?.activeAttemptId,
		stalePreparedB.attemptId,
		"a stale discard must not terminalize its active successor",
	);
	await discardSubagentExecution(stalePreparedB);

	const finalizerWorker = spawn("/bin/sleep", ["30"], {
		detached: true,
		stdio: "ignore",
	});
	assert.equal(typeof finalizerWorker.pid, "number");
	const finalizerWorkerIdentity = await captureProcessIdentity(
		finalizerWorker.pid,
	);
	process.kill(-finalizerWorkerIdentity.processGroupId, "SIGKILL");
	await new Promise((resolveExit) => finalizerWorker.once("exit", resolveExit));
	const finalizerPath = fileURLToPath(
		new URL("../../src/workers/terminal-finalizer.mjs", import.meta.url),
	);
	for (const terminalCase of [
		{ status: "completed", failureKind: null, event: "completed" },
		{ status: "failed", failureKind: "model", event: "failed" },
		{
			status: "cancelled",
			failureKind: "user_cancelled",
			event: "cancelled",
		},
	]) {
		const finalizerRunId = `run_finalizer_${terminalCase.status}`;
		const finalizerAttemptId = `attempt_finalizer_${terminalCase.status}`;
		const finalizerStore = await createAttemptArtifactStore({
			cwd,
			runId: finalizerRunId,
			attemptId: finalizerAttemptId,
		});
		const finalizerResult = await finalizerStore.writeResult({
			backend: "headless",
			status: terminalCase.status,
			failureKind: terminalCase.failureKind,
			cwd,
			startedAt: new Date().toISOString(),
			completedAt: new Date().toISOString(),
			workspace: { mode: "shared", cwd, worktreePath: null },
			sandbox: { enabled: false },
			exitCode: terminalCase.status === "completed" ? 0 : null,
			signal: terminalCase.status === "cancelled" ? "SIGTERM" : null,
			artifacts: [],
			metadata: { contextLengthExceeded: false },
		});
		await beginRunRecord({
			cwd,
			runId: finalizerRunId,
			mode: "single",
			backend: "headless",
			activeAttemptId: finalizerAttemptId,
			attempts: [
				{
					attemptId: finalizerAttemptId,
					status: "running",
					backend: "headless",
					startedAt: new Date().toISOString(),
					artifactCwd: cwd,
					resultPath: finalizerResult.artifacts.find(
						(artifact) => artifact.type === "result",
					)?.path,
					process: {
						workerPid: finalizerWorkerIdentity.pid,
						workerProcessGroupId:
							finalizerWorkerIdentity.processGroupId,
						workerProcessBirthIdentity:
							finalizerWorkerIdentity.birthIdentity,
					},
				},
			],
		});
		const finalizerPayload = Buffer.from(
			JSON.stringify({
				ref: { cwd, runId: finalizerRunId },
				attemptId: finalizerAttemptId,
				status: terminalCase.status,
				worker: finalizerWorkerIdentity,
			}),
		).toString("base64url");
		const finalizerProcess = spawn(
			process.execPath,
			[finalizerPath, finalizerPayload],
			{ cwd, stdio: "ignore" },
		);
		const finalizerExit = await new Promise((resolveExit) =>
			finalizerProcess.once("exit", resolveExit),
		);
		assert.equal(finalizerExit, 0);
		const finalizerEvents = await readRunEvents({
			cwd,
			runId: finalizerRunId,
		});
		assert.equal(
			finalizerEvents.filter(
				(event) => event.type === `attempt.${terminalCase.event}`,
			).length,
			1,
		);
		assert.equal(
			finalizerEvents.filter(
				(event) => event.type === `run.${terminalCase.event}`,
			).length,
			1,
		);
	}
	const delayedFinalizerRunId = "run_delayed_finalizer_successor";
	await beginRunRecord({
		cwd,
		runId: delayedFinalizerRunId,
		mode: "single",
		backend: "headless",
		attempts: [
			{
				attemptId: "attempt_successor",
				status: "completed",
				backend: "headless",
				startedAt: new Date().toISOString(),
				completedAt: new Date().toISOString(),
			},
		],
	});
	const delayedFinalizerPayload = Buffer.from(
		JSON.stringify({
			ref: { cwd, runId: delayedFinalizerRunId },
			attemptId: "attempt_stale_finalizer",
			status: "failed",
			worker: finalizerWorkerIdentity,
		}),
	).toString("base64url");
	const delayedFinalizer = spawn(
		process.execPath,
		[finalizerPath, delayedFinalizerPayload],
		{ cwd, stdio: "ignore" },
	);
	assert.equal(
		await new Promise((resolveExit) =>
			delayedFinalizer.once("exit", resolveExit),
		),
		0,
	);
	const delayedFinalizerEvents = await readRunEvents({
		cwd,
		runId: delayedFinalizerRunId,
	});
	assert.equal(
		delayedFinalizerEvents.some(
			(event) => event.attemptId === "attempt_stale_finalizer",
		),
		false,
		"a delayed finalizer must not publish against a terminal successor",
	);
	assert.equal(
		delayedFinalizerEvents.some((event) => event.type === "run.failed"),
		false,
	);
	const readyStopRaceRunId = "run_stale_finalizer_active_successor";
	await beginRunRecord({
		cwd,
		runId: readyStopRaceRunId,
		mode: "single",
		backend: "headless",
		activeAttemptId: "attempt_active_successor",
		attempts: [
			{
				attemptId: "attempt_active_successor",
				status: "running",
				backend: "headless",
				startedAt: new Date().toISOString(),
			},
		],
	});
	const staleActivePayload = Buffer.from(
		JSON.stringify({
			ref: { cwd, runId: readyStopRaceRunId },
			attemptId: "attempt_stale_finalizer",
			status: "failed",
			worker: finalizerWorkerIdentity,
		}),
	).toString("base64url");
	const staleActiveFinalizer = spawn(
		process.execPath,
		[finalizerPath, staleActivePayload],
		{ cwd, stdio: "ignore" },
	);
	assert.equal(
		await new Promise((resolveExit) =>
			staleActiveFinalizer.once("exit", resolveExit),
		),
		0,
	);
	const afterStaleActiveFinalizer = await readRunRecord({
		cwd,
		runId: readyStopRaceRunId,
	});
	assert.equal(afterStaleActiveFinalizer?.status, "running");
	assert.equal(
		afterStaleActiveFinalizer?.activeAttemptId,
		"attempt_active_successor",
	);
	assert.equal(
		afterStaleActiveFinalizer?.attempts[0]?.failureKind ?? null,
		null,
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
	const cachedEvents = await readRunEvents({ cwd, runId: eventsRun }, Infinity);
	assert.ok(cachedEvents.length > 0, "expected cached events to be readable");
	cachedEvents.length = 0;
	const cachedAgain = await readRunEvents({ cwd, runId: eventsRun }, Infinity);
	assert.ok(
		cachedAgain.length > 0,
		"mutating a readRunEvents result must not corrupt the event cache",
	);
	cachedAgain[0].type = "run.failed";
	const cachedThird = await readRunEvents({ cwd, runId: eventsRun }, Infinity);
	assert.notEqual(
		cachedThird[0]?.type,
		"run.failed",
		"mutating a returned event object must not corrupt the event cache",
	);

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
	const asyncFalseTerminalRecord = await readRunRecord({
		cwd,
		runId: asyncFalse.runId,
	});
	const asyncFalseWorker =
		asyncFalseTerminalRecord?.attempts[0]?.process;
	if (
		asyncFalseWorker?.workerPid !== undefined &&
		asyncFalseWorker.workerProcessGroupId !== undefined &&
		asyncFalseWorker.workerProcessBirthIdentity !== undefined
	)
		assert.equal(
			await verifyProcessIdentity({
				pid: asyncFalseWorker.workerPid,
				processGroupId: asyncFalseWorker.workerProcessGroupId,
				birthIdentity: asyncFalseWorker.workerProcessBirthIdentity,
			}),
			"dead",
			"terminal publication must wait for the durable worker to exit",
		);

	const previousDelay = process.env.PI_SUBAGENT_DURABLE_WORKER_START_DELAY_MS;
	const previousTerminalDelay =
		process.env.PI_SUBAGENT_DURABLE_WORKER_TERMINAL_WRITE_DELAY_MS;
	process.env.PI_SUBAGENT_DURABLE_WORKER_START_DELAY_MS = "3000";
	process.env.PI_SUBAGENT_DURABLE_WORKER_TERMINAL_WRITE_DELAY_MS = "250";
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
			escalateAfterMs: 10,
			killAfterMs: 3000,
		});
		assert.equal(interrupted.status, "interrupt-requested");
		assert.equal(
			interrupted.signal,
			"SIGTERM",
			"interrupt defaults to SIGTERM so a headless Pi child stops gracefully and terminates its tool subprocesses",
		);
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
		const interruptedEvents = await readRunEvents(
			{ cwd, runId: interruptible.runId },
			Infinity,
		);
		assert.equal(
			interruptedEvents.some(
				(event) => event.type === "attempt.stale_result_ignored",
			),
			false,
			"duplicate signal/failure writes should not emit stale-result noise",
		);
	} finally {
		if (previousDelay === undefined)
			delete process.env.PI_SUBAGENT_DURABLE_WORKER_START_DELAY_MS;
		else process.env.PI_SUBAGENT_DURABLE_WORKER_START_DELAY_MS = previousDelay;
		if (previousTerminalDelay === undefined)
			delete process.env.PI_SUBAGENT_DURABLE_WORKER_TERMINAL_WRITE_DELAY_MS;
		else
			process.env.PI_SUBAGENT_DURABLE_WORKER_TERMINAL_WRITE_DELAY_MS =
				previousTerminalDelay;
	}

	// When the kernel refuses every initial signal with EPERM (macOS, zombie-only
	// group), interrupt must report the attempt as unsupported rather than throw.
	{
		const epermTarget = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
		const epermIdentity = await captureProcessIdentity(epermTarget.pid);
		const epermRunId = "run_interrupt_eperm_target";
		const epermAttemptId = "attempt_interrupt_eperm_target";
		const epermStartedAt = new Date();
		await beginRunRecord({
			cwd,
			runId: epermRunId,
			mode: "single",
			backend: "headless",
			startedAt: epermStartedAt,
			activeAttemptId: epermAttemptId,
			attempts: [
				{
					attemptId: epermAttemptId,
					status: "running",
					backend: "headless",
					startedAt: epermStartedAt.toISOString(),
					process: {
						pid: epermIdentity.pid,
						processGroupId: epermIdentity.processGroupId,
						processBirthIdentity: epermIdentity.birthIdentity,
					},
				},
			],
		});
		const realKill = process.kill;
		process.kill = function epermKill(pid, signal) {
			if (typeof pid === "number" && (pid === epermIdentity.pid || pid === -epermIdentity.processGroupId) && signal !== 0 && signal !== undefined)
				throw Object.assign(new Error("kill EPERM"), { code: "EPERM", errno: -1, syscall: "kill" });
			return realKill.call(process, pid, signal);
		};
		let epermInterrupt;
		try {
			epermInterrupt = await interruptSubagent({ cwd, runId: epermRunId, reason: "eperm" });
		} finally {
			process.kill = realKill;
		}
		assert.equal(epermInterrupt.status, "unsupported", JSON.stringify(epermInterrupt));
		assert.deepEqual(epermInterrupt.unsupportedAttempts, [epermAttemptId]);
		assert.equal(pidAlive(epermTarget.pid), true);
		realKill.call(process, epermTarget.pid, "SIGKILL");
	}

	const shortTarget = spawn("/bin/sleep", ["30"], {
		detached: true,
		stdio: "ignore",
	});
	assert.equal(typeof shortTarget.pid, "number");
	const shortIdentity = await captureProcessIdentity(shortTarget.pid);
	const shortRunId = "run_interrupt_short_target";
	const shortAttemptId = "attempt_interrupt_short_target";
	await beginRunRecord({
		cwd,
		runId: shortRunId,
		mode: "single",
		backend: "headless",
		activeAttemptId: shortAttemptId,
		attempts: [
			{
				attemptId: shortAttemptId,
				status: "running",
				backend: "headless",
				startedAt: new Date().toISOString(),
				process: {
					pid: shortIdentity.pid,
					processGroupId: shortIdentity.processGroupId,
					processBirthIdentity: shortIdentity.birthIdentity,
				},
			},
		],
	});
	const realProcessKill = process.kill;
	const postExitSignals = [];
	try {
		const shortInterrupted = await interruptSubagent({
			cwd,
			runId: shortRunId,
			attemptId: shortAttemptId,
			reason: "short target escalation revalidation",
		});
		assert.equal(shortInterrupted.status, "interrupt-requested");
		// The initial signal has been sent synchronously above; from here on
		// only escalation timers may signal, and they must revalidate first.
		process.kill = function trackedProcessKill(pid, signal) {
			if (
				pid === -shortIdentity.processGroupId &&
				(signal === "SIGTERM" || signal === "SIGKILL")
			)
				postExitSignals.push(signal);
			return realProcessKill.call(process, pid, signal);
		};
		for (let index = 0; index < 100 && pidAlive(shortTarget.pid); index += 1)
			await new Promise((resolveSleep) => setTimeout(resolveSleep, 10));
		assert.equal(pidAlive(shortTarget.pid), false);
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 3_200));
		assert.deepEqual(
			postExitSignals,
			[],
			"escalation must not signal a cached target after its identity is dead",
		);
	} finally {
		process.kill = realProcessKill;
		if (pidAlive(shortTarget.pid)) {
			try {
				realProcessKill(-shortTarget.pid, "SIGKILL");
			} catch {
				// The owned fixture process already exited.
			}
		}
	}

	const interruptBin = join(cwd, "interrupt-bin");
	const stubbornChildPidPath = join(cwd, "interrupt-child.pid");
	const stubbornLateSideEffect = join(cwd, "interrupt-late-side-effect");
	await mkdir(interruptBin);
	await writeFile(
		join(interruptBin, "pi"),
		`#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(`import { writeFileSync } from "node:fs"; for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => {}); await new Promise((resolve) => setTimeout(resolve, 4000)); writeFileSync(${JSON.stringify(stubbornLateSideEffect)}, "late"); await new Promise((resolve) => setTimeout(resolve, 10000));`)}], { stdio: ["ignore", "inherit", "inherit"] });
child.unref();
writeFileSync(${JSON.stringify(stubbornChildPidPath)}, String(child.pid));
await new Promise((resolve) => setTimeout(resolve, 10000));
`,
		{ mode: 0o700 },
	);
	process.env.PATH = `${interruptBin}:${originalPath}`;
	const stubbornInterruptRun = await runSubagent({
		cwd,
		backend: "headless",
		task: "provider-free stubborn interrupt group",
		async: true,
	});
	for (
		let index = 0;
		index < 300 && !(await pathExists(stubbornChildPidPath));
		index += 1
	)
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 10));
	stubbornChildPid = Number(
		(await readFile(stubbornChildPidPath, "utf8")).trim(),
	);
	assert.equal(pidAlive(stubbornChildPid), true);
	const stubbornInterrupted = await interruptSubagent({
		cwd,
		runId: stubbornInterruptRun.runId,
		attemptId: stubbornInterruptRun.attemptId,
		reason: "stubborn headless interrupt regression",
	});
	assert.equal(stubbornInterrupted.status, "interrupt-requested");
	const stubbornWait = await waitForSubagent({
		cwd,
		runId: stubbornInterruptRun.runId,
		attemptId: stubbornInterruptRun.attemptId,
		timeoutMs: 10_000,
		pollIntervalMs: 50,
	});
	assert.equal(stubbornWait.status, "completed");
	assert.equal(stubbornWait.snapshot?.status, "cancelled");
	assert.equal(pidAlive(stubbornChildPid), false);
	await new Promise((resolveSleep) => setTimeout(resolveSleep, 4_100));
	assert.equal(await pathExists(stubbornLateSideEffect), false);
	process.env.PATH = originalPath;

	console.log(
		JSON.stringify({ name: "check-lifecycle", status: "completed" }, null, 2),
	);
} finally {
	process.env.PATH = originalPath;
	if (pidAlive(stubbornChildPid)) {
		try {
			process.kill(stubbornChildPid, "SIGKILL");
		} catch {
			// The owned fixture process already exited.
		}
	}
	await rm(cwd, { recursive: true, force: true });
}
