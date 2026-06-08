import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { buildAgentSystemPrompt, type AgentDefinition } from "../agents.ts";
import { createTaskArtifactStore, type ArtifactRef, type ProcessMetadata, type ResultEnvelope } from "../artifacts/index.ts";
import type { ResultWorkspace } from "../artifacts/result.ts";
import type { AgentScope, FailureKind, SandboxInput, Status, ThinkingLevel } from "../core/constants.ts";
import { SandboxUnavailableError, withSandboxedArgv } from "../sandbox/srt.ts";

export interface RunHeadlessModelOptions {
  agent: string;
  task: string;
  roleContext?: string;
  agentScope?: AgentScope;
  confirmProjectAgents?: boolean;
  cwd?: string;
  artifactCwd?: string;
  runId?: string;
  taskId?: string;
  runsDir?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  piCommand?: string;
  sandbox?: SandboxInput | null;
  workspace?: Partial<ResultWorkspace>;
  model?: string;
  thinking?: ThinkingLevel;
  tools?: string[];
  agentDefinition?: AgentDefinition;
  onProcessStart?: (process: ProcessMetadata) => void | Promise<void>;
}

interface ProcessOutcome {
  status: Status;
  failureKind: FailureKind | null;
  exitCode: number | null;
  signal: string | null;
}

interface ProcessResult {
  outcome: ProcessOutcome;
  stdout: Buffer;
  stderr: Buffer;
}

export interface PiJsonParseResult {
  finalAssistantText: string;
  errors: string[];
  parseErrors: string[];
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) return undefined;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive finite number when provided.");
  }
  return timeoutMs;
}

function toBuffer(chunk: Buffer | string): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "object" && part !== null && "type" in part && "text" in part) {
        const record = part as { type?: unknown; text?: unknown };
        if (record.type === "text" && typeof record.text === "string") return record.text;
      }
      return "";
    })
    .join("");
}

function errorText(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.length > 0) return record.message;
    if (typeof record.error === "string" && record.error.length > 0) return record.error;
  }
  return undefined;
}

export function parsePiJsonLines(stdout: string): PiJsonParseResult {
  let finalAssistantText = "";
  const errors: string[] = [];
  const parseErrors: string[] = [];

  for (const [index, line] of stdout.split(/\r?\n/).entries()) {
    if (line.trim().length === 0) continue;

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      parseErrors.push(`line ${index + 1}: ${message}`);
      continue;
    }

    if (typeof event !== "object" || event === null) continue;
    const record = event as Record<string, unknown>;
    const type = record.type;

    if (type === "message_end" || type === "turn_end") {
      const message = record.message;
      if (typeof message === "object" && message !== null && (message as Record<string, unknown>).role === "assistant") {
        const assistant = message as Record<string, unknown>;
        finalAssistantText = textFromContent(assistant.content);
        if (assistant.stopReason === "error") {
          const text = errorText(assistant.errorMessage) ?? errorText(assistant.error) ?? "assistant stopped with an error";
          errors.push(text);
        }
      }
    } else if (type === "agent_end") {
      const messages = record.messages;
      if (Array.isArray(messages)) {
        for (const message of messages) {
          if (typeof message === "object" && message !== null && (message as Record<string, unknown>).role === "assistant") {
            const text = textFromContent((message as Record<string, unknown>).content);
            if (text.length > 0) finalAssistantText = text;
          }
        }
      }
    }

    if (type === "error") {
      const text = errorText(record.error) ?? errorText(record.message) ?? errorText(record);
      if (text) errors.push(text);
    }
  }

  return { finalAssistantText, errors, parseErrors };
}

function buildPrompt(options: RunHeadlessModelOptions): string {
  const sections = [
    `You are the Pi subagent named ${JSON.stringify(options.agent)}.`,
    options.roleContext ? `Role context:\n${options.roleContext}` : undefined,
    options.agentScope ? `Agent scope: ${options.agentScope}` : undefined,
    options.confirmProjectAgents === undefined ? undefined : `confirmProjectAgents: ${String(options.confirmProjectAgents)}`,
    `Task:\n${options.task}`,
  ];
  return sections.filter((section): section is string => section !== undefined).join("\n\n");
}

export function buildPiArgv(options: RunHeadlessModelOptions): readonly [string, ...string[]] {
  const argv: string[] = [
    options.piCommand ?? "pi",
    "--mode",
    "json",
    "--print",
    "--no-session",
    "--no-context-files",
    "--no-extensions",
    "--no-skills",
  ];
  const model = options.model ?? options.agentDefinition?.model;
  const thinking = options.thinking ?? options.agentDefinition?.thinking;
  const tools = options.agentDefinition !== undefined ? options.agentDefinition.tools : options.tools;
  const agentSystemPrompt = options.agentDefinition === undefined ? undefined : buildAgentSystemPrompt(options.agentDefinition);

  if (agentSystemPrompt !== undefined) {
    argv.push(options.agentDefinition?.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt", agentSystemPrompt);
  }
  if (model !== undefined) argv.push("--model", model);
  if (thinking !== undefined) argv.push("--thinking", thinking);
  if (tools !== undefined && tools.length > 0) argv.push("--tools", tools.join(","));
  else if (tools !== undefined) argv.push("--no-tools");
  argv.push(buildPrompt(options));
  return argv as [string, ...string[]];
}

async function runProcess(
  argv: readonly [string, ...string[]],
  cwd: string,
  timeoutMs: number | undefined,
  abortSignal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
  onProcessStart?: (process: ProcessMetadata) => void | Promise<void>,
): Promise<ProcessResult> {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  if (abortSignal?.aborted) {
    return {
      outcome: { status: "failed", failureKind: "abort", exitCode: null, signal: null },
      stdout: Buffer.concat(stdoutChunks),
      stderr: Buffer.concat(stderrChunks),
    };
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
      void Promise.resolve(onProcessStart?.({ pid: child.pid, processGroupId: process.platform === "win32" ? undefined : child.pid, command: argv[0] })).catch(() => undefined);
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
        if (child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        try { child.kill(signal); } catch { /* already exited */ }
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
      resolveProcess({ outcome, stdout: Buffer.concat(stdoutChunks), stderr: Buffer.concat(stderrChunks) });
    }

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdoutChunks.push(toBuffer(chunk));
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(toBuffer(chunk));
    });

    child.on("error", () => {
      settle({ status: "failed", failureKind: "spawn", exitCode: null, signal: null });
    });

    child.on("close", (exitCode, signal) => {
      if (stopKind === null && signal !== null) {
        settle({ status: "cancelled", failureKind: "cancelled", exitCode, signal });
        return;
      }
      const failureKind = stopKind ?? (exitCode === 0 ? null : "model");
      settle({ status: failureKind === null ? "completed" : "failed", failureKind, exitCode, signal });
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

export async function runHeadlessModel(options: RunHeadlessModelOptions): Promise<ResultEnvelope> {
  if (typeof options.agent !== "string" || options.agent.length === 0) {
    throw new Error("agent must be a non-empty string.");
  }
  if (typeof options.task !== "string" || options.task.length === 0) {
    throw new Error("task must be a non-empty string.");
  }

  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const cwd = resolve(options.cwd ?? process.cwd());
  const artifactCwd = resolve(options.artifactCwd ?? cwd);
  const startedAt = new Date();
  const store = await createTaskArtifactStore({ cwd: artifactCwd, runId: options.runId, taskId: options.taskId, runsDir: options.runsDir });
  const argv = buildPiArgv(options);
  let processResult: ProcessResult;
  try {
    processResult = options.sandbox
      ? await withSandboxedArgv(argv, { sandbox: options.sandbox, cwd, writablePaths: [store.taskDir], signal: options.signal }, (launch) =>
          runProcess(launch.argv, cwd, timeoutMs, options.signal, launch.env, options.onProcessStart),
        )
      : await runProcess(argv, cwd, timeoutMs, options.signal, undefined, options.onProcessStart);
  } catch (error) {
    if (!(error instanceof SandboxUnavailableError)) throw error;
    processResult = {
      outcome: { status: "failed", failureKind: "sandbox", exitCode: null, signal: null },
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(`${error.message}\n`),
    };
  }

  const { outcome: processOutcome, stdout, stderr } = processResult;
  const stdoutText = stdout.toString("utf8");
  const stderrText = stderr.toString("utf8");
  const parsed = parsePiJsonLines(stdoutText);

  let outcome = processOutcome;
  if (processOutcome.status === "completed" && parsed.parseErrors.length > 0 && parsed.finalAssistantText.length === 0) {
    outcome = { ...processOutcome, status: "failed", failureKind: "parse" };
  } else if (processOutcome.status === "completed" && parsed.errors.length > 0) {
    outcome = { ...processOutcome, status: "failed", failureKind: "model" };
  }

  const completedAt = new Date();
  const outputText = parsed.finalAssistantText;
  const artifacts: ArtifactRef[] = [
    await store.writeTextArtifact("stdout", stdout),
    await store.writeTextArtifact("stderr", stderr),
    await store.writeTextArtifact("output", outputText),
  ];

  return await store.writeResult({
    backend: "headless",
    status: outcome.status,
    failureKind: outcome.failureKind,
    cwd: artifactCwd,
    startedAt,
    completedAt,
    workspace: options.workspace ?? { mode: "shared", cwd },
    sandbox: options.sandbox ? { enabled: true } : { enabled: false },
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    artifacts,
  });
}
