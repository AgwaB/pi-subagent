#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import net from "node:net";
import {
	access,
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	getSubagentStatus,
	reconcileSubagentRun,
	runSubagent,
	waitForSubagent,
} from "../../api.mjs";
import {
	preparePrivateTmuxSocket,
	privateTmuxServerAlive,
	privateTmuxSocketPath,
	readPrivateTmuxRuntimeIdentity,
	terminatePrivateTmuxServer,
	TMUX_OWNERSHIP_ENV,
	tmuxOwnershipTokenDigest,
	TmuxOwnershipError,
} from "../../src/runners/tmux-control.ts";
import { runTmuxModel } from "../../src/runners/tmux.ts";
import {
	captureProcessIdentity,
	verifyProcessIdentity,
} from "../../src/process-identity.ts";
import {
	SandboxUnavailableError,
	withSandboxedArgv,
} from "../../src/sandbox/srt.ts";
import { beginRunRecord } from "../../src/artifacts/index.ts";

const execFileAsync = promisify(execFile);
const sleep = (ms) =>
	new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const tempRoot = await mkdtemp(join(tmpdir(), "pi-subagent-tmux-ownership-"));
const originalPath = process.env.PATH;
const originalTmuxTmpdir = process.env.TMUX_TMPDIR;
const socketRoots = [];
const ownedProbePids = new Set();

async function pathExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function pidAlive(pid) {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function realTmuxPath() {
	try {
		return (
			await execFileAsync("/bin/sh", ["-c", "command -v tmux"], {
				encoding: "utf8",
			})
		).stdout.trim();
	} catch {
		return "";
	}
}

try {
	const uid = process.getuid();
	const insecureRoot = await mkdtemp("/tmp/pso-insecure-");
	socketRoots.push(insecureRoot);
	const insecureDirectory = join(insecureRoot, `tmux-${uid}`);
	await mkdir(insecureDirectory, { recursive: true });
	await chmod(insecureDirectory, 0o777);
	const insecureSocket = privateTmuxSocketPath("ps-insecure", {
		TMUX_TMPDIR: insecureRoot,
	});
	await assert.rejects(
		preparePrivateTmuxSocket(insecureSocket),
		/owner-only directory/u,
	);

	const timeoutRoot = await mkdtemp("/tmp/pso-timeout-");
	socketRoots.push(timeoutRoot);
	const timeoutDirectory = join(timeoutRoot, `tmux-${uid}`);
	const timeoutBin = join(tempRoot, "timeout-bin");
	const timeoutSocket = join(timeoutDirectory, "ps-timeout");
	await mkdir(timeoutDirectory, { recursive: true, mode: 0o700 });
	await mkdir(timeoutBin);
	const timeoutChildPidPath = join(tempRoot, "timeout-control-child.pid");
	const timeoutLateSideEffect = join(tempRoot, "timeout-control-late");
	await writeFile(
		join(timeoutBin, "tmux"),
		`#!/bin/sh
${JSON.stringify(process.execPath)} --input-type=module -e 'import { writeFileSync } from "node:fs"; for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => {}); await new Promise((resolve) => setTimeout(resolve, 3000)); writeFileSync(${JSON.stringify(timeoutLateSideEffect)}, "late"); await new Promise((resolve) => setTimeout(resolve, 10000));' control-child &
echo $! > ${JSON.stringify(timeoutChildPidPath)}
wait
`,
		{ mode: 0o700 },
	);
	const socketServer = net.createServer();
	await new Promise((resolveListen, rejectListen) => {
		socketServer.once("error", rejectListen);
		socketServer.listen(timeoutSocket, resolveListen);
	});
	process.env.PATH = `${timeoutBin}:${originalPath}`;
	const controlStartedAt = Date.now();
	await assert.rejects(
		privateTmuxServerAlive({
			serverName: "ps-timeout",
			socketPath: timeoutSocket,
			ownershipTokenSha256: tmuxOwnershipTokenDigest("timeout-token"),
		}),
		/control command timed out/u,
	);
	assert.ok(
		Date.now() - controlStartedAt < 4_000,
		"tmux control timeout must be bounded",
	);
	const timeoutChildPid = Number(
		(await readFile(timeoutChildPidPath, "utf8")).trim(),
	);
	assert.equal(pidAlive(timeoutChildPid), false);
	await sleep(3_100);
	assert.equal(await pathExists(timeoutLateSideEffect), false);
	await new Promise((resolveClose) => socketServer.close(resolveClose));
	process.env.PATH = originalPath;

	const preflightBin = join(tempRoot, "preflight-bin");
	const preflightCwd = join(tempRoot, "preflight-cwd");
	await mkdir(preflightBin);
	await mkdir(preflightCwd);
	await writeFile(
		join(preflightBin, "tmux"),
		'#!/bin/sh\nif [ "$1" = "-V" ]; then echo "tmux fake"; exit 0; fi\nexit 99\n',
		{ mode: 0o700 },
	);
	process.env.PATH = `${preflightBin}:${originalPath}`;
	process.env.TMUX_TMPDIR = join("/tmp", "x".repeat(80));
	const preflight = await runSubagent({
		cwd: preflightCwd,
		backend: "tmux",
		task: "preflight failure",
		async: true,
	});
	const preflightWait = await waitForSubagent({
		cwd: preflightCwd,
		runId: preflight.runId,
		attemptId: preflight.attemptId,
		timeoutMs: 5_000,
		pollIntervalMs: 20,
	});
	assert.equal(preflightWait.status, "completed");
	assert.equal(preflightWait.snapshot?.status, "failed");
	assert.equal(typeof preflightWait.snapshot?.resultPath, "string");
	const synchronousPreflight = await runSubagent({
		cwd: preflightCwd,
		backend: "tmux",
		task: "synchronous preflight failure",
	});
	assert.equal(synchronousPreflight.status, "failed");
	assert.equal(synchronousPreflight.failureKind, "internal");
	process.env.PATH = originalPath;
	if (originalTmuxTmpdir === undefined) delete process.env.TMUX_TMPDIR;
	else process.env.TMUX_TMPDIR = originalTmuxTmpdir;

	const realTmux = await realTmuxPath();
	if (realTmux !== "") {
		const paneGateCwd = join(tempRoot, "pane-gate-cwd");
		const paneGatePi = join(tempRoot, "pane-gate-pi");
		const paneGateSideEffect = join(paneGateCwd, "side-effect");
		await mkdir(paneGateCwd);
		await writeFile(
			paneGatePi,
			`#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(paneGateSideEffect)}, "started");
process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "pane-gated" }], provider: "fake", model: "fake/model", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end" } }) + "\\n");
await new Promise((resolveSleep) => setTimeout(resolveSleep, 2_000));
`,
			{ mode: 0o700 },
		);
		const tmuxShellHook = join(tempRoot, "tmux-shell-hook.sh");
		const tmuxShellHookSideEffect = join(
			paneGateCwd,
			"shell-hook-side-effect",
		);
		await writeFile(
			tmuxShellHook,
			`echo unsafe > ${JSON.stringify(tmuxShellHookSideEffect)}\n`,
		);
		const previousBashEnv = process.env.BASH_ENV;
		process.env.BASH_ENV = tmuxShellHook;
		let releaseFinalOwnership;
		const finalOwnershipReleased = new Promise((resolveRelease) => {
			releaseFinalOwnership = resolveRelease;
		});
		let finalOwnershipObserved;
		const finalOwnershipEntered = new Promise((resolveEntered) => {
			finalOwnershipObserved = resolveEntered;
		});
		const paneGateRun = runTmuxModel({
			cwd: paneGateCwd,
			runId: "run_tmux_pane_gate",
			attemptId: "attempt_tmux_pane_gate",
			piCommand: paneGatePi,
			agent: "pane-gate-worker",
			task: "wait for final ownership",
			timeoutMs: 30_000,
			onTmuxStart: async (tmux) => {
				if (tmux.launchState !== "running") return;
				finalOwnershipObserved();
				await finalOwnershipReleased;
			},
		});
		await finalOwnershipEntered;
		if (previousBashEnv === undefined) delete process.env.BASH_ENV;
		else process.env.BASH_ENV = previousBashEnv;
		await sleep(100);
		assert.equal(
			await pathExists(paneGateSideEffect),
			false,
			"tmux pane must not execute pi before final runtime ownership persists",
		);
		assert.equal(
			await pathExists(tmuxShellHookSideEffect),
			false,
			"tmux shell startup hooks must not bypass ownership or sandbox gates",
		);
		releaseFinalOwnership();
		const paneGateResult = await paneGateRun;
		assert.equal(
			paneGateResult.status,
			"completed",
			`tmux pane failed after its ownership gate opened: ${JSON.stringify(paneGateResult)}`,
		);
		assert.equal(await pathExists(paneGateSideEffect), true);

		const hungOwnershipAbort = new AbortController();
		const hungOwnershipStartedAt = Date.now();
		const hungOwnershipRun = runTmuxModel({
			cwd: paneGateCwd,
			runId: "run_tmux_hung_ownership",
			attemptId: "attempt_tmux_hung_ownership",
			piCommand: paneGatePi,
			agent: "hung-ownership-worker",
			task: "abort hung ownership persistence",
			timeoutMs: 30_000,
			signal: hungOwnershipAbort.signal,
			onTmuxStart: async (tmux) => {
				if (tmux.launchState === "gated")
					await new Promise(() => undefined);
			},
		});
		setTimeout(() => hungOwnershipAbort.abort(), 100);
		const hungOwnershipResult = await hungOwnershipRun;
		assert.equal(hungOwnershipResult.status, "cancelled");
		assert.ok(
			Date.now() - hungOwnershipStartedAt < 2_000,
			"abort must bound a hung tmux ownership callback",
		);

		const executionError = new TmuxOwnershipError(
			"sandbox execution callback ownership failure",
			{ terminalBlocked: true },
		);
		let sandboxAvailable = true;
		try {
			await withSandboxedArgv(
				["/bin/echo", "sandbox-wrapper-check"],
				{ sandbox: true, cwd: paneGateCwd },
				async () => {
					throw executionError;
				},
			);
			assert.fail("sandbox execution callback must reject");
		} catch (error) {
			if (error instanceof SandboxUnavailableError) {
				sandboxAvailable = false;
			} else {
				assert.equal(error, executionError);
				assert.equal(error.terminalBlocked, true);
			}
		}

		if (sandboxAvailable) {
		const sandboxPaneSideEffect = join(
			paneGateCwd,
			"sandbox-side-effect",
		);
		await writeFile(
			paneGatePi,
			`#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(sandboxPaneSideEffect)}, "started");
process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "sandbox-pane-gated" }], provider: "fake", model: "fake/model", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end" } }) + "\\n");
await new Promise((resolveSleep) => setTimeout(resolveSleep, 2_000));
`,
			{ mode: 0o700 },
		);
		let releaseSandboxOwnership;
		const sandboxOwnershipReleased = new Promise((resolveRelease) => {
			releaseSandboxOwnership = resolveRelease;
		});
		let sandboxOwnershipObserved;
		const sandboxOwnershipEntered = new Promise((resolveEntered) => {
			sandboxOwnershipObserved = resolveEntered;
		});
		const sandboxPaneRun = runTmuxModel({
			cwd: paneGateCwd,
			runId: "run_tmux_sandbox_pane_gate",
			attemptId: "attempt_tmux_sandbox_pane_gate",
			piCommand: paneGatePi,
			agent: "sandbox-pane-gate-worker",
			task: "wait for final sandbox ownership",
			timeoutMs: 30_000,
			sandbox: true,
			onTmuxStart: async (tmux) => {
				if (tmux.launchState !== "running") return;
				sandboxOwnershipObserved();
				await sandboxOwnershipReleased;
			},
		});
		const sandboxOwnershipReady = await Promise.race([
			sandboxOwnershipEntered.then(() => true),
			sandboxPaneRun.then((result) => {
				if (
					result.failureKind === "sandbox" &&
					result.stderr?.includes("sandbox")
				)
					return false;
				throw new Error(
					"sandbox tmux exited before final ownership persistence",
				);
			}),
		]);
		if (sandboxOwnershipReady) {
			await sleep(100);
			assert.equal(
				await pathExists(sandboxPaneSideEffect),
				false,
				"sandbox tmux pane must retain the final ownership gate",
			);
			releaseSandboxOwnership();
			const sandboxPaneResult = await sandboxPaneRun;
			for (
				let index = 0;
				index < 100 && !(await pathExists(sandboxPaneSideEffect));
				index += 1
			)
				await sleep(10);
			assert.equal(
				await pathExists(sandboxPaneSideEffect),
				true,
				`sandbox pane did not execute after its ownership gate opened: ${sandboxPaneResult.stderr ?? "no diagnostic"}`,
			);
			assert.ok(
				["completed", "failed", "cancelled"].includes(
					sandboxPaneResult.status,
				),
			);
		}
		}

		const rejectedPaneSideEffect = join(
			paneGateCwd,
			"rejected-side-effect",
		);
		await writeFile(
			paneGatePi,
			`#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(rejectedPaneSideEffect)}, "started");
`,
			{ mode: 0o700 },
		);
		const rejectedPaneResult = await runTmuxModel({
			cwd: paneGateCwd,
			runId: "run_tmux_pane_gate_rejected",
			attemptId: "attempt_tmux_pane_gate_rejected",
			piCommand: paneGatePi,
			agent: "pane-gate-worker",
			task: "reject final ownership",
			timeoutMs: 30_000,
			onTmuxStart: async (tmux) => {
				if (tmux.launchState === "running")
					throw new Error("final ownership persistence rejected");
			},
		});
		assert.equal(rejectedPaneResult.status, "failed");
		await sleep(100);
		assert.equal(await pathExists(rejectedPaneSideEffect), false);

		const proofRoot = await mkdtemp("/tmp/pso-proof-");
		socketRoots.push(proofRoot);
		const proofDirectory = join(proofRoot, `tmux-${uid}`);
		const proofSocket = join(proofDirectory, "ps-proof");
		await mkdir(proofDirectory, { recursive: true, mode: 0o700 });
		const proofToken = "real-proof-token";
		execFileSync(
			realTmux,
			["-S", proofSocket, "new-session", "-d", "-s", "run", "sleep 30"],
			{
				env: { ...process.env, [TMUX_OWNERSHIP_ENV]: proofToken },
			},
		);
		const correctProof = {
			serverName: "ps-proof",
			socketPath: proofSocket,
			ownershipTokenSha256: tmuxOwnershipTokenDigest(proofToken),
			launchState: "running",
			launchPid: null,
			launchProcessGroupId: null,
			launchProcessBirthIdentity: null,
			sessionName: "run",
			sessionId: null,
			paneId: null,
		};
		try {
			await assert.rejects(
				privateTmuxServerAlive({
					...correctProof,
					ownershipTokenSha256: tmuxOwnershipTokenDigest("wrong-token"),
				}),
				/ownership proof does not match/u,
			);
			assert.equal(await privateTmuxServerAlive(correctProof), true);
			const runtimeProof = {
				...correctProof,
				...(await readPrivateTmuxRuntimeIdentity(correctProof)),
			};
			const independentCleanupCwd = join(
				tempRoot,
				"independent-cleanup-cwd",
			);
			await mkdir(independentCleanupCwd);
			const incompleteWorker = spawn("/bin/sleep", ["30"], {
				detached: true,
				stdio: "ignore",
			});
			assert.equal(typeof incompleteWorker.pid, "number");
			ownedProbePids.add(incompleteWorker.pid);
			await beginRunRecord({
				cwd: independentCleanupCwd,
				runId: "run_independent_tmux_cleanup",
				mode: "single",
				backend: "tmux",
				activeAttemptId: "attempt_independent_tmux_cleanup",
				attempts: [
					{
						attemptId: "attempt_independent_tmux_cleanup",
						status: "running",
						backend: "tmux",
						startedAt: new Date(
							Date.now() - 60_000,
						).toISOString(),
						heartbeatAt: new Date(
							Date.now() - 60_000,
						).toISOString(),
						process: { workerPid: incompleteWorker.pid },
						tmux: runtimeProof,
					},
				],
			});
			const independentCleanup = await reconcileSubagentRun({
				cwd: independentCleanupCwd,
				runId: "run_independent_tmux_cleanup",
				staleAfterMs: 1,
			});
			assert.equal(
				independentCleanup.status,
				"running",
				"unsafe process metadata must block terminal state",
			);
			assert.equal(
				await privateTmuxServerAlive(runtimeProof),
				false,
				"verified tmux ownership must be cleaned independently",
			);
			assert.equal(pidAlive(incompleteWorker.pid), true);
			process.kill(-incompleteWorker.pid, "SIGKILL");
			ownedProbePids.delete(incompleteWorker.pid);
		} finally {
			try {
				execFileSync(realTmux, ["-S", proofSocket, "kill-server"], {
					stdio: "ignore",
				});
			} catch {
				// The verified cleanup path normally removed it already.
			}
		}

		const controlRaceRoot = await mkdtemp("/tmp/pso-control-race-");
		socketRoots.push(controlRaceRoot);
		const controlRaceDirectory = join(controlRaceRoot, `tmux-${uid}`);
		const controlRaceSocket = join(
			controlRaceDirectory,
			"ps-control-race",
		);
		const controlRaceBin = join(tempRoot, "control-race-bin");
		await mkdir(controlRaceDirectory, { recursive: true, mode: 0o700 });
		await mkdir(controlRaceBin);
		const controlRaceSocketServer = net.createServer();
		await new Promise((resolveListen, rejectListen) => {
			controlRaceSocketServer.once("error", rejectListen);
			controlRaceSocketServer.listen(controlRaceSocket, resolveListen);
		});
		await writeFile(
			join(controlRaceBin, "tmux"),
			`#!/bin/sh
case " $* " in
  *" display-message "*) echo "no server running on fake" >&2; exit 1 ;;
esac
exit 99
`,
			{ mode: 0o700 },
		);
		const controlRacePane = spawn("/bin/sleep", ["30"], {
			detached: true,
			stdio: "ignore",
		});
		assert.equal(typeof controlRacePane.pid, "number");
		ownedProbePids.add(controlRacePane.pid);
		const controlRacePaneIdentity = await captureProcessIdentity(
			controlRacePane.pid,
		);
		const controlRaceMetadata = {
			serverName: "ps-control-race",
			socketPath: controlRaceSocket,
			ownershipTokenSha256: tmuxOwnershipTokenDigest("control-race-token"),
			launchState: "running",
			launchPid: null,
			launchProcessGroupId: null,
			launchProcessBirthIdentity: null,
			serverPid: null,
			serverProcessGroupId: null,
			serverProcessBirthIdentity: null,
			panePid: controlRacePaneIdentity.pid,
			paneProcessGroupId: controlRacePaneIdentity.processGroupId,
			paneProcessBirthIdentity: controlRacePaneIdentity.birthIdentity,
			sessionName: "run",
			sessionId: "$1",
			paneId: "%1",
		};
		process.env.PATH = `${controlRaceBin}:${originalPath}`;
		assert.equal(
			await privateTmuxServerAlive(controlRaceMetadata),
			true,
			"a dead ownership-control response must not hide a verified live pane",
		);
		assert.equal(
			await terminatePrivateTmuxServer(controlRaceMetadata),
			true,
			"cleanup may succeed only after the verified pane is dead",
		);
		assert.equal(
			await verifyProcessIdentity(controlRacePaneIdentity),
			"dead",
		);
		ownedProbePids.delete(controlRacePane.pid);
		await new Promise((resolveClose) =>
			controlRaceSocketServer.close(resolveClose),
		);
		process.env.PATH = originalPath;

		const incompletePane = spawn("/bin/sleep", ["30"], {
			detached: true,
			stdio: "ignore",
		});
		assert.equal(typeof incompletePane.pid, "number");
		ownedProbePids.add(incompletePane.pid);
		const incompleteRoot = await mkdtemp("/tmp/pso-incomplete-");
		socketRoots.push(incompleteRoot);
		const incompleteDirectory = join(incompleteRoot, `tmux-${uid}`);
		await mkdir(incompleteDirectory, { recursive: true, mode: 0o700 });
		const incompleteMetadata = {
			serverName: "ps-incomplete",
			socketPath: join(incompleteDirectory, "ps-incomplete"),
			ownershipTokenSha256: tmuxOwnershipTokenDigest("incomplete-token"),
			launchState: "running",
			launchPid: null,
			launchProcessGroupId: null,
			launchProcessBirthIdentity: null,
			serverPid: null,
			serverProcessGroupId: null,
			serverProcessBirthIdentity: null,
			panePid: incompletePane.pid,
			paneProcessGroupId: incompletePane.pid,
			paneProcessBirthIdentity: null,
			sessionName: "run",
			sessionId: "$1",
			paneId: "%1",
		};
		await assert.rejects(
			terminatePrivateTmuxServer({
				...incompleteMetadata,
				launchState: "gated",
				panePid: null,
				paneProcessGroupId: null,
				paneProcessBirthIdentity: null,
			}),
			(error) => error?.terminalBlocked === true,
			"gated launch without launcher identity must fail closed",
		);
		await assert.rejects(
			privateTmuxServerAlive(incompleteMetadata),
			/ownership metadata is incomplete/u,
		);
		await assert.rejects(
			terminatePrivateTmuxServer(incompleteMetadata),
			(error) => error?.terminalBlocked === true,
			"incomplete tmux identity must block cleanup success",
		);
		assert.equal(
			pidAlive(incompletePane.pid),
			true,
			"incomplete identity must not authorize signalling its process",
		);
		process.kill(-incompletePane.pid, "SIGKILL");
		ownedProbePids.delete(incompletePane.pid);

		for (const unsafeKind of ["incomplete", "mismatch"]) {
			const verifiedServer = spawn("/bin/sleep", ["30"], {
				detached: true,
				stdio: "ignore",
			});
			const unsafePane = spawn("/bin/sleep", ["30"], {
				detached: true,
				stdio: "ignore",
			});
			assert.equal(typeof verifiedServer.pid, "number");
			assert.equal(typeof unsafePane.pid, "number");
			ownedProbePids.add(verifiedServer.pid);
			ownedProbePids.add(unsafePane.pid);
			const verifiedServerIdentity = await captureProcessIdentity(
				verifiedServer.pid,
			);
			const unsafePaneIdentity = await captureProcessIdentity(unsafePane.pid);
			const mixedMetadata = {
				serverName: `ps-mixed-${unsafeKind}`,
				socketPath: join(
					incompleteDirectory,
					`ps-mixed-${unsafeKind}`,
				),
				ownershipTokenSha256: tmuxOwnershipTokenDigest(
					`mixed-${unsafeKind}-token`,
				),
				launchState: "running",
				launchPid: null,
				launchProcessGroupId: null,
				launchProcessBirthIdentity: null,
				serverPid: verifiedServerIdentity.pid,
				serverProcessGroupId: verifiedServerIdentity.processGroupId,
				serverProcessBirthIdentity:
					verifiedServerIdentity.birthIdentity,
				panePid: unsafePaneIdentity.pid,
				paneProcessGroupId: unsafePaneIdentity.processGroupId,
				paneProcessBirthIdentity:
					unsafeKind === "incomplete"
						? null
						: `${unsafePaneIdentity.birthIdentity}-mismatch`,
				sessionName: "run",
				sessionId: "$1",
				paneId: "%1",
			};
			await assert.rejects(
				terminatePrivateTmuxServer(mixedMetadata),
				(error) => error?.terminalBlocked === true,
				`mixed ${unsafeKind} identity must remain terminal-blocked`,
			);
			assert.equal(
				pidAlive(verifiedServer.pid),
				false,
				`verified server must be cleaned despite ${unsafeKind} pane identity`,
			);
			assert.equal(
				pidAlive(unsafePane.pid),
				true,
				`${unsafeKind} pane identity must not be signalled`,
			);
			ownedProbePids.delete(verifiedServer.pid);
			process.kill(-unsafePane.pid, "SIGKILL");
			ownedProbePids.delete(unsafePane.pid);
		}

		const deadPaneLeaderPidPath = join(tempRoot, "dead-pane-child.pid");
		const deadPaneLeader = spawn(
			"/bin/bash",
			[
				"-c",
				`/bin/sleep 30 & echo $! > ${JSON.stringify(deadPaneLeaderPidPath)}; wait`,
			],
			{ detached: true, stdio: "ignore" },
		);
		assert.equal(typeof deadPaneLeader.pid, "number");
		const deadPaneLeaderIdentity = await captureProcessIdentity(
			deadPaneLeader.pid,
		);
		for (
			let index = 0;
			index < 100 && !(await pathExists(deadPaneLeaderPidPath));
			index += 1
		)
			await sleep(10);
		const deadPaneChildPid = Number(
			(await readFile(deadPaneLeaderPidPath, "utf8")).trim(),
		);
		ownedProbePids.add(deadPaneChildPid);
		process.kill(deadPaneLeader.pid, "SIGKILL");
		for (
			let index = 0;
			index < 100 && pidAlive(deadPaneLeader.pid);
			index += 1
		)
			await sleep(10);
		await assert.rejects(
			terminatePrivateTmuxServer({
				serverName: "ps-dead-pane-leader",
				socketPath: join(incompleteDirectory, "ps-dead-pane-leader"),
				ownershipTokenSha256: tmuxOwnershipTokenDigest(
					"dead-pane-token",
				),
				launchState: "running",
				launchPid: null,
				launchProcessGroupId: null,
				launchProcessBirthIdentity: null,
				serverPid: null,
				serverProcessGroupId: null,
				serverProcessBirthIdentity: null,
				panePid: deadPaneLeaderIdentity.pid,
				paneProcessGroupId: deadPaneLeaderIdentity.processGroupId,
				paneProcessBirthIdentity: deadPaneLeaderIdentity.birthIdentity,
				sessionName: "run",
				sessionId: "$1",
				paneId: "%1",
			}),
			(error) => error?.terminalBlocked === true,
			"a dead pane leader with a live recorded group must fail closed",
		);
		assert.equal(pidAlive(deadPaneChildPid), true);
		process.kill(-deadPaneLeaderIdentity.processGroupId, "SIGKILL");
		ownedProbePids.delete(deadPaneChildPid);

		const raceBin = join(tempRoot, "race-bin");
		const raceCwd = join(tempRoot, "race-cwd");
		const invokedPath = join(tempRoot, "tmux-invoked");
		const latePath = join(raceCwd, "late-side-effect");
		await mkdir(raceBin);
		await mkdir(raceCwd);
		await writeFile(
			join(raceBin, "tmux"),
			`#!/bin/bash\nif [ "$1" = "-V" ]; then exec ${JSON.stringify(realTmux)} "$@"; fi\ncase " $* " in *" new-session "*) echo invoked > ${JSON.stringify(invokedPath)}; sleep 2;; esac\nexec ${JSON.stringify(realTmux)} "$@"\n`,
			{ mode: 0o700 },
		);
		await writeFile(
			join(raceBin, "pi"),
			`#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nawait new Promise((resolveSleep) => setTimeout(resolveSleep, 500));\nwriteFileSync(${JSON.stringify(latePath)}, "late");\nawait new Promise((resolveSleep) => setTimeout(resolveSleep, 10_000));\n`,
			{ mode: 0o700 },
		);
		process.env.PATH = `${raceBin}:${originalPath}`;
		const launched = await runSubagent({
			cwd: raceCwd,
			backend: "tmux",
			task: "launch ownership race",
			async: true,
		});
		let runningAttempt;
		for (let index = 0; index < 300; index += 1) {
			const status = await getSubagentStatus({
				cwd: raceCwd,
				runId: launched.runId,
			});
			runningAttempt = status?.attempts?.[0];
			if (
				runningAttempt?.tmux?.launchState === "launching" &&
				(await pathExists(invokedPath))
			)
				break;
			await sleep(10);
		}
		assert.equal(runningAttempt?.tmux?.launchState, "launching");
		assert.equal(typeof runningAttempt?.workerPid, "number");
		process.kill(runningAttempt.workerPid, "SIGKILL");
		await sleep(100);
		const reconciled = await reconcileSubagentRun({
			cwd: raceCwd,
			runId: launched.runId,
			staleAfterMs: 1,
		});
		assert.equal(
			reconciled.status,
			"running",
			"released launch without runtime identity must fail closed",
		);
		await sleep(2_500);
		assert.equal(await pathExists(latePath), false);
		await assert.rejects(
			privateTmuxServerAlive(runningAttempt.tmux),
			/runtime process ownership is unknown/u,
		);

		const launchingLossCwd = join(tempRoot, "launching-loss-cwd");
		const launchingMarker = join(tempRoot, "launching-server-started");
		const launchingPidsPath = join(tempRoot, "launching-runtime-pids");
		await mkdir(launchingLossCwd);
		await writeFile(
			join(raceBin, "tmux"),
			`#!/bin/bash
if [ "$1" = "-V" ]; then exec ${JSON.stringify(realTmux)} "$@"; fi
case " $* " in
  *" new-session "*)
    output="$(${JSON.stringify(realTmux)} "$@")" || exit $?
    ${JSON.stringify(realTmux)} -S "$2" display-message -p -t run '#{pid}\t#{pane_pid}' > ${JSON.stringify(launchingPidsPath)}
    rm -f "$2"
    echo started > ${JSON.stringify(launchingMarker)}
    sleep 10
    printf '%s\n' "$output"
    exit 0
    ;;
esac
exec ${JSON.stringify(realTmux)} "$@"
`,
			{ mode: 0o700 },
		);
		await writeFile(
			join(raceBin, "pi"),
			"#!/usr/bin/env node\nsetInterval(() => undefined, 1000);\n",
			{ mode: 0o700 },
		);
		const launchingLossRun = await runSubagent({
			cwd: launchingLossCwd,
			backend: "tmux",
			task: "post-release socket loss check",
			async: true,
		});
		let launchingLossAttempt;
		for (let index = 0; index < 500; index += 1) {
			const status = await getSubagentStatus({
				cwd: launchingLossCwd,
				runId: launchingLossRun.runId,
			});
			launchingLossAttempt = status?.attempts?.[0];
			if (
				launchingLossAttempt?.tmux?.launchState === "launching" &&
				(await pathExists(launchingMarker))
			)
				break;
			await sleep(10);
		}
		assert.equal(launchingLossAttempt?.tmux?.launchState, "launching");
		const [launchingServerPid, launchingPanePid] = (
			await readFile(launchingPidsPath, "utf8")
		)
			.trim()
			.split("\t")
			.map(Number);
		ownedProbePids.add(launchingServerPid);
		ownedProbePids.add(launchingPanePid);
		process.kill(launchingLossAttempt.workerPid, "SIGKILL");
		await sleep(100);
		const launchingLossReconciled = await reconcileSubagentRun({
			cwd: launchingLossCwd,
			runId: launchingLossRun.runId,
			staleAfterMs: 1,
		});
		assert.equal(
			launchingLossReconciled.status,
			"running",
			"post-release launching with a missing socket and unknown runtime identity must fail closed",
		);
		for (const pid of [launchingPanePid, launchingServerPid]) {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// The owned fixture process already exited.
				}
			}
			ownedProbePids.delete(pid);
		}
		for (let index = 0; index < 100; index += 1) {
			if (
				!pidAlive(launchingPanePid) &&
				!pidAlive(launchingServerPid)
			)
				break;
			await sleep(10);
		}
		assert.equal(pidAlive(launchingPanePid), false);
		assert.equal(pidAlive(launchingServerPid), false);
		const launchingLossProcesses = (
			await execFileAsync("/bin/ps", [
				"-axo",
				"pid=,command=",
			])
		).stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.includes(launchingLossCwd))
			.map((line) => Number(line.split(/\s+/u)[0]))
			.filter((pid) => Number.isSafeInteger(pid) && pid > 0);
		for (const pid of launchingLossProcesses) {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// The owned fixture process already exited.
				}
			}
		}

		const socketLossCwd = join(tempRoot, "socket-loss-cwd");
		const socketLossLatePath = join(socketLossCwd, "late-side-effect");
		const socketLossPiPidPath = join(socketLossCwd, "pi.pid");
		await mkdir(socketLossCwd);
		await writeFile(
			join(raceBin, "tmux"),
			`#!/bin/bash\nexec ${JSON.stringify(realTmux)} "$@"\n`,
			{ mode: 0o700 },
		);
		await writeFile(
			join(raceBin, "pi"),
			`#!/usr/bin/env node
import { writeFileSync } from "node:fs";
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(signal, () => {});
writeFileSync(${JSON.stringify(socketLossPiPidPath)}, String(process.pid));
await new Promise((resolveSleep) => setTimeout(resolveSleep, 3_000));
writeFileSync(${JSON.stringify(socketLossLatePath)}, "late");
await new Promise((resolveSleep) => setTimeout(resolveSleep, 10_000));
`,
			{ mode: 0o700 },
		);
		const socketLossRun = await runSubagent({
			cwd: socketLossCwd,
			backend: "tmux",
			task: "socket loss ownership check",
			async: true,
		});
		let socketLossAttempt;
		for (let index = 0; index < 500; index += 1) {
			const status = await getSubagentStatus({
				cwd: socketLossCwd,
				runId: socketLossRun.runId,
			});
			socketLossAttempt = status?.attempts?.[0];
			if (
				socketLossAttempt?.tmux?.launchState === "running" &&
				typeof socketLossAttempt.tmux.serverProcessBirthIdentity ===
					"string" &&
				typeof socketLossAttempt.tmux.paneProcessBirthIdentity === "string"
			)
				break;
			await sleep(10);
		}
		assert.equal(socketLossAttempt?.tmux?.launchState, "running");
		for (
			let index = 0;
			index < 100 && !(await pathExists(socketLossPiPidPath));
			index += 1
		)
			await sleep(10);
		const socketLossPiPid = Number(
			(await readFile(socketLossPiPidPath, "utf8")).trim(),
		);
		assert.equal(pidAlive(socketLossPiPid), true);
		const socketLossTmux = socketLossAttempt.tmux;
		await unlink(socketLossTmux.socketPath);
		process.kill(socketLossAttempt.workerPid, "SIGKILL");
		await sleep(100);
		const socketLossReconciled = await reconcileSubagentRun({
			cwd: socketLossCwd,
			runId: socketLossRun.runId,
			staleAfterMs: 1,
		});
		assert.equal(
			socketLossReconciled.status,
			"marked-stale",
			"socket loss may become terminal only after verified process cleanup",
		);
		const serverStatus = await verifyProcessIdentity({
			pid: socketLossTmux.serverPid,
			processGroupId: socketLossTmux.serverProcessGroupId,
			birthIdentity: socketLossTmux.serverProcessBirthIdentity,
		});
		const paneStatus = await verifyProcessIdentity({
			pid: socketLossTmux.panePid,
			processGroupId: socketLossTmux.paneProcessGroupId,
			birthIdentity: socketLossTmux.paneProcessBirthIdentity,
		});
		assert.equal(serverStatus, "dead");
		assert.equal(paneStatus, "dead");
		assert.equal(
			pidAlive(socketLossPiPid),
			false,
			"tmux cleanup must drain the pane execution group, not only its wrapper",
		);
		await sleep(3_100);
		assert.equal(await pathExists(socketLossLatePath), false);
		process.env.PATH = originalPath;
	}

	console.log(
		JSON.stringify(
			{
				name: "check-tmux-ownership",
				status: "completed",
			},
			null,
			2,
		),
	);
} finally {
	process.env.PATH = originalPath;
	if (originalTmuxTmpdir === undefined) delete process.env.TMUX_TMPDIR;
	else process.env.TMUX_TMPDIR = originalTmuxTmpdir;
	await rm(tempRoot, { recursive: true, force: true });
	for (const socketRoot of socketRoots)
		await rm(socketRoot, { recursive: true, force: true });
	for (const pid of ownedProbePids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// The owned fixture process already exited.
		}
	}
}
