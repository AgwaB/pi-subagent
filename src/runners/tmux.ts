import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAttemptArtifactStore,
	type ArtifactRef,
	type ResultEnvelope,
} from "../artifacts/index.ts";
import type {
	ResultTmuxMetadata,
	ResultWorkspace,
} from "../artifacts/result.ts";
import {
	abortFailureKind,
	isFailureKind,
	sandboxAllowedDomains,
	type FailureKind,
	type SandboxInput,
	type Status,
} from "../core/constants.ts";
import { SandboxUnavailableError, withSandboxedArgv } from "../sandbox/srt.ts";
import {
	preparePrivateTmuxSocket,
	privateTmuxServerAlive,
	privateTmuxSocketPath,
	readPrivateTmuxRuntimeIdentity,
	terminatePrivateTmuxServer,
	TMUX_OWNERSHIP_ENV,
	tmuxOwnershipTokenDigest,
	TmuxOwnershipError,
} from "./tmux-control.ts";
import {
	captureProcessIdentity,
	inspectProcessGroup,
	type ProcessIdentity,
} from "../process-identity.ts";
import {
	processGateEnvironment,
	withoutShellStartupAuthority,
} from "../shell-environment.ts";
import {
	buildPiArgv,
	detectContextLengthExceeded,
	parsePiJsonFile,
	parsePiJsonLines,
	resolveContextLengthState,
	resolvePiJsonOutcome,
	resultMetadataFromParse,
	resultSessionMetadata,
	type RunHeadlessModelOptions,
} from "./headless-model.ts";

const POLL_INTERVAL_MS = 100;
const TMUX_LAUNCH_TIMEOUT_MS = 10_000;
const TMUX_LAUNCH_KILL_GRACE_MS = 500;

interface RunTmuxProcessOptions {
	argv: readonly string[];
	cwd?: string;
	artifactCwd?: string;
	runId?: string;
	attemptId?: string;
	runsDir?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	sandbox?: SandboxInput | false | null;
	workspace?: Partial<ResultWorkspace>;
	childEnv?: NodeJS.ProcessEnv;
	onTmuxStart?: RunHeadlessModelOptions["onTmuxStart"];
}

export type RunTmuxModelOptions = RunHeadlessModelOptions;

interface WorkerMeta {
	status: Status;
	failureKind: FailureKind | null;
	exitCode: number | null;
	signal: string | null;
}

interface TmuxRunResult {
	meta: WorkerMeta;
	stderrRef: ArtifactRef;
	eventPath: string;
	tmux: ResultTmuxMetadata;
}

function assertRunnableArgv(
	argv: readonly string[],
): asserts argv is readonly [string, ...string[]] {
	if (!Array.isArray(argv) || argv.length === 0) {
		throw new Error("argv must be a non-empty array of non-empty strings.");
	}

	for (const [index, value] of argv.entries()) {
		if (typeof value !== "string" || value.length === 0) {
			throw new Error(`argv[${index}] must be a non-empty string.`);
		}
	}
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number | undefined {
	if (timeoutMs === undefined) return undefined;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new Error(
			"timeoutMs must be a positive finite number when provided.",
		);
	}
	return timeoutMs;
}


async function pathBytes(path: string): Promise<number> {
	try {
		return (await stat(path)).size;
	} catch {
		return 0;
	}
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function runGatedTmuxLaunch(options: {
	args: readonly string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	onSpawn: (identity: ProcessIdentity) => void | Promise<void>;
	onRelease: (identity: ProcessIdentity) => void | Promise<void>;
}): Promise<{ stdout: string; stderr: string }> {
	return await new Promise((resolveLaunch, rejectLaunch) => {
		const gatePath = fileURLToPath(
			new URL("../workers/process-gate.mjs", import.meta.url),
		);
		const child = spawn(
			process.execPath,
			[gatePath],
			{
				cwd: options.cwd,
				env: processGateEnvironment(process.env),
				detached: process.platform !== "win32",
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		let settled = false;
		let released = false;
		let pendingError: Error | undefined;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
		let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
		let authorizedProcessGroupId: number | undefined;
		let groupDrain: Promise<boolean> | undefined;

		async function drainLauncherGroup(): Promise<boolean> {
			const processGroupId = authorizedProcessGroupId;
			if (processGroupId === undefined) return pendingError === undefined;
			for (const signal of ["SIGTERM", "SIGKILL"] as const) {
				if (inspectProcessGroup(processGroupId) === "dead") return true;
				try {
					process.kill(-processGroupId, signal);
				} catch (error) {
					if ((error as NodeJS.ErrnoException)?.code !== "ESRCH")
						return false;
				}
				for (let index = 0; index < 10; index += 1) {
					const status = inspectProcessGroup(processGroupId);
					if (status === "dead") return true;
					if (status === "unknown") return false;
					await sleep(25);
				}
			}
			return inspectProcessGroup(processGroupId) === "dead";
		}

		function startGroupDrain(): Promise<boolean> {
			groupDrain ??= drainLauncherGroup();
			return groupDrain;
		}

		function appendLimited(current: string, chunk: unknown): string {
			return `${current}${String(chunk)}`.slice(-64 * 1024);
		}

		function finish(result: { ok: true } | { ok: false; error: Error }): void {
			if (settled) return;
			settled = true;
			if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
			if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
			options.signal?.removeEventListener("abort", onAbort);
			if (result.ok) resolveLaunch({ stdout, stderr });
			else rejectLaunch(result.error);
		}

		function signalLauncher(signal: NodeJS.Signals): void {
			try {
				if (
					authorizedProcessGroupId !== undefined &&
					process.platform !== "win32"
				)
					process.kill(-authorizedProcessGroupId, signal);
				else child.kill(signal);
			} catch (error) {
				if ((error as NodeJS.ErrnoException)?.code !== "ESRCH") throw error;
			}
		}

		function onAbort(): void {
			stopWithError(
				Object.assign(new Error("tmux gated launch was aborted"), {
					failureKind: "abort" as const,
				}),
			);
		}

		function stopWithError(error: Error): void {
			if (pendingError !== undefined || settled) return;
			pendingError = error;
			child.stdin?.destroy();
			signalLauncher("SIGTERM");
			forceKillTimer = setTimeout(() => {
				signalLauncher("SIGKILL");
			}, TMUX_LAUNCH_KILL_GRACE_MS);
		}

		child.stdout?.on("data", (chunk) => {
			stdout = appendLimited(stdout, chunk);
		});
		child.stderr?.on("data", (chunk) => {
			stderr = appendLimited(stderr, chunk);
		});
		child.stdin?.on("error", (error) => {
			if ((error as NodeJS.ErrnoException).code !== "EPIPE")
				stopWithError(error);
		});
		child.once("error", (error) => finish({ ok: false, error }));
		child.once("exit", () => void startGroupDrain());
		child.once("close", (code, signal) => {
			void (async () => {
				if (!(await startGroupDrain())) {
					finish({
						ok: false,
						error: new TmuxOwnershipError(
							"tmux gated launcher process group did not drain",
							{ terminalBlocked: true },
						),
					});
					return;
				}
			if (pendingError !== undefined) {
				finish({ ok: false, error: pendingError });
				return;
			}
			if (signal !== null) {
				finish({
					ok: false,
					error: new TmuxOwnershipError(
						`tmux gated launcher terminated by ${signal}`,
					),
				});
				return;
			}
			if (code === 0) {
				finish({ ok: true });
				return;
			}
			finish({
				ok: false,
				error: new TmuxOwnershipError(
					released
						? `tmux launch failed with exit code ${String(code)}: ${stderr.trim() || "no diagnostic"}`
						: "tmux launch gate closed before ownership was recorded",
				),
			});
			})().catch((error) =>
				finish({
					ok: false,
					error: new TmuxOwnershipError(
						`tmux gated launcher cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
						{ terminalBlocked: true },
					),
				}),
			);
		});
		child.once("spawn", () => {
			const pid = child.pid;
			if (pid === undefined) {
				child.stdin?.destroy();
				child.kill("SIGKILL");
				finish({
					ok: false,
					error: new TmuxOwnershipError(
						"tmux gated launcher did not expose a pid",
					),
				});
				return;
			}
			timeoutTimer = setTimeout(() => {
				stopWithError(
					new TmuxOwnershipError(
						"tmux gated launch timed out before ownership was verified",
						{ terminalBlocked: true },
					),
				);
			}, TMUX_LAUNCH_TIMEOUT_MS);
			void captureProcessIdentity(pid)
				.then(async (identity) => {
					if (
						process.platform !== "win32" &&
						identity.pid === identity.processGroupId
					)
						authorizedProcessGroupId = identity.processGroupId;
					await options.onSpawn(identity);
					return identity;
				})
				.then(async (identity) => {
					if (settled || pendingError !== undefined) return;
					await options.onRelease(identity);
					if (settled || pendingError !== undefined) return;
					released = true;
					child.stdin?.end(
						`${JSON.stringify({
							argv: ["tmux", ...options.args],
							cwd: options.cwd,
							env: options.env,
						})}\n`,
					);
				})
				.catch((error) => {
					stopWithError(
						error instanceof Error ? error : new Error(String(error)),
					);
				});
		});
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) onAbort();
	});
}

async function readWorkerMeta(path: string): Promise<WorkerMeta | undefined> {
	try {
		const { readFile } = await import("node:fs/promises");
		const parsed = JSON.parse(
			await readFile(path, "utf8"),
		) as Partial<WorkerMeta>;
		if (parsed.status !== "completed" && parsed.status !== "failed")
			return undefined;
		if (
			parsed.failureKind !== null &&
			parsed.failureKind !== undefined &&
			!isFailureKind(parsed.failureKind)
		)
			return undefined;
		return {
			status: parsed.status,
			failureKind: parsed.failureKind ?? null,
			exitCode: typeof parsed.exitCode === "number" ? parsed.exitCode : null,
			signal: typeof parsed.signal === "string" ? parsed.signal : null,
		};
	} catch {
		return undefined;
	}
}

async function tmuxSessionAlive(tmux: ResultTmuxMetadata): Promise<boolean> {
	return await privateTmuxServerAlive(tmux);
}

async function killTmuxSession(tmux: ResultTmuxMetadata): Promise<void> {
	if (!(await terminatePrivateTmuxServer(tmux)))
		throw new TmuxOwnershipError(
			"tmux private server remained alive after termination",
			{ terminalBlocked: true },
		);
}

function workerScript(
	argv: readonly [string, ...string[]],
	cwd: string,
	eventPath: string,
	stderrPath: string,
	metaPath: string,
): string {
	return `import { spawn } from "node:child_process";\nimport { appendFileSync, closeSync, openSync, writeFileSync } from "node:fs";\nconst argv = ${JSON.stringify(argv)};\nconst cwd = ${JSON.stringify(cwd)};\nconst eventPath = ${JSON.stringify(eventPath)};\nconst stderrPath = ${JSON.stringify(stderrPath)};\nconst metaPath = ${JSON.stringify(metaPath)};\nconst messageUpdatePattern = /"type"\\s*:\\s*"message_update"/;\nconst maxStdoutLogLineChars = 64 * 1024 * 1024;\ncloseSync(openSync(eventPath, "w"));\ncloseSync(openSync(stderrPath, "w"));\nlet settled = false;\nlet stdoutBuffer = "";\nlet discardingOversizedLine = false;\nlet omittedMessageUpdates = 0;\nlet omittedMessageUpdateBytes = 0;\nlet omittedOversizedLines = 0;\nlet omittedOversizedBytes = 0;\nfunction writeStdoutLine(line) {\n  if (messageUpdatePattern.test(line)) {\n    omittedMessageUpdates += 1;\n    omittedMessageUpdateBytes += Buffer.byteLength(line, "utf8");\n    return;\n  }\n  appendFileSync(eventPath, line);\n  process.stdout.write(line);\n}\nfunction handleStdoutChunk(chunk) {\n  let text = chunk.toString("utf8");\n  while (text.length > 0) {\n    if (discardingOversizedLine) {\n      const newline = text.indexOf("\\n");\n      omittedOversizedBytes += Buffer.byteLength(newline < 0 ? text : text.slice(0, newline + 1), "utf8");\n      if (newline < 0) return;\n      discardingOversizedLine = false;\n      text = text.slice(newline + 1);\n      continue;\n    }\n    const newline = text.indexOf("\\n");\n    const segment = newline < 0 ? text : text.slice(0, newline + 1);\n    stdoutBuffer += segment;\n    text = newline < 0 ? "" : text.slice(newline + 1);\n    if (stdoutBuffer.length > maxStdoutLogLineChars) {\n      omittedOversizedLines += 1;\n      omittedOversizedBytes += Buffer.byteLength(stdoutBuffer, "utf8");\n      stdoutBuffer = "";\n      discardingOversizedLine = newline < 0;\n      continue;\n    }\n    if (newline >= 0) {\n      writeStdoutLine(stdoutBuffer);\n      stdoutBuffer = "";\n    }\n  }\n}\nfunction finishStdoutFilter() {\n  if (!discardingOversizedLine && stdoutBuffer.length > 0) writeStdoutLine(stdoutBuffer);\n  stdoutBuffer = "";\n  if (omittedMessageUpdates > 0 || omittedOversizedLines > 0) {\n    appendFileSync(eventPath, JSON.stringify({ type: "pi-subagent.stdout_filter", omitted: { messageUpdateEvents: omittedMessageUpdates, messageUpdateBytes: omittedMessageUpdateBytes, oversizedLines: omittedOversizedLines, oversizedBytes: omittedOversizedBytes }, reason: "cumulative message_update snapshots are omitted from durable stdout artifacts; final assistant text is stored in output.log" }) + "\\n");\n  }\n}\nfunction writeMeta(meta) {\n  if (settled) return;\n  settled = true;\n  finishStdoutFilter();\n  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\\n");\n}\nconst env = { ...process.env };\ndelete env.TMUX;\ndelete env[${JSON.stringify(TMUX_OWNERSHIP_ENV)}];\nconst child = spawn(argv[0], argv.slice(1), { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], env });\nchild.stdout?.on("data", handleStdoutChunk);\nchild.stderr?.on("data", (chunk) => { appendFileSync(stderrPath, chunk); process.stderr.write(chunk); });\nchild.on("error", () => { writeMeta({ status: "failed", failureKind: "spawn", exitCode: null, signal: null }); });\nchild.on("close", (exitCode, signal) => {\n  const failureKind = exitCode === 0 ? null : "exit";\n  writeMeta({ status: failureKind === null ? "completed" : "failed", failureKind, exitCode, signal });\n});\n`;
}

async function runTmuxProcess(options: RunTmuxProcessOptions): Promise<{
	result: TmuxRunResult | null;
	store: Awaited<ReturnType<typeof createAttemptArtifactStore>>;
	cwd: string;
	artifactCwd: string;
	startedAt: Date;
	failure?: WorkerMeta;
	stderr?: string;
}> {
	const argv = options.argv;
	assertRunnableArgv(argv);
	const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
	const cwd = resolve(options.cwd ?? process.cwd());
	const artifactCwd = resolve(options.artifactCwd ?? cwd);
	const startedAt = new Date();
	const store = await createAttemptArtifactStore({
		cwd: artifactCwd,
		runId: options.runId,
		attemptId: options.attemptId,
		runsDir: options.runsDir,
	});


	const sessionName = "run";
	const eventPath = join(store.taskDir, "pi-events.jsonl");
	const stderrPath = store.pathFor("stderr");
	const metaPath = join(store.taskDir, "tmux-worker-meta.json");
	const scriptPath = join(store.taskDir, "tmux-worker.mjs");
	const paneGatePath = join(store.taskDir, "tmux-pane.gate");
	const processGatePath = fileURLToPath(
		new URL("../workers/process-gate.mjs", import.meta.url),
	);

	let childEnv = { ...process.env };
	delete childEnv.TMUX;
	delete childEnv.PI_SUBAGENT_DURABLE_WORKER_BINDING_JSON;
	Object.assign(childEnv, options.childEnv ?? {});
	childEnv = withoutShellStartupAuthority(childEnv);
	const ownershipToken = randomBytes(32).toString("hex");
	const ownershipTokenSha256 = tmuxOwnershipTokenDigest(ownershipToken);
	await writeFile(
		scriptPath,
		workerScript(argv, cwd, eventPath, stderrPath, metaPath),
	);

	// Keep the socket name short under TMUX_TMPDIR and Unix socket path limits.
	const serverName = `ps-${randomBytes(12).toString("hex")}`;
	const socketPath = privateTmuxSocketPath(serverName, childEnv);
	await preparePrivateTmuxSocket(socketPath);
	const tmuxServerEnv: NodeJS.ProcessEnv = {
		...processGateEnvironment(childEnv),
		PATH: childEnv.PATH ?? process.env.PATH ?? "/usr/bin:/bin",
		...(childEnv.TMUX_TMPDIR === undefined
			? {}
			: { TMUX_TMPDIR: childEnv.TMUX_TMPDIR }),
		[TMUX_OWNERSHIP_ENV]: ownershipToken,
	};
	const plannedTmuxIdentity: ResultTmuxMetadata = {
		serverName,
		socketPath,
		ownershipTokenSha256,
		launchState: "planned",
		launchPid: null,
		launchProcessGroupId: null,
		launchProcessBirthIdentity: null,
		serverPid: null,
		serverProcessGroupId: null,
		serverProcessBirthIdentity: null,
		panePid: null,
		paneProcessGroupId: null,
		paneProcessBirthIdentity: null,
		sessionName,
		sessionId: null,
		paneId: null,
	};

	async function runSession(
		panePayload: {
			argv: readonly [string, ...string[]];
			env: NodeJS.ProcessEnv;
		},
		tmuxEnv?: NodeJS.ProcessEnv,
	): Promise<{
		result: TmuxRunResult | null;
		store: Awaited<ReturnType<typeof createAttemptArtifactStore>>;
		cwd: string;
		artifactCwd: string;
		startedAt: Date;
		failure?: WorkerMeta;
		stderr?: string;
	}> {
		let tmuxIdentity = plannedTmuxIdentity;
		await options.onTmuxStart?.(tmuxIdentity);
		try {
			const launch = await runGatedTmuxLaunch({
				args: [
					"-S",
					socketPath,
					"-f",
					"/dev/null",
					"new-session",
					"-d",
					"-s",
					sessionName,
					"-P",
					"-F",
					"#{session_id}|#{pane_id}",
					process.execPath,
					processGatePath,
					"--file",
					paneGatePath,
				],
				cwd,
				env: tmuxEnv ?? tmuxServerEnv,
				signal: options.signal,
				onSpawn: async (launchIdentity) => {
					tmuxIdentity = {
						...plannedTmuxIdentity,
						launchState: "gated",
						launchPid: launchIdentity.pid,
						launchProcessGroupId: launchIdentity.processGroupId,
						launchProcessBirthIdentity: launchIdentity.birthIdentity,
					};
					await options.onTmuxStart?.(tmuxIdentity);
				},
				onRelease: async (launchIdentity) => {
					tmuxIdentity = {
						...plannedTmuxIdentity,
						launchState: "launching",
						launchPid: launchIdentity.pid,
						launchProcessGroupId: launchIdentity.processGroupId,
						launchProcessBirthIdentity: launchIdentity.birthIdentity,
					};
					await options.onTmuxStart?.(tmuxIdentity);
				},
			});
			const [rawSessionId, rawPaneId] = launch.stdout.trim().split("|");
			tmuxIdentity = {
				...plannedTmuxIdentity,
				launchState: "running",
				launchPid: null,
				launchProcessGroupId: null,
				launchProcessBirthIdentity: null,
				sessionId: rawSessionId || null,
				paneId: rawPaneId || null,
			};
			tmuxIdentity = {
				...tmuxIdentity,
				...(await readPrivateTmuxRuntimeIdentity(tmuxIdentity)),
			};
			await options.onTmuxStart?.(tmuxIdentity);
			await writeFile(
				paneGatePath,
				`${JSON.stringify({
					argv: panePayload.argv,
					cwd,
					env: panePayload.env,
				})}\n`,
				{
				mode: 0o600,
				flag: "wx",
				},
			);
		} catch (error) {
			if (await tmuxSessionAlive(tmuxIdentity)) {
				try {
					await killTmuxSession(tmuxIdentity);
				} catch (cleanupError) {
					throw new TmuxOwnershipError(
						`tmux launch failed and the private server could not be terminated: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
						{ terminalBlocked: true },
					);
				}
			}
			return {
				result: null,
				store,
				cwd,
				artifactCwd,
				startedAt,
				failure: {
					status:
						(error as { failureKind?: unknown })?.failureKind === "abort"
							? "cancelled"
							: "failed",
					failureKind:
						(error as { failureKind?: unknown })?.failureKind === "abort"
							? abortFailureKind(options.signal)
							: "spawn",
					exitCode: null,
					signal: null,
				},
				stderr:
					error instanceof Error ? `${error.message}\n` : `${String(error)}\n`,
			};
		}

		const deadline =
			timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
		let stopKind: "timeout" | "abort" | null = null;

		while (true) {
			const meta = await readWorkerMeta(metaPath);
			if (meta !== undefined) {
				await killTmuxSession(tmuxIdentity);
				return {
					result: {
						meta,
						stderrRef: store.refFor("stderr", await pathBytes(stderrPath)),
						eventPath,
						tmux: tmuxIdentity,
					},
					store,
					cwd,
					artifactCwd,
					startedAt,
				};
			}

			if (options.signal?.aborted) stopKind = "abort";
			if (deadline !== undefined && Date.now() >= deadline)
				stopKind = "timeout";
			if (stopKind !== null) {
				await killTmuxSession(tmuxIdentity);
				return {
					result: {
						meta: {
							status: stopKind === "abort" ? "cancelled" : "failed",
							failureKind:
								stopKind === "abort" ? abortFailureKind(options.signal) : stopKind,
							exitCode: null,
							signal: "SIGTERM",
						},
						stderrRef: store.refFor("stderr", await pathBytes(stderrPath)),
						eventPath,
						tmux: tmuxIdentity,
					},
					store,
					cwd,
					artifactCwd,
					startedAt,
				};
			}

			if (!(await tmuxSessionAlive(tmuxIdentity))) {
				for (let index = 0; index < 20; index += 1) {
					const exitedMeta = await readWorkerMeta(metaPath);
					if (exitedMeta !== undefined) {
						await killTmuxSession(tmuxIdentity);
						return {
							result: {
								meta: exitedMeta,
								stderrRef: store.refFor(
									"stderr",
									await pathBytes(stderrPath),
								),
								eventPath,
								tmux: tmuxIdentity,
							},
							store,
							cwd,
							artifactCwd,
							startedAt,
						};
					}
					await sleep(10);
				}
				return {
					result: {
						meta: {
							status: "failed",
							failureKind: "spawn",
							exitCode: null,
							signal: null,
						},
						stderrRef: store.refFor("stderr", await pathBytes(stderrPath)),
						eventPath,
						tmux: tmuxIdentity,
					},
					store,
					cwd,
					artifactCwd,
					startedAt,
				};
			}

			await sleep(POLL_INTERVAL_MS);
		}
	}

	try {
		if (options.sandbox) {
			return await withSandboxedArgv(
				[process.execPath, scriptPath],
				{
					sandbox: options.sandbox,
					cwd,
					writablePaths: [store.taskDir],
					allowPty: true,
					signal: options.signal,
				},
				async (launch) => {
					let sandboxEnv = {
						...childEnv,
						...(launch.env ?? {}),
					};
					sandboxEnv = withoutShellStartupAuthority(sandboxEnv);
					delete sandboxEnv.PI_SUBAGENT_DURABLE_WORKER_BINDING_JSON;
					const explicitBinding =
						options.childEnv?.PI_SUBAGENT_DURABLE_WORKER_BINDING_JSON;
					if (explicitBinding !== undefined)
						sandboxEnv.PI_SUBAGENT_DURABLE_WORKER_BINDING_JSON =
							explicitBinding;
					return await runSession(
						{
							argv: launch.argv,
							env: sandboxEnv,
						},
						tmuxServerEnv,
					);
				},
			);
		}
		return await runSession(
			{
				argv: [process.execPath, scriptPath],
				env: childEnv,
			},
			tmuxServerEnv,
		);
	} catch (error) {
		if (!(error instanceof SandboxUnavailableError)) {
			if (error instanceof TmuxOwnershipError && error.terminalBlocked === true)
				throw error;
			if (await tmuxSessionAlive(plannedTmuxIdentity)) {
				try {
					await killTmuxSession(plannedTmuxIdentity);
				} catch (cleanupError) {
					throw new TmuxOwnershipError(
						`tmux execution failed and the private server could not be terminated: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
						{ terminalBlocked: true },
					);
				}
			}
			throw error;
		}
		return {
			result: null,
			store,
			cwd,
			artifactCwd,
			startedAt,
			failure: {
				status: "failed",
				failureKind: "sandbox",
				exitCode: null,
				signal: null,
			},
			stderr: `${error.message}\n`,
		};
	}
}

export async function runTmuxModel(
	options: RunTmuxModelOptions,
): Promise<ResultEnvelope> {
	const sandbox = options.sandbox
		? { enabled: true, allowedDomains: sandboxAllowedDomains(options.sandbox) }
		: { enabled: false };
	if (typeof options.agent !== "string" || options.agent.length === 0) {
		throw new Error("agent must be a non-empty string.");
	}
	if (typeof options.task !== "string" || options.task.length === 0) {
		throw new Error("task must be a non-empty string.");
	}

	const sessionMetadata = await resultSessionMetadata(
		resolve(options.cwd ?? process.cwd()),
		options.sessionId,
	);
	const { result, store, cwd, artifactCwd, startedAt, failure, stderr } =
		await runTmuxProcess({ ...options, argv: buildPiArgv(options) });
	if (result === null) {
		const artifacts: ArtifactRef[] = [
			await store.writeTextArtifact("stderr", stderr ?? ""),
			await store.writeTextArtifact("output", ""),
		];
		return await store.writeResult({
			backend: "tmux",
			status: failure?.status ?? "failed",
			failureKind: failure?.failureKind ?? "spawn",
			cwd: artifactCwd,
			startedAt,
			completedAt: new Date(),
			workspace: options.workspace ?? { mode: "shared", cwd },
			sandbox,
			exitCode: failure?.exitCode ?? null,
			signal: failure?.signal ?? null,
			artifacts,
			correlationId: options.correlationId,
			metadata: {
				contextLengthExceeded: detectContextLengthExceeded({
					stderrText: stderr ?? "",
				}),
				...sessionMetadata,
				...(options.parentSessionId === undefined
					? {}
					: { parentSessionId: options.parentSessionId }),
			},
		});
	}

	const stderrText = await import("node:fs/promises").then(({ readFile }) =>
		readFile(store.pathFor("stderr"), "utf8").catch(() => ""),
	);
	const parsed = await parsePiJsonFile(result.eventPath).catch(() =>
		parsePiJsonLines(""),
	);
	await unlink(result.eventPath).catch(() => undefined);
	const rawContextLengthExceeded = detectContextLengthExceeded({
		stderrText,
		errors: parsed.errors,
	});
	const contextLength = resolveContextLengthState(
		parsed,
		rawContextLengthExceeded,
	);
	const meta = resolvePiJsonOutcome(
		result.meta,
		parsed,
		contextLength.contextLengthExceeded,
	);

	const outputRef = await store.writeTextArtifact(
		"output",
		parsed.finalAssistantText,
	);
	return await store.writeResult({
		backend: "tmux",
		status: meta.status,
		failureKind: meta.failureKind,
		cwd: artifactCwd,
		startedAt,
		completedAt: new Date(),
		workspace: options.workspace ?? { mode: "shared", cwd },
		sandbox,
		exitCode: meta.exitCode,
		signal: meta.signal,
		artifacts: [result.stderrRef, outputRef],
		tmux: result.tmux,
		correlationId: options.correlationId,
		metadata: {
			...resultMetadataFromParse(parsed, contextLength, meta),
			...sessionMetadata,
			...(options.parentSessionId === undefined
				? {}
				: { parentSessionId: options.parentSessionId }),
		},
	});
}
