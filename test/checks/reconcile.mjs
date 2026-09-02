#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
	access,
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createJiti } from "jiti";
import {
	beginRunRecord,
	createAttemptArtifactStore,
	readRunRecord,
	recordInterruptRequest,
	runPaths,
	updateAttemptWorkerProcess,
} from "../../src/artifacts/index.ts";
import { reconcileSubagentRun } from "../../src/orchestrate/reconcile.ts";
import {
	captureProcessIdentity,
	verifyProcessIdentity,
} from "../../src/process-identity.ts";
import {
	getSubagentStatus,
	runSubagent,
	waitForSubagent,
} from "../../api.mjs";

const execFileAsync = promisify(execFile);
const tempRoot = await mkdtemp(join(tmpdir(), "pi-subagent-reconcile-"));
const originalPath = process.env.PATH;
let orphanWorkerPid;
let orphanChildPid;
let unrelatedProcess;
let workerRaceProbe;
let epermProcess;
let partialCleanupChild;
let partialCleanupUnrelated;
let deadLeaderChildPid;
let incompleteCleanupChild;
let incompleteCleanupUnrelated;
let terminalOlderAttemptChild;
process.env.PI_SUBAGENT_RUN_INDEX_DIR = join(tempRoot, "run-index");

const sleep = (ms) =>
	new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function pidAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
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

async function createRunningAttempt(cwd, runId, attemptId, options = {}) {
	await mkdir(cwd, { recursive: true });
	const store = await createAttemptArtifactStore({ cwd, runId, attemptId });
	const startedAt =
		options.startedAt ?? new Date(Date.now() - 60_000).toISOString();
	let resultPath = options.resultPath;
	if (resultPath === undefined) {
		const result = await store.writeResult({
			backend: options.backend ?? "inline",
			status: "running",
			failureKind: null,
			cwd,
			startedAt,
			completedAt: null,
			workspace: { mode: "shared", cwd, worktreePath: null },
			sandbox: { enabled: false },
			exitCode: null,
			signal: null,
			artifacts: [],
			metadata: { contextLengthExceeded: false },
		});
		resultPath = result.artifacts.find(
			(artifact) => artifact.type === "result",
		)?.path;
	}
	await beginRunRecord({
		cwd,
		runId,
		mode: "single",
		backend: options.backend ?? "inline",
		startedAt,
		activeAttemptId: attemptId,
		attempts: [
			{
				attemptId,
				status: "running",
				backend: options.backend ?? "inline",
				startedAt,
				artifactCwd: cwd,
				resultPath,
				process: options.process,
				heartbeatAt: options.heartbeatAt,
				workspace: options.workspace,
				tmux: options.tmux,
			},
		],
	});
}

try {
	const apiUrl = pathToFileURL(resolve("api.mjs")).href;
	const localeIdentity = await captureProcessIdentity(process.pid);
	const originalLocale = {
		LC_ALL: process.env.LC_ALL,
		LANG: process.env.LANG,
		TZ: process.env.TZ,
	};
	process.env.LC_ALL = "ko_KR.UTF-8";
	process.env.LANG = "ko_KR.UTF-8";
	process.env.TZ = "Asia/Seoul";
	assert.equal(
		await verifyProcessIdentity(localeIdentity),
		"alive",
		"birth identity must not change with the caller locale or timezone",
	);
	for (const [name, value] of Object.entries(originalLocale)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}

	const parentDeathCwd = join(tempRoot, "parent-death");
	await mkdir(parentDeathCwd, { recursive: true });
	const launcher = `
    const { runSubagent } = await import(process.env.API_URL);
    const run = await runSubagent({ cwd: process.env.RUN_CWD, backend: "inline", model: "missing-provider/missing-model", task: "Provider-free parent-death check.", async: true });
    console.log(JSON.stringify({ runId: run.runId, attemptId: run.attemptId }));
  `;
	const launched = await execFileAsync(
		process.execPath,
		["--input-type=module", "-e", launcher],
		{
			cwd: resolve("."),
			env: {
				...process.env,
				API_URL: apiUrl,
				RUN_CWD: parentDeathCwd,
				PI_SUBAGENT_HEARTBEAT_MS: "50",
			},
		},
	);
	const launchedRef = JSON.parse(launched.stdout.trim());
	const waited = await waitForSubagent({
		cwd: parentDeathCwd,
		runId: launchedRef.runId,
		attemptId: launchedRef.attemptId,
		timeoutMs: 15_000,
		pollIntervalMs: 100,
	});
	assert.equal(
		waited.status,
		"completed",
		"detached durable worker should finalize after launcher exits",
	);
	assert.ok(
		["completed", "failed", "cancelled"].includes(
			waited.snapshot?.status ?? "",
		),
		"detached durable worker should reach a terminal run status",
	);
	const locatorWaited = await waitForSubagent({
		runId: launchedRef.runId,
		attemptId: launchedRef.attemptId,
		timeoutMs: 1_000,
		pollIntervalMs: 50,
	});
	assert.equal(
		locatorWaited.status,
		"completed",
		"wait without cwd should resolve the original async run cwd",
	);
	assert.equal(
		locatorWaited.snapshot?.runId,
		launchedRef.runId,
		"cwd-less wait should return the launched run snapshot",
	);
	const parentDeathStatus = await getSubagentStatus({
		cwd: parentDeathCwd,
		runId: launchedRef.runId,
		attemptId: launchedRef.attemptId,
	});
	assert.equal(
		typeof parentDeathStatus?.attempts?.[0]?.workerPid,
		"number",
		"durable worker pid should be recorded",
	);
	const locatorStatus = await getSubagentStatus({
		runId: launchedRef.runId,
		attemptId: launchedRef.attemptId,
	});
	assert.equal(
		locatorStatus?.runId,
		launchedRef.runId,
		"status without cwd should resolve the original async run cwd",
	);
	await access(
		join(
			parentDeathCwd,
			".pi/agent/runs",
			launchedRef.runId,
			"attempts",
			launchedRef.attemptId,
			"worker.log",
		),
	);

	const staleCwd = join(tempRoot, "stale");
	await createRunningAttempt(staleCwd, "run_reconcile_stale", "attempt_stale", {
		heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
	});
	const stale = await reconcileSubagentRun({
		cwd: staleCwd,
		runId: "run_reconcile_stale",
		staleAfterMs: 1,
	});
	assert.equal(stale.status, "marked-stale");
	assert.equal(stale.record?.status, "failed");
	assert.equal(stale.record?.failureKind, "stale");
	assert.equal(
		stale.record?.attempts[0]?.workspace?.worktreeCleanupStatus,
		"not-needed",
	);

	const orphanCwd = join(tempRoot, "orphan-headless-child");
	const orphanBin = join(tempRoot, "orphan-bin");
	const lateSideEffect = join(orphanCwd, "late-side-effect");
	await mkdir(orphanCwd, { recursive: true });
	await mkdir(orphanBin, { recursive: true });
	const fakePi = join(orphanBin, "pi");
	await writeFile(
		fakePi,
		`#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nawait new Promise((resolveSleep) => setTimeout(resolveSleep, 750));\nwriteFileSync(${JSON.stringify(lateSideEffect)}, "late");\nawait new Promise((resolveSleep) => setTimeout(resolveSleep, 10_000));\n`,
		{ mode: 0o700 },
	);
	await chmod(fakePi, 0o700);
	process.env.PATH = `${orphanBin}:${originalPath}`;
	const orphanRun = await runSubagent({
		cwd: orphanCwd,
		backend: "headless",
		task: "provider-free orphan process-group check",
		async: true,
	});
	let orphanAttempt;
	for (let attemptIndex = 0; attemptIndex < 300; attemptIndex += 1) {
		const status = await getSubagentStatus({
			cwd: orphanCwd,
			runId: orphanRun.runId,
		});
		orphanAttempt = status?.attempts?.[0];
		if (
			Number.isInteger(orphanAttempt?.workerPid) &&
			Number.isInteger(orphanAttempt?.pid) &&
			orphanAttempt.pid !== orphanAttempt.workerPid
		)
			break;
		await sleep(10);
	}
	assert.equal(typeof orphanAttempt?.workerPid, "number");
	assert.equal(typeof orphanAttempt?.pid, "number");
	orphanWorkerPid = orphanAttempt.workerPid;
	orphanChildPid = orphanAttempt.pid;
	process.kill(orphanWorkerPid, "SIGKILL");
	await sleep(100);
	const orphanReconciled = await reconcileSubagentRun({
		cwd: orphanCwd,
		runId: orphanRun.runId,
	});
	assert.equal(orphanReconciled.status, "marked-stale");
	assert.equal(
		pidAlive(orphanChildPid),
		false,
		"reconcile must terminate a detached execution group after its worker dies",
	);
	await sleep(900);
	await assert.rejects(
		access(lateSideEffect),
		undefined,
		"orphaned execution must not perform a late side effect",
	);
	process.env.PATH = originalPath;

	const workerRaceCwd = join(tempRoot, "worker-metadata-race");
	const executionIdentity = await captureProcessIdentity(process.pid);
	workerRaceProbe = spawn("/bin/sleep", ["30"], {
		detached: true,
		stdio: "ignore",
	});
	assert.equal(typeof workerRaceProbe.pid, "number");
	const workerIdentity = await captureProcessIdentity(workerRaceProbe.pid);
	await createRunningAttempt(
		workerRaceCwd,
		"run_worker_metadata_race",
		"attempt_worker_metadata_race",
		{
			process: {
				pid: executionIdentity.pid,
				processGroupId: executionIdentity.processGroupId,
				processBirthIdentity: executionIdentity.birthIdentity,
				command: "headless child",
			},
		},
	);
	await updateAttemptWorkerProcess({
		cwd: workerRaceCwd,
		runId: "run_worker_metadata_race",
		attemptId: "attempt_worker_metadata_race",
		process: {
			workerPid: workerIdentity.pid,
			workerProcessGroupId: workerIdentity.processGroupId,
			workerProcessBirthIdentity: workerIdentity.birthIdentity,
			command: "durable worker",
		},
	});
	const workerRaceRecord = await readRunRecord({
		cwd: workerRaceCwd,
		runId: "run_worker_metadata_race",
	});
	const workerRaceProcess = workerRaceRecord?.attempts[0]?.process;
	assert.equal(workerRaceProcess?.pid, executionIdentity.pid);
	assert.equal(
		workerRaceProcess?.processGroupId,
		executionIdentity.processGroupId,
	);
	assert.equal(
		workerRaceProcess?.processBirthIdentity,
		executionIdentity.birthIdentity,
	);
	assert.equal(
		workerRaceProcess?.command,
		"headless child",
		"a late worker update must not replace execution metadata",
	);
	assert.equal(workerRaceProcess?.workerPid, workerIdentity.pid);

	const tmuxCwd = join(tempRoot, "stale-tmux");
	await createRunningAttempt(tmuxCwd, "run_reconcile_tmux", "attempt_tmux", {
		backend: "tmux",
		heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
		workspace: {
			mode: "worktree",
			cwd: tmuxCwd,
			worktreePath: join(tempRoot, "retained-worktree"),
			worktreeCleanupStatus: "execution-owned",
		},
		tmux: {
			serverName: "ps-nonexistent-test",
			socketPath: join(tempRoot, "missing-tmux.sock"),
			launchState: "planned",
			sessionName: "run",
			sessionId: "$1",
			paneId: "%1",
		},
	});
	const tmuxStale = await reconcileSubagentRun({
		cwd: tmuxCwd,
		runId: "run_reconcile_tmux",
		staleAfterMs: 1,
	});
	assert.equal(tmuxStale.status, "marked-stale");
	assert.equal(
		tmuxStale.record?.attempts[0]?.workspace?.worktreeCleanupStatus,
		"kept",
	);
	assert.equal(typeof tmuxStale.record?.attempts[0]?.resultPath, "string");

	const interruptedCwd = join(tempRoot, "interrupted");
	await createRunningAttempt(
		interruptedCwd,
		"run_reconcile_interrupted",
		"attempt_interrupted",
		{
			heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
		},
	);
	await recordInterruptRequest(
		{ cwd: interruptedCwd, runId: "run_reconcile_interrupted" },
		"SIGINT",
		"test cancellation",
	);
	const interrupted = await reconcileSubagentRun({
		cwd: interruptedCwd,
		runId: "run_reconcile_interrupted",
		staleAfterMs: 1,
	});
	assert.equal(interrupted.status, "marked-cancelled");
	assert.equal(interrupted.record?.status, "cancelled");
	assert.equal(interrupted.record?.failureKind, "user_cancelled");

	const liveCwd = join(tempRoot, "live-worker");
	const liveIdentity = await captureProcessIdentity(process.pid);
	await createRunningAttempt(liveCwd, "run_reconcile_live", "attempt_live", {
		process: {
			pid: liveIdentity.pid,
			processGroupId: liveIdentity.processGroupId,
			processBirthIdentity: liveIdentity.birthIdentity,
			workerPid: liveIdentity.pid,
			workerProcessGroupId: liveIdentity.processGroupId,
			workerProcessBirthIdentity: liveIdentity.birthIdentity,
		},
		heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
	});
	const live = await reconcileSubagentRun({
		cwd: liveCwd,
		runId: "run_reconcile_live",
		staleAfterMs: 1,
	});
	assert.equal(
		live.status,
		"running",
		"live worker pid should keep attempt running",
	);

	const foreignResultCwd = join(tempRoot, "foreign-result");
	const foreignResultStore = await createAttemptArtifactStore({
		cwd: foreignResultCwd,
		runId: "run_reconcile_foreign_result",
		attemptId: "attempt_foreign_result",
	});
	const foreignResult = await foreignResultStore.writeResult({
		backend: "headless",
		status: "completed",
		failureKind: null,
		cwd: foreignResultCwd,
		startedAt: new Date().toISOString(),
		completedAt: new Date().toISOString(),
		workspace: {
			mode: "shared",
			cwd: foreignResultCwd,
			worktreePath: null,
		},
		sandbox: { enabled: false },
		exitCode: 0,
		signal: null,
		artifacts: [],
		metadata: { contextLengthExceeded: false },
	});
	const foreignResultPath = foreignResult.artifacts.find(
		(artifact) => artifact.type === "result",
	)?.path;
	assert.equal(typeof foreignResultPath, "string");
	await writeFile(
		join(foreignResultCwd, foreignResultPath),
		`${JSON.stringify({ ...foreignResult, runId: "run_other" })}\n`,
	);
	await createRunningAttempt(
		foreignResultCwd,
		"run_reconcile_foreign_result",
		"attempt_foreign_result",
		{
			process: {
				pid: liveIdentity.pid,
				processGroupId: liveIdentity.processGroupId,
				processBirthIdentity: liveIdentity.birthIdentity,
			},
			resultPath: foreignResultPath,
		},
	);
	const foreignResultReconcile = await reconcileSubagentRun({
		cwd: foreignResultCwd,
		runId: "run_reconcile_foreign_result",
		staleAfterMs: 1,
	});
	assert.equal(
		foreignResultReconcile.status,
		"running",
		"foreign result identity must not drive terminal reconciliation",
	);

	const danglingCwd = join(tempRoot, "dangling-active");
	await beginRunRecord({
		cwd: danglingCwd,
		runId: "run_reconcile_dangling_active",
		mode: "single",
		backend: "headless",
		activeAttemptId: "attempt_present",
		attempts: [
			{
				attemptId: "attempt_present",
				status: "running",
				backend: "headless",
				startedAt: new Date().toISOString(),
			},
		],
	});
	const danglingRef = {
		cwd: danglingCwd,
		runId: "run_reconcile_dangling_active",
	};
	const danglingRecord = await readRunRecord(danglingRef);
	assert.ok(danglingRecord);
	await writeFile(
		runPaths(danglingRef).runJsonPath,
		`${JSON.stringify({ ...danglingRecord, activeAttemptId: "attempt_missing" })}\n`,
	);
	const danglingReconcile = await reconcileSubagentRun({
		...danglingRef,
		staleAfterMs: 1,
	});
	assert.deepEqual(danglingReconcile.cleanupBlocked, {
		reason: "missing-active-attempt",
		attemptIds: ["attempt_missing"],
	});

	const terminalActiveCwd = join(tempRoot, "terminal-active-unsafe");
	await beginRunRecord({
		cwd: terminalActiveCwd,
		runId: "run_terminal_active_unsafe",
		mode: "single",
		backend: "headless",
		activeAttemptId: "attempt_terminal_active",
		attempts: [
			{
				attemptId: "attempt_terminal_active",
				status: "running",
				backend: "headless",
				startedAt: new Date().toISOString(),
				heartbeatAt: new Date().toISOString(),
				process: { pid: process.pid },
			},
		],
	});
	const terminalActiveRef = {
		cwd: terminalActiveCwd,
		runId: "run_terminal_active_unsafe",
	};
	const terminalActiveRecord = await readRunRecord(terminalActiveRef);
	assert.ok(terminalActiveRecord);
	await writeFile(
		runPaths(terminalActiveRef).runJsonPath,
		`${JSON.stringify({ ...terminalActiveRecord, status: "completed" })}\n`,
	);
	const terminalActiveReconcile = await reconcileSubagentRun({
		...terminalActiveRef,
		staleAfterMs: 30_000,
	});
	assert.deepEqual(terminalActiveReconcile.cleanupBlocked, {
		reason: "terminal-record-active-attempt",
		attemptIds: ["attempt_terminal_active"],
	});

	const terminalOwnershipCwd = join(tempRoot, "terminal-ownership-unsafe");
	await beginRunRecord({
		cwd: terminalOwnershipCwd,
		runId: "run_terminal_ownership_unsafe",
		mode: "single",
		backend: "headless",
		attempts: [
			{
				attemptId: "attempt_terminal_ownership",
				status: "completed",
				backend: "headless",
				startedAt: new Date().toISOString(),
				completedAt: new Date().toISOString(),
				process: { pid: process.pid },
			},
		],
	});
	const terminalOwnershipReconcile = await reconcileSubagentRun({
		cwd: terminalOwnershipCwd,
		runId: "run_terminal_ownership_unsafe",
		staleAfterMs: 1,
	});
	assert.deepEqual(terminalOwnershipReconcile.cleanupBlocked, {
		reason: "terminal-attempt-ownership",
		attemptIds: ["attempt_terminal_ownership"],
	});

	const inactiveOwnershipCwd = join(tempRoot, "inactive-ownership-unsafe");
	await beginRunRecord({
		cwd: inactiveOwnershipCwd,
		runId: "run_inactive_ownership_unsafe",
		mode: "single",
		backend: "headless",
		activeAttemptId: "attempt_active_safe",
		attempts: [
			{
				attemptId: "attempt_inactive_unsafe",
				status: "running",
				backend: "headless",
				startedAt: new Date(Date.now() - 1_000).toISOString(),
				process: { pid: process.pid },
			},
			{
				attemptId: "attempt_active_safe",
				status: "running",
				backend: "headless",
				startedAt: new Date().toISOString(),
				process: {
					pid: liveIdentity.pid,
					processGroupId: liveIdentity.processGroupId,
					processBirthIdentity: liveIdentity.birthIdentity,
				},
			},
		],
	});
	const inactiveOwnershipReconcile = await reconcileSubagentRun({
		cwd: inactiveOwnershipCwd,
		runId: "run_inactive_ownership_unsafe",
		staleAfterMs: 1,
	});
	assert.deepEqual(inactiveOwnershipReconcile.cleanupBlocked, {
		reason: "inactive-attempt-ownership",
		attemptIds: ["attempt_inactive_unsafe"],
	});

	const terminalResultCwd = join(tempRoot, "terminal-result-unsafe");
	const terminalResultStore = await createAttemptArtifactStore({
		cwd: terminalResultCwd,
		runId: "run_terminal_result_unsafe",
		attemptId: "attempt_terminal_result_unsafe",
	});
	const terminalResultEnvelope = await terminalResultStore.writeResult({
		backend: "headless",
		status: "completed",
		failureKind: null,
		cwd: terminalResultCwd,
		startedAt: new Date().toISOString(),
		completedAt: new Date().toISOString(),
		workspace: {
			mode: "shared",
			cwd: terminalResultCwd,
			worktreePath: null,
		},
		sandbox: { enabled: false },
		exitCode: 0,
		signal: null,
		artifacts: [],
		metadata: { contextLengthExceeded: false },
	});
	await createRunningAttempt(
		terminalResultCwd,
		"run_terminal_result_unsafe",
		"attempt_terminal_result_unsafe",
		{
			process: { pid: process.pid },
			resultPath: terminalResultEnvelope.artifacts.find(
				(artifact) => artifact.type === "result",
			)?.path,
		},
	);
	const terminalResultReconcile = await reconcileSubagentRun({
		cwd: terminalResultCwd,
		runId: "run_terminal_result_unsafe",
		staleAfterMs: 1,
	});
	assert.deepEqual(terminalResultReconcile.cleanupBlocked, {
		reason: "terminal-result-ownership",
		attemptIds: ["attempt_terminal_result_unsafe"],
	});

	const heartbeatCwd = join(tempRoot, "fresh-heartbeat");
	await createRunningAttempt(
		heartbeatCwd,
		"run_reconcile_heartbeat",
		"attempt_heartbeat",
		{
			heartbeatAt: new Date().toISOString(),
		},
	);
	const heartbeat = await reconcileSubagentRun({
		cwd: heartbeatCwd,
		runId: "run_reconcile_heartbeat",
		staleAfterMs: 30_000,
	});
	assert.equal(
		heartbeat.status,
		"running",
		"fresh heartbeat should keep attempt running",
	);

	const unrelatedCwd = join(tempRoot, "unrelated-process");
	unrelatedProcess = spawn("/bin/sleep", ["30"], {
		detached: true,
		stdio: "ignore",
	});
	assert.equal(typeof unrelatedProcess.pid, "number");
	const unrelatedIdentity = await captureProcessIdentity(unrelatedProcess.pid);
	await createRunningAttempt(
		unrelatedCwd,
		"run_reconcile_unrelated",
		"attempt_unrelated",
		{
			heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
			tmux: {
				serverName: "ps-unrelated",
				socketPath: join(tempRoot, "missing-unrelated.sock"),
				launchState: "launching",
				launchPid: unrelatedIdentity.pid,
				launchProcessGroupId: unrelatedIdentity.processGroupId,
				launchProcessBirthIdentity: `${unrelatedIdentity.birthIdentity}-mismatch`,
				sessionName: "run",
				sessionId: null,
				paneId: null,
			},
		},
	);
	const unrelatedReconcile = await reconcileSubagentRun({
		cwd: unrelatedCwd,
		runId: "run_reconcile_unrelated",
		staleAfterMs: 1,
	});
	assert.equal(
		unrelatedReconcile.status,
		"cleanup-blocked",
		"ownership mismatch must block terminal reconciliation",
	);
	assert.deepEqual(unrelatedReconcile.cleanupBlocked, {
		reason: "stale-attempt-ownership",
		attemptIds: ["attempt_unrelated"],
	});
	let registeredTool;
	const jiti = createJiti(import.meta.url, {
		interopDefault: true,
		moduleCache: false,
	});
	const registerModule = await jiti.import(resolve("src/index.ts"));
	const registerSubagentEngine =
		registerModule.default ?? registerModule;
	registerSubagentEngine({
		registerCommand() {},
		registerTool(tool) {
			registeredTool = tool;
		},
	});
	assert.ok(registeredTool);
	const cleanupBlockedToolResult = await registeredTool.execute(
		"reconcile-cleanup-blocked",
		{ action: "reconcile", runId: "run_reconcile_unrelated" },
		new AbortController().signal,
		() => undefined,
		{ cwd: unrelatedCwd },
	);
	assert.equal(cleanupBlockedToolResult.isError, true);
	assert.deepEqual(
		cleanupBlockedToolResult.details?.reconciled?.cleanupBlocked,
		{
		reason: "stale-attempt-ownership",
		attemptIds: ["attempt_unrelated"],
		},
	);
	assert.equal(
		pidAlive(unrelatedProcess.pid),
		true,
		"ownership mismatch must not signal an unrelated process",
	);

	const partialCleanupCwd = join(tempRoot, "partial-verified-cleanup");
	const partialCleanupSideEffect = join(
		partialCleanupCwd,
		"late-side-effect",
	);
	await mkdir(partialCleanupCwd, { recursive: true });
	partialCleanupChild = spawn(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`import { writeFileSync } from "node:fs"; await new Promise((resolve) => setTimeout(resolve, 750)); writeFileSync(${JSON.stringify(partialCleanupSideEffect)}, "late"); await new Promise((resolve) => setTimeout(resolve, 10_000));`,
			"owned-execution-child",
		],
		{ detached: true, stdio: "ignore" },
	);
	partialCleanupUnrelated = spawn("/bin/sleep", ["30"], {
		detached: true,
		stdio: "ignore",
	});
	assert.equal(typeof partialCleanupChild.pid, "number");
	assert.equal(typeof partialCleanupUnrelated.pid, "number");
	const partialChildIdentity = await captureProcessIdentity(
		partialCleanupChild.pid,
	);
	const partialUnrelatedIdentity = await captureProcessIdentity(
		partialCleanupUnrelated.pid,
	);
	await createRunningAttempt(
		partialCleanupCwd,
		"run_reconcile_partial_cleanup",
		"attempt_partial_cleanup",
		{
			process: {
				pid: partialChildIdentity.pid,
				processGroupId: partialChildIdentity.processGroupId,
				processBirthIdentity: partialChildIdentity.birthIdentity,
				workerPid: partialUnrelatedIdentity.pid,
				workerProcessGroupId: partialUnrelatedIdentity.processGroupId,
				workerProcessBirthIdentity: `${partialUnrelatedIdentity.birthIdentity}-mismatch`,
			},
			heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
		},
	);
	const partialCleanupReconcile = await reconcileSubagentRun({
		cwd: partialCleanupCwd,
		runId: "run_reconcile_partial_cleanup",
		staleAfterMs: 1,
	});
	assert.equal(
		partialCleanupReconcile.status,
		"cleanup-blocked",
		"an unverified identity must continue to block terminal reconciliation",
	);
	assert.equal(
		pidAlive(partialCleanupChild.pid),
		false,
		"a separately verified execution child must still be terminated",
	);
	assert.equal(
		pidAlive(partialCleanupUnrelated.pid),
		true,
		"an identity mismatch must never signal the unrelated process",
	);
	await sleep(900);
	await assert.rejects(access(partialCleanupSideEffect));

	const incompleteCleanupCwd = join(tempRoot, "incomplete-identity-cleanup");
	const incompleteCleanupSideEffect = join(
		incompleteCleanupCwd,
		"late-side-effect",
	);
	await mkdir(incompleteCleanupCwd, { recursive: true });
	incompleteCleanupChild = spawn(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`import { writeFileSync } from "node:fs"; await new Promise((resolve) => setTimeout(resolve, 3000)); writeFileSync(${JSON.stringify(incompleteCleanupSideEffect)}, "late"); await new Promise((resolve) => setTimeout(resolve, 10000));`,
			"complete-owned-child",
		],
		{ detached: true, stdio: "ignore" },
	);
	incompleteCleanupUnrelated = spawn("/bin/sleep", ["30"], {
		detached: true,
		stdio: "ignore",
	});
	assert.equal(typeof incompleteCleanupChild.pid, "number");
	assert.equal(typeof incompleteCleanupUnrelated.pid, "number");
	const incompleteChildIdentity = await captureProcessIdentity(
		incompleteCleanupChild.pid,
	);
	await createRunningAttempt(
		incompleteCleanupCwd,
		"run_reconcile_incomplete_cleanup",
		"attempt_incomplete_cleanup",
		{
			process: {
				pid: incompleteChildIdentity.pid,
				processGroupId: incompleteChildIdentity.processGroupId,
				processBirthIdentity: incompleteChildIdentity.birthIdentity,
				workerPid: incompleteCleanupUnrelated.pid,
			},
			heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
		},
	);
	const incompleteCleanupReconcile = await reconcileSubagentRun({
		cwd: incompleteCleanupCwd,
		runId: "run_reconcile_incomplete_cleanup",
		staleAfterMs: 1,
	});
	assert.equal(
		incompleteCleanupReconcile.status,
		"cleanup-blocked",
		"incomplete identity must block terminal reconciliation",
	);
	assert.equal(
		pidAlive(incompleteCleanupChild.pid),
		false,
		"a complete identity must still be cleaned independently",
	);
	assert.equal(
		pidAlive(incompleteCleanupUnrelated.pid),
		true,
		"incomplete identity must not authorize signalling its process",
	);
	await sleep(3_100);
	await assert.rejects(access(incompleteCleanupSideEffect));

	const terminalAllAttemptsCwd = join(tempRoot, "terminal-all-attempts");
	await mkdir(terminalAllAttemptsCwd, { recursive: true });
	terminalOlderAttemptChild = spawn("/bin/sleep", ["30"], {
		detached: true,
		stdio: "ignore",
	});
	assert.equal(typeof terminalOlderAttemptChild.pid, "number");
	const terminalOlderIdentity = await captureProcessIdentity(
		terminalOlderAttemptChild.pid,
	);
	await beginRunRecord({
		cwd: terminalAllAttemptsCwd,
		runId: "run_terminal_all_attempts",
		mode: "single",
		backend: "headless",
		attempts: [
			{
				attemptId: "attempt_older_running",
				status: "running",
				backend: "headless",
				startedAt: "2026-01-01T00:00:00.000Z",
				process: {
					pid: terminalOlderIdentity.pid,
					processGroupId: terminalOlderIdentity.processGroupId,
					processBirthIdentity: terminalOlderIdentity.birthIdentity,
				},
			},
			{
				attemptId: "attempt_latest_terminal",
				status: "completed",
				backend: "headless",
				failureKind: null,
				startedAt: "2026-01-01T00:00:01.000Z",
				completedAt: "2026-01-01T00:00:02.000Z",
			},
		],
	});
	const terminalAllAttempts = await reconcileSubagentRun({
		cwd: terminalAllAttemptsCwd,
		runId: "run_terminal_all_attempts",
		staleAfterMs: 1,
	});
	assert.equal(terminalAllAttempts.status, "already-terminal");
	assert.equal(
		pidAlive(terminalOlderAttemptChild.pid),
		false,
		"terminal reconciliation must clean ownership from every attempt",
	);

	const deadLeaderCwd = join(tempRoot, "dead-group-leader");
	const deadLeaderPidPath = join(deadLeaderCwd, "child.pid");
	const deadLeaderSideEffect = join(deadLeaderCwd, "late-side-effect");
	await mkdir(deadLeaderCwd, { recursive: true });
	const deadLeader = spawn(
		"/bin/bash",
		[
			"-c",
			`${JSON.stringify(process.execPath)} --input-type=module -e 'import { writeFileSync } from "node:fs"; process.on("SIGTERM", () => {}); await new Promise((resolve) => setTimeout(resolve, 3000)); writeFileSync(${JSON.stringify(deadLeaderSideEffect)}, "late"); await new Promise((resolve) => setTimeout(resolve, 10000));' ignored-sigterm-child & echo $! > ${JSON.stringify(deadLeaderPidPath)}; wait`,
		],
		{ detached: true, stdio: "ignore" },
	);
	assert.equal(typeof deadLeader.pid, "number");
	const deadLeaderIdentity = await captureProcessIdentity(deadLeader.pid);
	for (
		let index = 0;
		index < 100 && !(await pathExists(deadLeaderPidPath));
		index += 1
	)
		await sleep(10);
	deadLeaderChildPid = Number(
		(await readFile(deadLeaderPidPath, "utf8")).trim(),
	);
	assert.equal(pidAlive(deadLeaderChildPid), true);
	await sleep(100);
	await createRunningAttempt(
		deadLeaderCwd,
		"run_reconcile_dead_group_leader",
		"attempt_dead_group_leader",
		{
			process: {
				pid: deadLeaderIdentity.pid,
				processGroupId: deadLeaderIdentity.processGroupId,
				processBirthIdentity: deadLeaderIdentity.birthIdentity,
			},
			heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
		},
	);
	process.kill(deadLeader.pid, "SIGKILL");
	for (let index = 0; index < 100 && pidAlive(deadLeader.pid); index += 1)
		await sleep(10);
	const deadLeaderReconcile = await reconcileSubagentRun({
		cwd: deadLeaderCwd,
		runId: "run_reconcile_dead_group_leader",
		staleAfterMs: 1,
	});
	assert.equal(
		deadLeaderReconcile.status,
		"cleanup-blocked",
		"a dead leader with a non-drained owned group must block terminal state",
	);
	assert.equal(pidAlive(deadLeaderChildPid), true);
	assert.equal(deadLeaderReconcile.record?.status, "running");
	process.kill(-deadLeaderIdentity.processGroupId, "SIGKILL");
	for (
		let index = 0;
		index < 100 && pidAlive(deadLeaderChildPid);
		index += 1
	)
		await sleep(10);
	await sleep(900);
	await assert.rejects(access(deadLeaderSideEffect));

	// macOS answers a process-group signal with EPERM while the group holds only
	// an unreaped zombie. Reconciliation must treat that as "not delivered" and
	// let its liveness checks decide, never throw out of the initial SIGTERM.
	const epermCwd = join(tempRoot, "eperm-group");
	epermProcess = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
	assert.equal(typeof epermProcess.pid, "number");
	const epermIdentity = await captureProcessIdentity(epermProcess.pid);
	// A terminal result with a lingering owned process group: reconcile commits
	// the result only after draining the group, which starts with SIGTERM.
	const epermStore = await createAttemptArtifactStore({
		cwd: epermCwd,
		runId: "run_reconcile_eperm",
		attemptId: "attempt_eperm",
	});
	const epermEnvelope = await epermStore.writeResult({
		backend: "headless",
		status: "completed",
		failureKind: null,
		cwd: epermCwd,
		startedAt: new Date().toISOString(),
		completedAt: new Date().toISOString(),
		workspace: { mode: "shared", cwd: epermCwd, worktreePath: null },
		sandbox: { enabled: false },
		exitCode: 0,
		signal: null,
		artifacts: [],
		metadata: { contextLengthExceeded: false },
	});
	// The owning durable worker is already dead; only the child group lingers.
	const epermWorker = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
	const epermWorkerIdentity = await captureProcessIdentity(epermWorker.pid);
	epermWorker.kill("SIGKILL");
	for (let index = 0; index < 100 && pidAlive(epermWorker.pid); index += 1) await sleep(10);
	await createRunningAttempt(epermCwd, "run_reconcile_eperm", "attempt_eperm", {
		heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
		process: {
			pid: epermIdentity.pid,
			processGroupId: epermIdentity.processGroupId,
			processBirthIdentity: epermIdentity.birthIdentity,
			workerPid: epermWorkerIdentity.pid,
			workerProcessGroupId: epermWorkerIdentity.processGroupId,
			workerProcessBirthIdentity: epermWorkerIdentity.birthIdentity,
			command: "headless child",
		},
		resultPath: epermEnvelope.artifacts.find((artifact) => artifact.type === "result")?.path,
	});
	const realKillForEperm = process.kill;
	let epermGroupSignals = 0;
	process.kill = function epermGroupKill(pid, signal) {
		if (typeof pid === "number" && pid < 0 && signal !== 0 && signal !== undefined) {
			epermGroupSignals += 1;
			// The real process keeps running; simulate the kernel refusing delivery.
			throw Object.assign(new Error("kill EPERM"), { code: "EPERM", errno: -1, syscall: "kill" });
		}
		return realKillForEperm.call(process, pid, signal);
	};
	let epermReconcile;
	try {
		epermReconcile = await reconcileSubagentRun({
			cwd: epermCwd,
			runId: "run_reconcile_eperm",
			staleAfterMs: 1,
		});
	} finally {
		process.kill = realKillForEperm;
	}
	assert.ok(epermGroupSignals >= 1, `reconcile attempted a process-group signal: ${JSON.stringify(epermReconcile)}`);
	assert.equal(
		epermReconcile.status,
		"cleanup-blocked",
		`EPERM on a live group must surface as cleanup-blocked, not throw: ${JSON.stringify(epermReconcile)}`,
	);
	assert.equal(pidAlive(epermProcess.pid), true, "the live process was not killed through the patched path");
	// Once the process is actually gone, the same run reconciles to a terminal state.
	realKillForEperm.call(process, epermProcess.pid, "SIGKILL");
	for (let index = 0; index < 100 && pidAlive(epermProcess.pid); index += 1) await sleep(10);
	const epermAfter = await reconcileSubagentRun({ cwd: epermCwd, runId: "run_reconcile_eperm", staleAfterMs: 1 });
	assert.ok(
		["committed-result", "already-terminal"].includes(epermAfter.status),
		`dead process lets the terminal result commit: ${JSON.stringify(epermAfter)}`,
	);

	console.log(
		JSON.stringify({ name: "check-reconcile", status: "completed" }, null, 2),
	);
} finally {
	process.env.PATH = originalPath;
	for (const pid of [orphanChildPid, orphanWorkerPid]) {
		if (!pidAlive(pid)) continue;
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// The provider-free fixture process already exited.
			}
		}
	}
	if (unrelatedProcess?.pid && pidAlive(unrelatedProcess.pid)) {
		try {
			process.kill(-unrelatedProcess.pid, "SIGKILL");
		} catch {
			unrelatedProcess.kill("SIGKILL");
		}
	}
	if (epermProcess?.pid && pidAlive(epermProcess.pid)) {
		try {
			process.kill(-epermProcess.pid, "SIGKILL");
		} catch {
			epermProcess.kill("SIGKILL");
		}
	}
	if (workerRaceProbe?.pid && pidAlive(workerRaceProbe.pid)) {
		try {
			process.kill(-workerRaceProbe.pid, "SIGKILL");
		} catch {
			workerRaceProbe.kill("SIGKILL");
		}
	}
	for (const child of [
		partialCleanupChild,
		partialCleanupUnrelated,
		incompleteCleanupChild,
		incompleteCleanupUnrelated,
		terminalOlderAttemptChild,
	]) {
		if (!child?.pid || !pidAlive(child.pid)) continue;
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			child.kill("SIGKILL");
		}
	}
	if (pidAlive(deadLeaderChildPid)) {
		try {
			process.kill(deadLeaderChildPid, "SIGKILL");
		} catch {
			// The owned fixture process already exited.
		}
	}
	await rm(tempRoot, { recursive: true, force: true });
}
