import { execFile } from "node:child_process";
import { unlink, writeFile } from "node:fs/promises";
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
import { workerScript } from "./tmux.ts";

const execFileAsync = promisify(execFile);
const POLL_INTERVAL_MS = 100;

interface RunHerdrProcessOptions {
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
}

export type RunHerdrModelOptions = RunHeadlessModelOptions;

interface WorkerMeta {
	status: Status;
	failureKind: FailureKind | null;
	exitCode: number | null;
	signal: string | null;
}

interface HerdrRunResult {
	meta: WorkerMeta;
	stderrRef: ArtifactRef;
	eventPath: string;
	herdr: {
		workspaceId: string;
		tabId: string | null;
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

async function herdrAvailable(): Promise<boolean> {
	try {
		await execFileAsync("herdr", ["status"], { timeout: 5000 });
		return true;
	} catch {
		return false;
	}
}

async function pathBytes(path: string): Promise<number> {
	try {
		const { stat } = await import("node:fs/promises");
		return (await stat(path)).size;
	} catch {
		return 0;
	}
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

// Quote for the pane's shell: PowerShell on Windows ('' escape), POSIX
// shells on Linux/macOS ('\'' escape, same as the tmux backend).
function shellQuote(value: string): string {
	const escaped = value.replaceAll(
		"'",
		process.platform === "win32" ? "''" : `'\\''`,
	);
	return `'${escaped}'`;
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

interface HerdrWorkspace {
	workspaceId: string;
	tabId: string | null;
	// Guaranteed non-null: createHerdrWorkspace throws when the root pane id
	// is missing from the response.
	paneId: string;
}

async function createHerdrWorkspace(
	cwd: string,
	label: string,
): Promise<HerdrWorkspace> {
	const { stdout } = await execFileAsync(
		"herdr",
		["workspace", "create", "--cwd", cwd, "--label", label],
		{ timeout: 15000 },
	);
	const parsed = JSON.parse(stdout) as {
		error?: { message?: string; code?: string };
		result?: {
			workspace?: { workspace_id?: string };
			tab?: { tab_id?: string };
			root_pane?: { pane_id?: string };
		};
	};
	if (parsed.error !== undefined) {
		throw new Error(
			`herdr workspace create failed: ${parsed.error.message ?? JSON.stringify(parsed.error)}`,
		);
	}
	const workspaceId = parsed.result?.workspace?.workspace_id;
	const paneId = parsed.result?.root_pane?.pane_id;
	if (workspaceId === undefined || paneId === undefined) {
		throw new Error(
			`herdr workspace create returned an unexpected shape: ${stdout.slice(0, 500)}`,
		);
	}
	return {
		workspaceId,
		tabId: parsed.result?.tab?.tab_id ?? null,
		paneId,
	};
}

async function paneRunCommand(
	paneId: string,
	commandArgs: readonly string[],
): Promise<void> {
	// The command is sent to the pane's shell (PowerShell on Windows).
	// PowerShell requires the call operator to invoke a quoted path; bare
	// 'path' args parse as a string expression and fail with a ParserError.
	const joined = commandArgs.map(shellQuote).join(" ");
	const commandLine =
		process.platform === "win32" ? `& ${joined}` : joined;
	await execFileAsync(
		"herdr",
		["pane", "run", paneId, commandLine],
		{ timeout: 15000 },
	);
}

async function closePane(paneId: string): Promise<void> {
	try {
		await execFileAsync("herdr", ["pane", "close", paneId], {
			timeout: 10000,
		});
	} catch {
		// Pane may already have exited; cleanup remains best-effort.
	}
}

async function runHerdrProcess(options: RunHerdrProcessOptions): Promise<{
	result: HerdrRunResult | null;
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

	if (options.sandbox) {
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
			stderr:
				'herdr backend does not support per-subagent OS sandbox in this build; choose backend "headless".\n',
		};
	}

	if (!(await herdrAvailable())) {
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
				'herdr is not available (no server reachable); install/start herdr or choose backend "headless".\n',
		};
	}

	const eventPath = join(store.taskDir, "pi-events.jsonl");
	const stderrPath = store.pathFor("stderr");
	const metaPath = join(store.taskDir, "herdr-worker-meta.json");
	const scriptPath = join(store.taskDir, "herdr-worker.mjs");

	await writeFile(
		scriptPath,
		workerScript(argv, cwd, eventPath, stderrPath, metaPath),
	);

	const label = `pi-subagent-${store.runId}`.replace(/[^A-Za-z0-9_-]/g, "-");
	let workspace: HerdrWorkspace | null = null;
	try {
		workspace = await createHerdrWorkspace(cwd, label);
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
			stderr: error instanceof Error ? `${error.message}\n` : `${String(error)}\n`,
		};
	}

	// Give the fresh pane shell a moment to be ready before typing the command.
	await sleep(500);

	try {
		// Run node <worker.mjs> directly in the pane (no bash wrapper needed).
		await paneRunCommand(workspace.paneId, [
			process.execPath,
			scriptPath,
		]);
	} catch (error) {
		await closePane(workspace.paneId);
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
			stderr: error instanceof Error ? `${error.message}\n` : `${String(error)}\n`,
		};
	}

	const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
	let stopKind: "timeout" | "abort" | null = null;

	while (true) {
		const meta = await readWorkerMeta(metaPath);
		if (meta !== undefined) {
			await closePane(workspace.paneId);
			return {
				result: {
					meta,
					stderrRef: store.refFor("stderr", await pathBytes(stderrPath)),
					eventPath,
					herdr: {
						workspaceId: workspace.workspaceId,
						tabId: workspace.tabId,
						paneId: workspace.paneId,
					},
				},
				store,
				cwd,
				artifactCwd,
				startedAt,
			};
		}

		if (options.signal?.aborted) stopKind = "abort";
		if (deadline !== undefined && Date.now() >= deadline) stopKind = "timeout";
		if (stopKind !== null) {
			await closePane(workspace.paneId);
			return {
				result: {
					meta: {
						status: stopKind === "abort" ? "cancelled" : "failed",
						failureKind: stopKind,
						exitCode: null,
						signal: "SIGTERM",
					},
					stderrRef: store.refFor("stderr", await pathBytes(stderrPath)),
					eventPath,
					herdr: {
						workspaceId: workspace.workspaceId,
						tabId: workspace.tabId,
						paneId: workspace.paneId,
					},
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

export async function runHerdrModel(
	options: RunHerdrModelOptions,
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
		await runHerdrProcess({ ...options, argv: buildPiArgv(options) });
	if (result === null) {
		const artifacts: ArtifactRef[] = [
			await store.writeTextArtifact("stderr", stderr ?? ""),
			await store.writeTextArtifact("output", ""),
		];
		return await store.writeResult({
			backend: "herdr",
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
		backend: "herdr",
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
		herdr: result.herdr,
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
