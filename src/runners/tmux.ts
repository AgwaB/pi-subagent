import { execFile } from "node:child_process";
import { chmod, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
	createAttemptArtifactStore,
	type ArtifactRef,
	type ResultEnvelope,
} from "../artifacts/index.ts";
import type { ResultWorkspace } from "../artifacts/result.ts";
import {
	sandboxAllowedDomains,
	type FailureKind,
	type SandboxInput,
	type Status,
} from "../core/constants.ts";
import { SandboxUnavailableError, withSandboxedArgv } from "../sandbox/srt.ts";
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

const execFileAsync = promisify(execFile);
const POLL_INTERVAL_MS = 100;

interface RunTmuxProcessOptions {
	argv: readonly string[];
	cwd?: string;
	artifactCwd?: string;
	runId?: string;
	attemptId?: string;
	runsDir?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	sandbox?: SandboxInput | null;
	workspace?: Partial<ResultWorkspace>;
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
	tmux: {
		sessionName: string;
		sessionId: string | null;
		paneId: string | null;
	};
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

async function tmuxAvailable(): Promise<boolean> {
	try {
		await execFileAsync("tmux", ["-V"]);
		return true;
	} catch {
		return false;
	}
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

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function readWorkerMeta(path: string): Promise<WorkerMeta | undefined> {
	try {
		const { readFile } = await import("node:fs/promises");
		const parsed = JSON.parse(
			await readFile(path, "utf8"),
		) as Partial<WorkerMeta>;
		if (parsed.status !== "completed" && parsed.status !== "failed")
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

async function tmuxSessionAlive(sessionName: string): Promise<boolean> {
	try {
		await execFileAsync("tmux", ["has-session", "-t", sessionName]);
		return true;
	} catch {
		return false;
	}
}

async function killTmuxSession(sessionName: string): Promise<void> {
	try {
		await execFileAsync("tmux", ["kill-session", "-t", sessionName]);
	} catch {
		// Session may already have exited; cleanup remains best-effort.
	}
}

function workerScript(
	argv: readonly [string, ...string[]],
	cwd: string,
	eventPath: string,
	stderrPath: string,
	metaPath: string,
): string {
	return `import { spawn } from "node:child_process";\nimport { appendFileSync, closeSync, openSync, writeFileSync } from "node:fs";\nconst argv = ${JSON.stringify(argv)};\nconst cwd = ${JSON.stringify(cwd)};\nconst eventPath = ${JSON.stringify(eventPath)};\nconst stderrPath = ${JSON.stringify(stderrPath)};\nconst metaPath = ${JSON.stringify(metaPath)};\nconst messageUpdatePattern = /"type"\\s*:\\s*"message_update"/;\nconst maxStdoutLogLineChars = 64 * 1024 * 1024;\ncloseSync(openSync(eventPath, "w"));\ncloseSync(openSync(stderrPath, "w"));\nlet settled = false;\nlet stdoutBuffer = "";\nlet discardingOversizedLine = false;\nlet omittedMessageUpdates = 0;\nlet omittedMessageUpdateBytes = 0;\nlet omittedOversizedLines = 0;\nlet omittedOversizedBytes = 0;\nfunction writeStdoutLine(line) {\n  if (messageUpdatePattern.test(line)) {\n    omittedMessageUpdates += 1;\n    omittedMessageUpdateBytes += Buffer.byteLength(line, "utf8");\n    return;\n  }\n  appendFileSync(eventPath, line);\n  process.stdout.write(line);\n}\nfunction handleStdoutChunk(chunk) {\n  let text = chunk.toString("utf8");\n  while (text.length > 0) {\n    if (discardingOversizedLine) {\n      const newline = text.indexOf("\\n");\n      omittedOversizedBytes += Buffer.byteLength(newline < 0 ? text : text.slice(0, newline + 1), "utf8");\n      if (newline < 0) return;\n      discardingOversizedLine = false;\n      text = text.slice(newline + 1);\n      continue;\n    }\n    const newline = text.indexOf("\\n");\n    const segment = newline < 0 ? text : text.slice(0, newline + 1);\n    stdoutBuffer += segment;\n    text = newline < 0 ? "" : text.slice(newline + 1);\n    if (stdoutBuffer.length > maxStdoutLogLineChars) {\n      omittedOversizedLines += 1;\n      omittedOversizedBytes += Buffer.byteLength(stdoutBuffer, "utf8");\n      stdoutBuffer = "";\n      discardingOversizedLine = newline < 0;\n      continue;\n    }\n    if (newline >= 0) {\n      writeStdoutLine(stdoutBuffer);\n      stdoutBuffer = "";\n    }\n  }\n}\nfunction finishStdoutFilter() {\n  if (!discardingOversizedLine && stdoutBuffer.length > 0) writeStdoutLine(stdoutBuffer);\n  stdoutBuffer = "";\n  if (omittedMessageUpdates > 0 || omittedOversizedLines > 0) {\n    appendFileSync(eventPath, JSON.stringify({ type: "pi-subagent.stdout_filter", omitted: { messageUpdateEvents: omittedMessageUpdates, messageUpdateBytes: omittedMessageUpdateBytes, oversizedLines: omittedOversizedLines, oversizedBytes: omittedOversizedBytes }, reason: "cumulative message_update snapshots are omitted from durable stdout artifacts; final assistant text is stored in output.log" }) + "\\n");\n  }\n}\nfunction writeMeta(meta) {\n  if (settled) return;\n  settled = true;\n  finishStdoutFilter();\n  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\\n");\n}\nconst env = { ...process.env };\ndelete env.TMUX;\nconst child = spawn(argv[0], argv.slice(1), { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], env });\nchild.stdout?.on("data", handleStdoutChunk);\nchild.stderr?.on("data", (chunk) => { appendFileSync(stderrPath, chunk); process.stderr.write(chunk); });\nchild.on("error", () => { writeMeta({ status: "failed", failureKind: "spawn", exitCode: null, signal: null }); });\nchild.on("close", (exitCode, signal) => {\n  const failureKind = exitCode === 0 ? null : "exit";\n  writeMeta({ status: failureKind === null ? "completed" : "failed", failureKind, exitCode, signal });\n});\n`;
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

	if (!(await tmuxAvailable())) {
		return {
			result: null,
			store,
			cwd,
			artifactCwd,
			startedAt,
			failure: {
				status: "failed",
				failureKind: "spawn",
				exitCode: null,
				signal: null,
			},
			stderr:
				'tmux is not available on PATH; install tmux or choose backend "headless".\n',
		};
	}

	const sessionName = `pi-subagent-${store.runId}-${store.attemptId}`.replace(
		/[^A-Za-z0-9_-]/g,
		"-",
	);
	const eventPath = join(store.taskDir, "pi-events.jsonl");
	const stderrPath = store.pathFor("stderr");
	const metaPath = join(store.taskDir, "tmux-worker-meta.json");
	const scriptPath = join(store.taskDir, "tmux-worker.mjs");
	const launchPath = join(store.taskDir, "tmux-launch.sh");

	await writeFile(
		scriptPath,
		workerScript(argv, cwd, eventPath, stderrPath, metaPath),
	);

	await writeFile(
		launchPath,
		`#!/usr/bin/env bash\nset -euo pipefail\nunset TMUX\nexec ${shellQuote(process.execPath)} ${shellQuote(scriptPath)}\n`,
	);
	await chmod(launchPath, 0o700);

	async function runSession(
		tmuxCommand: string,
		tmuxArgs: readonly string[],
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
		let sessionId: string | null = null;
		let paneId: string | null = null;
		try {
			const { stdout } = await execFileAsync(
				"tmux",
				[
					"new-session",
					"-d",
					"-s",
					sessionName,
					"-P",
					"-F",
					"#{session_id}\t#{pane_id}",
					tmuxCommand,
					...tmuxArgs,
				],
				{ cwd, ...(tmuxEnv === undefined ? {} : { env: tmuxEnv }) },
			);
			const [rawSessionId, rawPaneId] = stdout.trim().split("\t");
			sessionId = rawSessionId || null;
			paneId = rawPaneId || null;
		} catch (error) {
			return {
				result: null,
				store,
				cwd,
				artifactCwd,
				startedAt,
				failure: {
					status: "failed",
					failureKind: "spawn",
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
				await killTmuxSession(sessionName);
				return {
					result: {
						meta,
						stderrRef: store.refFor("stderr", await pathBytes(stderrPath)),
						eventPath,
						tmux: { sessionName, sessionId, paneId },
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
				await killTmuxSession(sessionName);
				return {
					result: {
						meta: {
							status: "failed",
							failureKind: stopKind,
							exitCode: null,
							signal: "SIGTERM",
						},
						stderrRef: store.refFor("stderr", await pathBytes(stderrPath)),
						eventPath,
						tmux: { sessionName, sessionId, paneId },
					},
					store,
					cwd,
					artifactCwd,
					startedAt,
				};
			}

			if (!(await tmuxSessionAlive(sessionName))) {
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
						tmux: { sessionName, sessionId, paneId },
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
					await writeFile(
						launchPath,
						`#!/usr/bin/env bash\nset -euo pipefail\nunset TMUX\nexec ${launch.argv.map(shellQuote).join(" ")}\n`,
					);
					await chmod(launchPath, 0o700);
					return await runSession("/bin/bash", [launchPath], launch.env);
				},
			);
		}
		return await runSession("/bin/bash", [launchPath]);
	} catch (error) {
		if (!(error instanceof SandboxUnavailableError)) throw error;
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
