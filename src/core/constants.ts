export const BACKENDS = ["inline", "headless", "tmux", "auto"] as const;
export const RESOLVED_BACKENDS = ["inline", "headless", "tmux"] as const;
export const STATUSES = [
	"pending",
	"running",
	"completed",
	"failed",
	"cancelled",
] as const;
export const FAILURE_KINDS = [
	"validation",
	"spawn",
	"timeout",
	"abort",
	"cancelled",
	"sandbox",
	"rpc",
	"model",
	"tool",
	"exit",
	"parse",
	"internal",
	"stale",
] as const;
export const EXECUTION_MODES = ["single", "parallel"] as const;
export const ASYNC_DEPENDENCIES = [
	"needed-before-final",
	"background",
	"unclassified",
] as const;
export const AGENT_SCOPES = ["auto", "global", "project"] as const;
export const WORKSPACE_MODES = ["shared", "worktree", "auto"] as const;
export const WORKTREE_POLICIES = ["auto", "required", "never"] as const;
export const ON_COMPLETE_ACTIONS = ["return", "notify", "detach"] as const;
export const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;

export type Backend = (typeof BACKENDS)[number];
export type ResolvedBackend = (typeof RESOLVED_BACKENDS)[number];
export type Status = (typeof STATUSES)[number];
export type FailureKind = (typeof FAILURE_KINDS)[number];
export type ExecutionMode = (typeof EXECUTION_MODES)[number];
export type AsyncDependency = (typeof ASYNC_DEPENDENCIES)[number];
export type AgentScope = (typeof AGENT_SCOPES)[number];
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];
export type WorktreePolicy = (typeof WORKTREE_POLICIES)[number];
export type OnCompleteAction = (typeof ON_COMPLETE_ACTIONS)[number];
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface SandboxOptionsInput {
	/**
	 * Network domains the sandboxed child process may reach (e.g. "api.anthropic.com",
	 * "*.npmjs.org"). The whole child Pi runs inside the sandbox boundary, so the model
	 * provider endpoint must be listed here for model-backed runs to work. Omitted or
	 * empty means no network access (deny-all), matching `sandbox: true`.
	 */
	allowedDomains?: string[];
}

export type SandboxInput = true | SandboxOptionsInput;

export function sandboxAllowedDomains(
	sandbox: SandboxInput | null | undefined,
): string[] {
	if (sandbox === undefined || sandbox === null || sandbox === true) return [];
	return sandbox.allowedDomains ?? [];
}

export interface WorkspaceInput {
	mode?: WorkspaceMode;
	path?: string;
}

export interface SubagentTaskInput {
	agent?: string;
	task?: string;
	roleContext?: string;
	agentScope?: AgentScope;
	confirmProjectAgents?: boolean;
	sandbox?: SandboxInput | null;
	visible?: boolean;
	cwd?: string;
	timeoutMs?: number;
	model?: string;
	sessionId?: string;
	thinking?: ThinkingLevel;
	tools?: string[];
	systemPrompt?: string;
	skills?: string[];
	extensions?: string[];
	captureToolCalls?: boolean;
}

export interface ResolveInput {
	backend?: Backend;
	sandbox?: SandboxInput | null;
	visible?: boolean;
	agent?: string;
	task?: string;
	roleContext?: string;
	agentScope?: AgentScope;
	confirmProjectAgents?: boolean;
	mode?: ExecutionMode;
	tasks?: SubagentTaskInput[];
	concurrency?: number;
	asyncDependency?: AsyncDependency;
	workspace?: WorkspaceInput | WorkspaceMode;
	worktree?: boolean | string;
	worktreePolicy?: WorktreePolicy;
	cwd?: string;
	async?: boolean;
	onComplete?: OnCompleteAction;
	timeoutMs?: number;
	model?: string;
	thinking?: ThinkingLevel;
	tools?: string[];
	systemPrompt?: string;
	skills?: string[];
	extensions?: string[];
	captureToolCalls?: boolean;
	runsDir?: string;
	correlationId?: string;
	/** Pi session id to attach a child headless run to when explicitly set by code API. */
	sessionId?: string;
	/** Pi session id of the parent that launched this run. Injected from ctx, not a model-settable tool arg. */
	parentSessionId?: string;
}

export interface ResolveSuccess {
	backend: ResolvedBackend;
	status: "completed";
}

export interface ResolveValidationFailure {
	backend?: ResolvedBackend;
	status: "failed";
	failureKind: "validation";
	error: string;
}

export type ResolveOutput = ResolveSuccess | ResolveValidationFailure;

function isOneOf<T extends string>(
	values: readonly T[],
	value: unknown,
): value is T {
	return (
		typeof value === "string" && (values as readonly string[]).includes(value)
	);
}

export function isBackend(value: unknown): value is Backend {
	return isOneOf(BACKENDS, value);
}

export function isExecutionMode(value: unknown): value is ExecutionMode {
	return isOneOf(EXECUTION_MODES, value);
}

export function isAsyncDependency(value: unknown): value is AsyncDependency {
	return isOneOf(ASYNC_DEPENDENCIES, value);
}

export function isAgentScope(value: unknown): value is AgentScope {
	return isOneOf(AGENT_SCOPES, value);
}

export function isWorkspaceMode(value: unknown): value is WorkspaceMode {
	return isOneOf(WORKSPACE_MODES, value);
}

export function isWorktreePolicy(value: unknown): value is WorktreePolicy {
	return isOneOf(WORKTREE_POLICIES, value);
}

export function isOnCompleteAction(value: unknown): value is OnCompleteAction {
	return isOneOf(ON_COMPLETE_ACTIONS, value);
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return isOneOf(THINKING_LEVELS, value);
}
