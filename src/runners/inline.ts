import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildAgentSystemPrompt, type AgentDefinition } from "../agents.ts";
import { createAttemptArtifactStore, type ArtifactRef, type ResultEnvelope } from "../artifacts/index.ts";
import type { ResultWorkspace } from "../artifacts/result.ts";
import { THINKING_LEVELS, type AgentScope, type FailureKind, type ThinkingLevel } from "../core/constants.ts";
import { detectContextLengthExceeded } from "./headless-model.ts";
import { flushToolCallTelemetry, ToolCallTelemetryCollector } from "./tool-call-telemetry.ts";

export interface RunInlineModelOptions {
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
  timeoutMs?: number;
  signal?: AbortSignal;
  workspace?: Partial<ResultWorkspace>;
  model?: string;
  thinking?: ThinkingLevel;
  tools?: string[];
  systemPrompt?: string;
  skills?: string[];
  extensions?: string[];
  captureToolCalls?: boolean;
  agentDefinition?: AgentDefinition;
}

interface PiSdkModule {
  AuthStorage: { create(): unknown };
  ModelRegistry: { create(authStorage: unknown): ModelRegistryLike };
  SessionManager: { inMemory(cwd?: string): unknown };
  createAgentSession(options: Record<string, unknown>): Promise<{ session: AgentSessionLike; diagnostics?: unknown[] }>;
  createExtensionRuntime?: () => unknown;
}

interface ModelLike {
  provider?: string;
  id?: string;
}

interface ModelRegistryLike {
  reload?: () => Promise<void>;
  getAvailable?: () => ModelLike[];
  getModels?: () => ModelLike[];
  find?: (provider: string, modelId: string) => ModelLike | undefined;
}

interface AgentSessionLike {
  prompt(text: string): Promise<void>;
  subscribe?: (listener: (event: unknown) => void) => () => void;
  abort?: () => Promise<void>;
  dispose?: () => void;
  messages?: unknown[];
}

interface SdkImportResult {
  module: PiSdkModule;
  source: string;
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) return undefined;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive finite number when provided.");
  }
  return timeoutMs;
}

function findPackageRoot(startPath: string, packageName: string): string | undefined {
  let current = fs.statSync(startPath).isDirectory() ? startPath : dirname(startPath);
  while (current !== dirname(current)) {
    const packageJsonPath = join(current, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { name?: unknown };
        if (parsed.name === packageName) return current;
      } catch {
        // Keep walking.
      }
    }
    current = dirname(current);
  }
  return undefined;
}

async function importPiSdk(): Promise<SdkImportResult> {
  try {
    const require = createRequire(import.meta.url);
    const packageJson = require.resolve("@earendil-works/pi-coding-agent/package.json");
    return {
      module: (await import("@earendil-works/pi-coding-agent")) as PiSdkModule,
      source: dirname(packageJson),
    };
  } catch (projectError) {
    let piBin: string;
    try {
      piBin = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
    } catch {
      const message = projectError instanceof Error ? projectError.message : String(projectError);
      throw new Error(`Could not import @earendil-works/pi-coding-agent and could not find pi on PATH. Project import error: ${message}`);
    }

    const realPiBin = fs.realpathSync(piBin);
    const packageRoot = findPackageRoot(realPiBin, "@earendil-works/pi-coding-agent");
    if (!packageRoot) throw new Error(`Found pi at ${realPiBin}, but could not locate @earendil-works/pi-coding-agent.`);
    return {
      module: (await import(pathToFileURL(join(packageRoot, "dist/index.js")).href)) as PiSdkModule,
      source: packageRoot,
    };
  }
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
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

function assistantTextFromMessages(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  let text = "";
  for (const message of messages) {
    if (typeof message === "object" && message !== null && (message as Record<string, unknown>).role === "assistant") {
      const candidate = textFromContent((message as Record<string, unknown>).content);
      if (candidate.length > 0) text = candidate;
    }
  }
  return text;
}

function maybeAssistantTextFromAgentEnd(event: unknown): string {
  if (typeof event !== "object" || event === null) return "";
  const record = event as Record<string, unknown>;
  if (record.type !== "agent_end") return "";
  return assistantTextFromMessages(record.messages);
}

function maybeTextDelta(event: unknown): string {
  if (typeof event !== "object" || event === null) return "";
  const record = event as Record<string, unknown>;
  if (record.type !== "message_update") return "";
  const assistantMessageEvent = record.assistantMessageEvent;
  if (typeof assistantMessageEvent !== "object" || assistantMessageEvent === null) return "";
  const update = assistantMessageEvent as Record<string, unknown>;
  return update.type === "text_delta" && typeof update.delta === "string" ? update.delta : "";
}

function splitThinkingSuffix(modelReference: string): { model: string; thinking?: ThinkingLevel } {
  const index = modelReference.lastIndexOf(":");
  if (index <= 0) return { model: modelReference };
  const suffix = modelReference.slice(index + 1);
  if (!(THINKING_LEVELS as readonly string[]).includes(suffix)) return { model: modelReference };
  return { model: modelReference.slice(0, index), thinking: suffix as ThinkingLevel };
}

async function resolveRequestedModel(modelRegistry: ModelRegistryLike, modelReference: string): Promise<ModelLike> {
  await modelRegistry.reload?.();
  const parsed = splitThinkingSuffix(modelReference);
  const reference = parsed.model;
  const slashIndex = reference.indexOf("/");
  if (slashIndex > 0) {
    const provider = reference.slice(0, slashIndex);
    const modelId = reference.slice(slashIndex + 1);
    const exact = modelRegistry.find?.(provider, modelId);
    if (exact !== undefined) return exact;
  }

  const available = modelRegistry.getAvailable?.() ?? modelRegistry.getModels?.() ?? [];
  const matches = available.filter((model) => {
    const provider = typeof model.provider === "string" ? model.provider : "";
    const id = typeof model.id === "string" ? model.id : "";
    return `${provider}/${id}` === reference || id === reference;
  });
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`model ${JSON.stringify(modelReference)} is ambiguous; use provider/model id.`);
  throw new Error(`model ${JSON.stringify(modelReference)} was not found or is not available.`);
}

function buildPrompt(options: RunInlineModelOptions): string {
  if (options.systemPrompt !== undefined) return options.task;
  const sections = [
    `You are the Pi subagent named ${JSON.stringify(options.agent)}.`,
    "You are running as an inline child session. Do not spawn subagents or delegate to unmanaged child agents.",
    options.roleContext ? `Role context:\n${options.roleContext}` : undefined,
    options.agentScope ? `Agent scope: ${options.agentScope}` : undefined,
    options.confirmProjectAgents === undefined ? undefined : `confirmProjectAgents: ${String(options.confirmProjectAgents)}`,
    `Task:\n${options.task}`,
  ];
  return sections.filter((section): section is string => section !== undefined).join("\n\n");
}

function createChildResourceLoader(piSdk: PiSdkModule, options: RunInlineModelOptions) {
  const extensionRuntime = piSdk.createExtensionRuntime?.();
  const baseSystemPrompt = [
    `You are the Pi subagent named ${JSON.stringify(options.agent)}.`,
    "Child profile: inline SDK worker. Recursive subagent spawning is disabled. Use only the explicitly enabled local tools if needed.",
    options.roleContext ? `Role context:\n${options.roleContext}` : undefined,
  ]
    .filter((section): section is string => section !== undefined)
    .join("\n\n");
  const agentSystemPrompt = options.systemPrompt !== undefined ? options.systemPrompt : options.agentDefinition === undefined ? undefined : buildAgentSystemPrompt(options.agentDefinition);
  const systemPrompt = agentSystemPrompt === undefined
    ? baseSystemPrompt
    : options.systemPrompt !== undefined || options.agentDefinition?.systemPromptMode === "replace"
      ? agentSystemPrompt
      : `${baseSystemPrompt}\n\n${agentSystemPrompt}`;

  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: extensionRuntime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

async function promptWithStops(session: AgentSessionLike, prompt: string, timeoutMs: number | undefined, signal: AbortSignal | undefined): Promise<FailureKind | null> {
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;

  const promptPromise = session.prompt(prompt);
  const stopPromise = new Promise<FailureKind | null>((resolveStop) => {
    function stop(kind: FailureKind): void {
      if (settled) return;
      settled = true;
      void session.abort?.();
      resolveStop(kind);
    }

    if (timeoutMs !== undefined) timeoutTimer = setTimeout(() => stop("timeout"), timeoutMs);
    if (signal !== undefined) {
      if (signal.aborted) stop("abort");
      else signal.addEventListener("abort", () => stop("abort"), { once: true });
    }
  });

  const result = await Promise.race([
    promptPromise.then(() => null),
    stopPromise,
  ]);
  settled = true;
  if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
  return result;
}

export async function runInlineModel(options: RunInlineModelOptions): Promise<ResultEnvelope> {
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
  const store = await createAttemptArtifactStore({ cwd: artifactCwd, runId: options.runId, attemptId: options.attemptId, runsDir: options.runsDir });

  let stdoutText = "";
  let stderrText = "";
  let outputText = "";
  let failureKind: FailureKind | null = null;
  let toolCallArtifactRefs: ArtifactRef[] = [];
  const toolCallTelemetry = options.captureToolCalls === true ? new ToolCallTelemetryCollector() : undefined;

  try {
    const { module: piSdk, source } = await importPiSdk();
    const authStorage = piSdk.AuthStorage.create();
    const modelRegistry = piSdk.ModelRegistry.create(authStorage);
    const sessionManager = piSdk.SessionManager.inMemory(cwd);
    const resourceLoader = createChildResourceLoader(piSdk, options);
    await resourceLoader.reload();
    const requestedModel = options.model ?? options.agentDefinition?.model;
    const requestedThinking = options.thinking ?? options.agentDefinition?.thinking;
    const model = requestedModel === undefined ? undefined : await resolveRequestedModel(modelRegistry, requestedModel);
    const modelThinking = requestedModel === undefined ? undefined : splitThinkingSuffix(requestedModel).thinking;
    const tools = options.tools ?? options.agentDefinition?.tools;

    const { session, diagnostics = [] } = await piSdk.createAgentSession({
      cwd,
      authStorage,
      modelRegistry,
      sessionManager,
      resourceLoader,
      ...(tools === undefined ? {} : { tools }),
      ...(model === undefined ? {} : { model }),
      ...(requestedThinking === undefined && modelThinking === undefined ? {} : { thinkingLevel: requestedThinking ?? modelThinking }),
    });

    const unsubscribe = session.subscribe?.((event) => {
      toolCallTelemetry?.processEvent(event);
      stdoutText += maybeTextDelta(event);
      const agentEndText = maybeAssistantTextFromAgentEnd(event);
      if (agentEndText.length > 0) outputText = agentEndText;
    });

    try {
      const stopKind = await promptWithStops(session, buildPrompt(options), timeoutMs, options.signal);
      if (stopKind !== null) failureKind = stopKind;
      if (outputText.length === 0) outputText = assistantTextFromMessages(session.messages);
      if (outputText.length === 0) outputText = stdoutText;
    } finally {
      if (typeof unsubscribe === "function") unsubscribe();
      session.dispose?.();
    }

    if (diagnostics.length > 0) stderrText += `${JSON.stringify({ sdkSource: source, diagnostics })}\n`;
  } catch (error) {
    failureKind = failureKind ?? "model";
    stderrText += `${error instanceof Error ? error.message : String(error)}\n`;
  }

  if (failureKind === null && outputText.length === 0) {
    failureKind = "model";
    stderrText += "Inline SDK session completed without assistant output.\n";
  }

  toolCallArtifactRefs = await flushToolCallTelemetry(toolCallTelemetry, store);

  const completedAt = new Date();
  const status = failureKind === null ? "completed" : "failed";
  const artifacts: ArtifactRef[] = [
    await store.writeTextArtifact("stderr", stderrText),
    await store.writeTextArtifact("output", outputText),
    ...toolCallArtifactRefs,
  ];

  return await store.writeResult({
    backend: "inline",
    status,
    failureKind,
    cwd: artifactCwd,
    startedAt,
    completedAt,
    workspace: options.workspace ?? { mode: "shared", cwd },
    sandbox: { enabled: false },
    exitCode: null,
    signal: failureKind === "abort" ? "ABORT" : null,
    artifacts,
    correlationId: options.correlationId,
    metadata: { contextLengthExceeded: detectContextLengthExceeded({ stderrText }) },
  });
}
