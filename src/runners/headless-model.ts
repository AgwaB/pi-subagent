import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { realpath, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { buildAgentSystemPrompt, type AgentDefinition } from "../agents.ts";
import {
	createAttemptArtifactStore,
	type ArtifactRef,
	type ProcessMetadata,
	type ResultEnvelope,
	type ResultMetadata,
} from "../artifacts/index.ts";
import type { ResultWorkspace } from "../artifacts/result.ts";
import type {
	AgentScope,
	FailureKind,
	SandboxInput,
	Status,
	ThinkingLevel,
} from "../core/constants.ts";
import { sandboxAllowedDomains } from "../core/constants.ts";
import { SandboxUnavailableError, withSandboxedArgv } from "../sandbox/srt.ts";
import {
	flushToolCallTelemetry,
	ToolCallTelemetryCollector,
} from "./tool-call-telemetry.ts";

export interface RunHeadlessModelOptions {
	agent: string;
	task: string;
	roleContext?: string;
	agentScope?: AgentScope;
	confirmProjectAgents?: boolean;
	cwd?: string;
	artifactCwd?: string;
	runId?: string;
	attemptId?: string;
	runsDir?: string;
	correlationId?: string;
	parentSessionId?: string;
	sessionId?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	piCommand?: string;
	sandbox?: SandboxInput | false | null;
	workspace?: Partial<ResultWorkspace>;
	model?: string;
	thinking?: ThinkingLevel;
	tools?: string[];
	systemPrompt?: string;
	skills?: string[];
	extensions?: string[];
	agentDefinition?: AgentDefinition;
	captureToolCalls?: boolean;
	onProcessStart?: (process: ProcessMetadata) => void | Promise<void>;
}

export interface ProcessOutcome {
	status: Status;
	failureKind: FailureKind | null;
	exitCode: number | null;
	signal: string | null;
}

interface ProcessResult {
	outcome: ProcessOutcome;
	stderrRef: ArtifactRef;
	toolCallArtifactRefs: ArtifactRef[];
	parsed: PiJsonParseResult;
	stderrText: string;
	stderrContextLengthExceeded: boolean;
}

export interface PiJsonParseResult {
	finalAssistantText: string;
	errors: string[];
	parseErrors: string[];
	metadata: Partial<ResultMetadata>;
}

export interface ContextLengthResolution {
	rawContextLengthExceeded: boolean;
	contextLengthExceeded: boolean;
	contextOverflowRecovered: boolean;
	recoveredStreamErrors: string[];
}

const CONTEXT_LENGTH_ERROR_PATTERN =
	/\bcontext[_ -]?length[_ -]?exceeded\b|\bcontext[_ -]?window[_ -]?(?:exceeded|overflow|exhausted)\b|\b(?:maximum|max)[_ -]?context[_ -]?length\b|\btoo many tokens\b|\b(?:prompt|input|request)[^\n]{0,80}\btoo large\b|\bcontext_length_exceeded\b/i;

export function detectContextLengthExceeded(signals: {
	stderrText?: string;
	errors?: readonly string[];
}): boolean {
	const text = [signals.stderrText, ...(signals.errors ?? [])]
		.filter(
			(entry): entry is string => typeof entry === "string" && entry.length > 0,
		)
		.join("\n");
	return CONTEXT_LENGTH_ERROR_PATTERN.test(text);
}

export function resolveContextLengthState(
	parsed: PiJsonParseResult,
	rawContextLengthExceeded: boolean,
): ContextLengthResolution {
	const contextOverflowRecovered =
		rawContextLengthExceeded && finalAssistantSucceeded(parsed);
	return {
		rawContextLengthExceeded,
		contextLengthExceeded:
			rawContextLengthExceeded && !contextOverflowRecovered,
		contextOverflowRecovered,
		recoveredStreamErrors: contextOverflowRecovered
			? parsed.errors.filter((error) =>
					detectContextLengthExceeded({ errors: [error] }),
				)
			: [],
	};
}

function finalAssistantSucceeded(parsed: PiJsonParseResult): boolean {
	return (
		parsed.finalAssistantText.length > 0 &&
		parsed.metadata.stopReason !== "error"
	);
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

type SessionManagerModule = {
	SessionManager?: {
		list?: (cwd: string) => Promise<Array<{ id: string }>>;
	};
};

export async function resultSessionMetadata(
	cwd: string,
	sessionId: string | undefined,
): Promise<Partial<ResultMetadata>> {
	if (sessionId === undefined) {
		return { session: { requested: false, disposition: "ephemeral" } };
	}

	try {
		const sessionCwd = await realpath(cwd).catch(() => cwd);
		const mod = (await import(
			"@earendil-works/pi-coding-agent"
		)) as SessionManagerModule;
		if (typeof mod.SessionManager?.list !== "function") {
			return {
				sessionId,
				session: {
					id: sessionId,
					requested: true,
					disposition: "unavailable",
					reason: "resume_unsupported",
				},
			};
		}
		const sessions = await mod.SessionManager.list(sessionCwd);
		return {
			sessionId,
			session: {
				id: sessionId,
				requested: true,
				disposition: sessions.some((session) => session.id === sessionId)
					? "resumed"
					: "created",
			},
		};
	} catch {
		return {
			sessionId,
			session: {
				id: sessionId,
				requested: true,
				disposition: "unavailable",
				reason: "session_store_error",
			},
		};
	}
}

function toBuffer(chunk: Buffer | string): Buffer {
	return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

function textFromContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (
				typeof part === "object" &&
				part !== null &&
				"type" in part &&
				"text" in part
			) {
				const record = part as { type?: unknown; text?: unknown };
				if (record.type === "text" && typeof record.text === "string")
					return record.text;
			}
			return "";
		})
		.join("");
}

function errorText(value: unknown): string | undefined {
	if (typeof value === "string" && value.length > 0) return value;
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		if (typeof record.message === "string" && record.message.length > 0)
			return record.message;
		if (typeof record.error === "string" && record.error.length > 0)
			return record.error;
	}
	return undefined;
}

const PARSED_EVENT_PATTERN =
	/"type"\s*:\s*"(?:message_end|turn_end|agent_end|error)"/;
const TOOL_CALL_EVENT_PATTERN =
	/"type"\s*:\s*"(?:tool_execution_start|tool_execution_end)"/;
const MAX_PARSE_ERRORS = 20;
const MAX_METADATA_ERRORS = 20;
const MAX_JSON_LINE_CHARS = 64 * 1024 * 1024;
const STDERR_TEXT_LIMIT = 256 * 1024;

function emptyParseResult(): PiJsonParseResult {
	return { finalAssistantText: "", errors: [], parseErrors: [], metadata: {} };
}

function pushParseError(parsed: PiJsonParseResult, message: string): void {
	if (parsed.parseErrors.length < MAX_PARSE_ERRORS)
		parsed.parseErrors.push(message);
}

function parsePiJsonLine(
	line: string,
	lineNumber: number,
	parsed: PiJsonParseResult,
	onEvent?: (event: unknown) => void,
): void {
	if (line.trim().length === 0) return;
	if (
		!PARSED_EVENT_PATTERN.test(line) &&
		(onEvent === undefined || !TOOL_CALL_EVENT_PATTERN.test(line))
	)
		return;
	if (line.length > MAX_JSON_LINE_CHARS) {
		pushParseError(
			parsed,
			`line ${lineNumber}: JSON event too large to parse (${line.length} chars)`,
		);
		return;
	}

	let event: unknown;
	try {
		event = JSON.parse(line);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		pushParseError(parsed, `line ${lineNumber}: ${message}`);
		return;
	}

	onEvent?.(event);

	if (typeof event !== "object" || event === null) return;
	const record = event as Record<string, unknown>;
	const type = record.type;

	if (type === "message_end" || type === "turn_end") {
		const message = record.message;
		if (
			typeof message === "object" &&
			message !== null &&
			(message as Record<string, unknown>).role === "assistant"
		) {
			const assistant = message as Record<string, unknown>;
			parsed.finalAssistantText = textFromContent(assistant.content);
			if (typeof assistant.provider === "string")
				parsed.metadata.provider = assistant.provider;
			if (typeof assistant.model === "string")
				parsed.metadata.model = assistant.model;
			if (assistant.usage !== undefined)
				parsed.metadata.usage = assistant.usage;
			if (typeof assistant.stopReason === "string")
				parsed.metadata.stopReason = assistant.stopReason;
			if (assistant.stopReason === "error") {
				const text =
					errorText(assistant.errorMessage) ??
					errorText(assistant.error) ??
					"assistant stopped with an error";
				parsed.errors.push(text);
			}
		}
	} else if (type === "agent_end") {
		const messages = record.messages;
		if (Array.isArray(messages)) {
			for (const message of messages) {
				if (
					typeof message === "object" &&
					message !== null &&
					(message as Record<string, unknown>).role === "assistant"
				) {
					const text = textFromContent(
						(message as Record<string, unknown>).content,
					);
					if (text.length > 0) parsed.finalAssistantText = text;
				}
			}
		}
	}

	if (type === "error") {
		const text =
			errorText(record.error) ?? errorText(record.message) ?? errorText(record);
		if (text) parsed.errors.push(text);
	}
}

class PiJsonStreamParser {
	readonly parsed = emptyParseResult();
	private buffered = "";
	private lineNumber = 0;
	private discardingOversizedLine = false;
	private readonly onEvent?: (event: unknown) => void;

	constructor(onEvent?: (event: unknown) => void) {
		this.onEvent = onEvent;
	}

	push(chunk: Buffer | string): void {
		let text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
		while (text.length > 0) {
			if (this.discardingOversizedLine) {
				const newline = text.indexOf("\n");
				if (newline < 0) return;
				this.discardingOversizedLine = false;
				this.buffered = "";
				text = text.slice(newline + 1);
				continue;
			}

			const newline = text.indexOf("\n");
			const segment = newline < 0 ? text : text.slice(0, newline + 1);
			this.buffered += segment;
			text = newline < 0 ? "" : text.slice(newline + 1);

			if (this.buffered.length > MAX_JSON_LINE_CHARS) {
				this.lineNumber += 1;
				pushParseError(
					this.parsed,
					`line ${this.lineNumber}: JSON event too large to parse`,
				);
				this.buffered = "";
				this.discardingOversizedLine = newline < 0;
				continue;
			}

			if (newline >= 0) this.flushLine();
		}
	}

	finish(): PiJsonParseResult {
		if (!this.discardingOversizedLine && this.buffered.length > 0)
			this.flushLine();
		return this.parsed;
	}

	private flushLine(): void {
		this.lineNumber += 1;
		const line = this.buffered.endsWith("\n")
			? this.buffered.slice(0, -1).replace(/\r$/, "")
			: this.buffered;
		this.buffered = "";
		parsePiJsonLine(line, this.lineNumber, this.parsed, this.onEvent);
	}
}

export function parsePiJsonLines(stdout: string): PiJsonParseResult {
	const parser = new PiJsonStreamParser();
	parser.push(stdout);
	return parser.finish();
}

export async function parsePiJsonFile(
	path: string,
): Promise<PiJsonParseResult> {
	const parser = new PiJsonStreamParser();
	const stream = createReadStream(path, { encoding: "utf8" });
	for await (const chunk of stream) parser.push(chunk);
	return parser.finish();
}

export function resolvePiJsonOutcome(
	processOutcome: ProcessOutcome,
	parsed: PiJsonParseResult,
	contextLengthExceeded: boolean,
): ProcessOutcome {
	if (processOutcome.status !== "completed") return processOutcome;
	if (parsed.parseErrors.length > 0 && parsed.finalAssistantText.length === 0) {
		return { ...processOutcome, status: "failed", failureKind: "parse" };
	}
	if (
		parsed.errors.length > 0 &&
		parsedErrorsAreFatal(parsed, contextLengthExceeded)
	) {
		return { ...processOutcome, status: "failed", failureKind: "model" };
	}
	return processOutcome;
}

export function resultMetadataFromParse(
	parsed: PiJsonParseResult,
	contextLength: ContextLengthResolution,
	outcome: ProcessOutcome,
): Partial<ResultMetadata> {
	return {
		...parsed.metadata,
		contextLengthExceeded: contextLength.contextLengthExceeded,
		...(contextLength.contextOverflowRecovered
			? { contextOverflowRecovered: true }
			: {}),
		...(parsed.errors.length === 0
			? {}
			: { streamErrors: parsed.errors.slice(0, MAX_METADATA_ERRORS) }),
		...(outcome.status === "completed" && parsed.errors.length > 0
			? { nonFatalStreamErrors: parsed.errors.slice(0, MAX_METADATA_ERRORS) }
			: {}),
		...(contextLength.recoveredStreamErrors.length === 0
			? {}
			: {
					recoveredStreamErrors: contextLength.recoveredStreamErrors.slice(
						0,
						MAX_METADATA_ERRORS,
					),
				}),
		...(parsed.parseErrors.length === 0
			? {}
			: { parseErrors: parsed.parseErrors.slice(0, MAX_METADATA_ERRORS) }),
	};
}

function parsedErrorsAreFatal(
	parsed: PiJsonParseResult,
	contextLengthExceeded: boolean,
): boolean {
	return (
		parsed.finalAssistantText.length === 0 ||
		parsed.metadata.stopReason === "error" ||
		contextLengthExceeded
	);
}

function buildPrompt(options: RunHeadlessModelOptions): string {
	if (options.systemPrompt !== undefined) return options.task;
	const sections = [
		`You are the Pi subagent named ${JSON.stringify(options.agent)}.`,
		options.roleContext ? `Role context:\n${options.roleContext}` : undefined,
		options.agentScope ? `Agent scope: ${options.agentScope}` : undefined,
		options.confirmProjectAgents === undefined
			? undefined
			: `confirmProjectAgents: ${String(options.confirmProjectAgents)}`,
		`Task:\n${options.task}`,
	];
	return sections
		.filter((section): section is string => section !== undefined)
		.join("\n\n");
}

export function buildPiArgv(
	options: RunHeadlessModelOptions,
): readonly [string, ...string[]] {
	const argv: string[] = [
		options.piCommand ?? "pi",
		"--mode",
		"json",
		"--print",
	];
	if (options.sessionId !== undefined) {
		argv.push("--session-id", options.sessionId);
	} else {
		argv.push("--no-session");
	}
	argv.push("--no-context-files", "--exclude-tools", "subagent");
	const model = options.model ?? options.agentDefinition?.model;
	const thinking = options.thinking ?? options.agentDefinition?.thinking;
	const tools = options.tools ?? options.agentDefinition?.tools;
	const agentSystemPrompt =
		options.systemPrompt !== undefined
			? undefined
			: options.agentDefinition === undefined
				? undefined
				: buildAgentSystemPrompt(options.agentDefinition);

	if (options.systemPrompt !== undefined) {
		argv.push("--system-prompt", options.systemPrompt);
	} else if (agentSystemPrompt !== undefined) {
		argv.push(
			options.agentDefinition?.systemPromptMode === "replace"
				? "--system-prompt"
				: "--append-system-prompt",
			agentSystemPrompt,
		);
	}
	if (model !== undefined) argv.push("--model", model);
	if (thinking !== undefined) argv.push("--thinking", thinking);
	if (tools !== undefined && tools.length > 0)
		argv.push("--tools", tools.join(","));
	else if (tools !== undefined) argv.push("--no-tools");
	if (options.skills !== undefined && options.skills.length === 0)
		argv.push("--no-skills");
	else for (const skill of options.skills ?? []) argv.push("--skill", skill);
	if (options.extensions !== undefined && options.extensions.length === 0)
		argv.push("--no-extensions");
	else
		for (const extension of options.extensions ?? [])
			argv.push("--extension", extension);
	argv.push(buildPrompt(options));
	return argv as [string, ...string[]];
}

async function fileBytes(path: string): Promise<number> {
	try {
		return (await stat(path)).size;
	} catch {
		return 0;
	}
}

function appendLimited(base: string, chunk: string, limit: number): string {
	if (base.length >= limit) return base;
	return base + chunk.slice(0, limit - base.length);
}

async function runProcess(
	argv: readonly [string, ...string[]],
	cwd: string,
	timeoutMs: number | undefined,
	store: Awaited<ReturnType<typeof createAttemptArtifactStore>>,
	captureToolCalls?: boolean,
	abortSignal?: AbortSignal,
	env?: NodeJS.ProcessEnv,
	onProcessStart?: (process: ProcessMetadata) => void | Promise<void>,
): Promise<ProcessResult> {
	const stderrPath = store.pathFor("stderr");
	await writeFile(stderrPath, "");

	const toolCallTelemetry =
		captureToolCalls === true ? new ToolCallTelemetryCollector() : undefined;
	const parser = new PiJsonStreamParser((event) =>
		toolCallTelemetry?.processEvent(event),
	);
	const stderrStream = createWriteStream(stderrPath, { flags: "w" });
	let stderrText = "";
	let stderrContextLengthExceeded = false;

	async function finishWith(outcome: ProcessOutcome): Promise<ProcessResult> {
		stderrStream.end();
		await once(stderrStream, "finish");
		const parsed = parser.finish();
		return {
			outcome,
			stderrRef: store.refFor("stderr", await fileBytes(stderrPath)),
			toolCallArtifactRefs: await flushToolCallTelemetry(
				toolCallTelemetry,
				store,
			),
			parsed,
			stderrText,
			stderrContextLengthExceeded,
		};
	}

	if (abortSignal?.aborted) {
		return await finishWith({
			status: "cancelled",
			failureKind: "abort",
			exitCode: null,
			signal: null,
		});
	}

	return await new Promise<ProcessResult>((resolveProcess) => {
		const child = spawn(argv[0], argv.slice(1), {
			cwd,
			shell: false,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
			...(env === undefined ? {} : { env }),
		});

		if (child.pid !== undefined) {
			void Promise.resolve(
				onProcessStart?.({
					pid: child.pid,
					processGroupId: process.platform === "win32" ? undefined : child.pid,
					command: argv[0],
				}),
			).catch(() => undefined);
		}

		let settled = false;
		let stopKind: "timeout" | "abort" | null = null;
		let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
		let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

		function clearTimers(): void {
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			timeoutTimer = null;
			forceKillTimer = null;
		}

		function cleanup(): void {
			clearTimers();
			abortSignal?.removeEventListener("abort", onAbort);
		}

		function signalChild(signal: NodeJS.Signals): void {
			try {
				if (child.pid !== undefined && process.platform !== "win32")
					process.kill(-child.pid, signal);
				else child.kill(signal);
			} catch {
				try {
					child.kill(signal);
				} catch {
					/* already exited */
				}
			}
		}

		function requestStop(kind: "timeout" | "abort"): void {
			if (settled) return;
			stopKind ??= kind;
			signalChild("SIGTERM");
			forceKillTimer ??= setTimeout(() => {
				signalChild("SIGKILL");
			}, 1_000);
		}

		function onAbort(): void {
			requestStop("abort");
		}

		function settle(outcome: ProcessOutcome): void {
			if (settled) return;
			settled = true;
			cleanup();
			void finishWith(outcome).then(resolveProcess, () =>
				resolveProcess({
					outcome: {
						status: "failed",
						failureKind: "internal",
						exitCode: null,
						signal: null,
					},
					stderrRef: store.refFor("stderr", 0),
					toolCallArtifactRefs: [],
					parsed: parser.finish(),
					stderrText,
					stderrContextLengthExceeded,
				}),
			);
		}

		child.stdout?.on("data", (chunk: Buffer | string) => {
			parser.push(toBuffer(chunk));
		});

		child.stderr?.on("data", (chunk: Buffer | string) => {
			const buffer = toBuffer(chunk);
			const text = buffer.toString("utf8");
			stderrText = appendLimited(stderrText, text, STDERR_TEXT_LIMIT);
			stderrContextLengthExceeded ||= detectContextLengthExceeded({
				stderrText: text,
			});
			if (!stderrStream.write(buffer)) {
				child.stderr?.pause();
				stderrStream.once("drain", () => child.stderr?.resume());
			}
		});

		child.on("error", () => {
			settle({
				status: "failed",
				failureKind: "spawn",
				exitCode: null,
				signal: null,
			});
		});

		child.on("close", (exitCode, signal) => {
			if (stopKind === null && signal !== null) {
				settle({
					status: "cancelled",
					failureKind: "cancelled",
					exitCode,
					signal,
				});
				return;
			}
			const failureKind = stopKind ?? (exitCode === 0 ? null : "model");
			settle({
				status:
					failureKind === null
						? "completed"
						: failureKind === "abort"
							? "cancelled"
							: "failed",
				failureKind,
				exitCode,
				signal,
			});
		});

		if (timeoutMs !== undefined) {
			timeoutTimer = setTimeout(() => {
				requestStop("timeout");
			}, timeoutMs);
		}

		abortSignal?.addEventListener("abort", onAbort, { once: true });
		if (abortSignal?.aborted) requestStop("abort");
	});
}

export async function runHeadlessModel(
	options: RunHeadlessModelOptions,
): Promise<ResultEnvelope> {
	if (typeof options.agent !== "string" || options.agent.length === 0) {
		throw new Error("agent must be a non-empty string.");
	}
	if (typeof options.task !== "string" || options.task.length === 0) {
		throw new Error("task must be a non-empty string.");
	}

	const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
	const cwd = resolve(options.cwd ?? process.cwd());
	const artifactCwd = resolve(options.artifactCwd ?? cwd);
	const sessionMetadata = await resultSessionMetadata(cwd, options.sessionId);
	const startedAt = new Date();
	const store = await createAttemptArtifactStore({
		cwd: artifactCwd,
		runId: options.runId,
		attemptId: options.attemptId,
		runsDir: options.runsDir,
	});
	const argv = buildPiArgv(options);
	let processResult: ProcessResult;
	try {
		processResult = options.sandbox
			? await withSandboxedArgv(
					argv,
					{
						sandbox: options.sandbox,
						cwd,
						writablePaths: [store.taskDir],
						signal: options.signal,
					},
					(launch) =>
						runProcess(
							launch.argv,
							cwd,
							timeoutMs,
							store,
							options.captureToolCalls,
							options.signal,
							launch.env,
							options.onProcessStart,
						),
				)
			: await runProcess(
					argv,
					cwd,
					timeoutMs,
					store,
					options.captureToolCalls,
					options.signal,
					undefined,
					options.onProcessStart,
				);
	} catch (error) {
		if (!(error instanceof SandboxUnavailableError)) throw error;
		const stderrRef = await store.writeTextArtifact(
			"stderr",
			`${error.message}\n`,
		);
		processResult = {
			outcome: {
				status: "failed",
				failureKind: "sandbox",
				exitCode: null,
				signal: null,
			},
			stderrRef,
			toolCallArtifactRefs: [],
			parsed: emptyParseResult(),
			stderrText: `${error.message}\n`,
			stderrContextLengthExceeded: detectContextLengthExceeded({
				stderrText: error.message,
			}),
		};
	}

	const {
		outcome: processOutcome,
		stderrRef,
		toolCallArtifactRefs,
		parsed,
		stderrText,
		stderrContextLengthExceeded,
	} = processResult;
	const rawContextLengthExceeded =
		stderrContextLengthExceeded ||
		detectContextLengthExceeded({ stderrText, errors: parsed.errors });
	const contextLength = resolveContextLengthState(
		parsed,
		rawContextLengthExceeded,
	);

	const outcome = resolvePiJsonOutcome(
		processOutcome,
		parsed,
		contextLength.contextLengthExceeded,
	);

	const completedAt = new Date();
	const outputText = parsed.finalAssistantText;
	const artifacts: ArtifactRef[] = [
		stderrRef,
		await store.writeTextArtifact("output", outputText),
		...toolCallArtifactRefs,
	];

	return await store.writeResult({
		backend: "headless",
		status: outcome.status,
		failureKind: outcome.failureKind,
		cwd: artifactCwd,
		startedAt,
		completedAt,
		workspace: options.workspace ?? { mode: "shared", cwd },
		sandbox: options.sandbox
			? {
					enabled: true,
					allowedDomains: sandboxAllowedDomains(options.sandbox),
				}
			: { enabled: false },
		exitCode: outcome.exitCode,
		signal: outcome.signal,
		artifacts,
		correlationId: options.correlationId,
		metadata: {
			...resultMetadataFromParse(parsed, contextLength, outcome),
			...sessionMetadata,
			...(options.parentSessionId === undefined
				? {}
				: { parentSessionId: options.parentSessionId }),
		},
	});
}
