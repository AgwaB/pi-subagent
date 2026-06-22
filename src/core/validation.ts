import {
	AGENT_SCOPES,
	ASYNC_DEPENDENCIES,
	BACKENDS,
	EXECUTION_MODES,
	ON_COMPLETE_ACTIONS,
	THINKING_LEVELS,
	WORKSPACE_MODES,
	WORKTREE_POLICIES,
	isAgentScope,
	isAsyncDependency,
	isBackend,
	isExecutionMode,
	isOnCompleteAction,
	isThinkingLevel,
	isWorktreePolicy,
	isWorkspaceMode,
	type Backend,
	type ResolveInput,
	type ResolveValidationFailure,
	type ResolvedBackend,
	type SandboxInput,
	type SandboxOptionsInput,
	type SubagentTaskInput,
	type WorkspaceInput,
} from "./constants.ts";

export type ResolveValidationResult =
	| { ok: true; input: ResolveInput }
	| { ok: false; failure: ResolveValidationFailure };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(
	error: string,
	backend?: ResolvedBackend,
): ResolveValidationResult {
	return {
		ok: false,
		failure: {
			...(backend ? { backend } : {}),
			status: "failed",
			failureKind: "validation",
			error,
		},
	};
}

function failureBackend(
	backend: Backend | undefined,
): ResolvedBackend | undefined {
	const requested = backend ?? "auto";
	return requested === "auto" ? undefined : requested;
}

function formatValue(value: unknown): string {
	if (typeof value === "string") return `"${value}"`;
	return String(value);
}

function formatOptions(values: readonly string[]): string {
	return values.map((value) => `"${value}"`).join(", ");
}

function validateString(
	value: unknown,
	fieldName: string,
	backend: ResolvedBackend | undefined,
): string | ResolveValidationResult {
	if (typeof value !== "string" || value.length === 0) {
		return failure(
			`${fieldName} must be a non-empty string when provided.`,
			backend,
		);
	}
	return value;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function validateSessionId(
	value: unknown,
	fieldName: string,
	backend: ResolvedBackend | undefined,
): string | ResolveValidationResult {
	const sessionId = validateString(value, fieldName, backend);
	if (typeof sessionId !== "string") return sessionId;
	if (!SESSION_ID_PATTERN.test(sessionId)) {
		return failure(
			`${fieldName} must contain only letters, numbers, dots, underscores, or dashes.`,
			backend,
		);
	}
	return sessionId;
}

function validateBoolean(
	value: unknown,
	fieldName: string,
	backend: ResolvedBackend | undefined,
): boolean | ResolveValidationResult {
	if (typeof value !== "boolean") {
		return failure(`${fieldName} must be a boolean when provided.`, backend);
	}
	return value;
}

function validateTimeoutMs(
	value: unknown,
	backend: ResolvedBackend | undefined,
): number | ResolveValidationResult {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return failure(
			"timeoutMs must be a positive finite number when provided.",
			backend,
		);
	}
	return value;
}

function validateConcurrency(
	value: unknown,
	backend: ResolvedBackend | undefined,
): number | ResolveValidationResult {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		return failure(
			"concurrency must be a positive integer when provided.",
			backend,
		);
	}
	return value;
}

function validateThinkingAliases(
	value: Record<string, unknown>,
	fieldName: string,
	backend: ResolvedBackend | undefined,
): ResolveInput["thinking"] | ResolveValidationResult {
	const entries = [
		["thinking", value.thinking],
		["thinkingLevel", value.thinkingLevel],
		["reasoningLevel", value.reasoningLevel],
	].filter((entry): entry is [string, unknown] => entry[1] !== undefined);
	if (entries.length === 0) return undefined;

	for (const [key, raw] of entries) {
		if (!isThinkingLevel(raw)) {
			return failure(
				`unsupported ${fieldName}.${key} ${formatValue(raw)}; supported thinking levels are ${formatOptions(THINKING_LEVELS)}.`,
				backend,
			);
		}
	}

	const first = entries[0]![1];
	if (!isThinkingLevel(first)) return undefined;
	if (entries.some((entry) => entry[1] !== first)) {
		return failure(
			`${fieldName} thinking aliases must agree when more than one is provided.`,
			backend,
		);
	}
	return first;
}

function validateStringArray(
	value: unknown,
	fieldName: string,
	backend: ResolvedBackend | undefined,
): string[] | ResolveValidationResult {
	if (!Array.isArray(value)) {
		return failure(
			`${fieldName} must be an array of non-empty strings when provided.`,
			backend,
		);
	}

	const items: string[] = [];
	for (const [index, entry] of value.entries()) {
		if (typeof entry !== "string" || entry.length === 0) {
			return failure(
				`${fieldName}[${index}] must be a non-empty string.`,
				backend,
			);
		}
		items.push(entry);
	}
	return Array.from(new Set(items));
}

function validateTools(
	value: unknown,
	fieldName: string,
	backend: ResolvedBackend | undefined,
): string[] | ResolveValidationResult {
	return validateStringArray(value, fieldName, backend);
}

const DOMAIN_PATTERN =
	/^(\*\.)?[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

function isAllowedDomainPattern(value: string): boolean {
	if (value === "localhost") return true;
	if (!DOMAIN_PATTERN.test(value)) return false;
	// Reject overly broad wildcards such as "*.com"; require *.example.com shape.
	if (value.startsWith("*.")) return value.slice(2).includes(".");
	return true;
}

function validateSandbox(
	value: unknown,
	fieldName: string,
	backend: ResolvedBackend | undefined,
): SandboxInput | null | ResolveValidationResult {
	if (value === null || value === false) return null;
	if (value === true) return true;
	if (isRecord(value)) {
		const sandbox: SandboxOptionsInput = {};
		const unknownKeys = Object.keys(value).filter(
			(key) => key !== "allowedDomains",
		);
		if (unknownKeys.length > 0) {
			return failure(
				`unsupported ${fieldName} option(s): ${unknownKeys.map((key) => `"${key}"`).join(", ")}; supported options are "allowedDomains".`,
				backend,
			);
		}
		if (value.allowedDomains !== undefined) {
			const allowedDomains = validateStringArray(
				value.allowedDomains,
				`${fieldName}.allowedDomains`,
				backend,
			);
			if (!Array.isArray(allowedDomains)) return allowedDomains;
			for (const domain of allowedDomains) {
				if (!isAllowedDomainPattern(domain)) {
					return failure(
						`${fieldName}.allowedDomains entry ${formatValue(domain)} must be a bare domain or *.example.com-style wildcard without protocol, path, or port.`,
						backend,
					);
				}
			}
			sandbox.allowedDomains = allowedDomains;
		}
		return sandbox;
	}
	return failure(
		`${fieldName} must be a boolean or an options object when provided. Use true for an offline sandbox, { allowedDomains: [...] } to allow network egress, or false/null to disable sandboxing.`,
		backend,
	);
}

function validateTaskItem(
	value: unknown,
	fieldName: string,
	backend: ResolvedBackend | undefined,
): SubagentTaskInput | ResolveValidationResult {
	if (!isRecord(value)) {
		return failure(`${fieldName} must be an object.`, backend);
	}

	const task: SubagentTaskInput = {};

	if (value.agent !== undefined) {
		const agent = validateString(value.agent, `${fieldName}.agent`, backend);
		if (typeof agent !== "string") return agent;
		task.agent = agent;
	}

	if (value.task !== undefined) {
		const taskText = validateString(value.task, `${fieldName}.task`, backend);
		if (typeof taskText !== "string") return taskText;
		task.task = taskText;
	}

	if (value.roleContext !== undefined) {
		const roleContext = validateString(
			value.roleContext,
			`${fieldName}.roleContext`,
			backend,
		);
		if (typeof roleContext !== "string") return roleContext;
		task.roleContext = roleContext;
	}

	if (value.agentScope !== undefined) {
		if (!isAgentScope(value.agentScope)) {
			return failure(
				`unsupported ${fieldName}.agentScope ${formatValue(value.agentScope)}; supported agent scopes are ${formatOptions(AGENT_SCOPES)}.`,
				backend,
			);
		}
		task.agentScope = value.agentScope;
	}

	if (value.confirmProjectAgents !== undefined) {
		const confirm = validateBoolean(
			value.confirmProjectAgents,
			`${fieldName}.confirmProjectAgents`,
			backend,
		);
		if (typeof confirm !== "boolean") return confirm;
		task.confirmProjectAgents = confirm;
	}

	if (value.sandbox !== undefined) {
		const sandbox = validateSandbox(
			value.sandbox,
			`${fieldName}.sandbox`,
			backend,
		);
		if (sandbox !== null && sandbox !== true && "ok" in sandbox) return sandbox;
		task.sandbox = sandbox;
	}

	if (value.visible !== undefined) {
		const visible = validateBoolean(
			value.visible,
			`${fieldName}.visible`,
			backend,
		);
		if (typeof visible !== "boolean") return visible;
		task.visible = visible;
	}

	if (value.cwd !== undefined) {
		const cwd = validateString(value.cwd, `${fieldName}.cwd`, backend);
		if (typeof cwd !== "string") return cwd;
		task.cwd = cwd;
	}

	if (value.timeoutMs !== undefined) {
		const timeoutMs = validateTimeoutMs(value.timeoutMs, backend);
		if (typeof timeoutMs !== "number") return timeoutMs;
		task.timeoutMs = timeoutMs;
	}

	if (value.model !== undefined) {
		const model = validateString(value.model, `${fieldName}.model`, backend);
		if (typeof model !== "string") return model;
		task.model = model;
	}

	if (value.sessionId !== undefined) {
		const sessionId = validateSessionId(
			value.sessionId,
			`${fieldName}.sessionId`,
			backend,
		);
		if (typeof sessionId !== "string") return sessionId;
		task.sessionId = sessionId;
	}

	if (value.tools !== undefined) {
		const tools = validateTools(value.tools, `${fieldName}.tools`, backend);
		if (!Array.isArray(tools)) return tools;
		task.tools = tools;
	}

	if (value.systemPrompt !== undefined) {
		const systemPrompt = validateString(
			value.systemPrompt,
			`${fieldName}.systemPrompt`,
			backend,
		);
		if (typeof systemPrompt !== "string") return systemPrompt;
		task.systemPrompt = systemPrompt;
	}

	if (value.skills !== undefined) {
		const skills = validateStringArray(
			value.skills,
			`${fieldName}.skills`,
			backend,
		);
		if (!Array.isArray(skills)) return skills;
		task.skills = skills;
	}

	if (value.extensions !== undefined) {
		const extensions = validateStringArray(
			value.extensions,
			`${fieldName}.extensions`,
			backend,
		);
		if (!Array.isArray(extensions)) return extensions;
		task.extensions = extensions;
	}

	if (value.captureToolCalls !== undefined) {
		const captureToolCalls = validateBoolean(
			value.captureToolCalls,
			`${fieldName}.captureToolCalls`,
			backend,
		);
		if (typeof captureToolCalls !== "boolean") return captureToolCalls;
		task.captureToolCalls = captureToolCalls;
	}

	const thinking = validateThinkingAliases(value, fieldName, backend);
	if (thinking && typeof thinking !== "string") return thinking;
	if (thinking !== undefined) task.thinking = thinking;

	return task;
}

function validateTaskList(
	value: unknown,
	fieldName: string,
	backend: ResolvedBackend | undefined,
): SubagentTaskInput[] | ResolveValidationResult {
	if (!Array.isArray(value) || value.length === 0) {
		return failure(
			`${fieldName} must be a non-empty array of task objects when provided.`,
			backend,
		);
	}

	const tasks: SubagentTaskInput[] = [];
	for (const [index, entry] of value.entries()) {
		const task = validateTaskItem(entry, `${fieldName}[${index}]`, backend);
		if ("ok" in task) return task;
		tasks.push(task);
	}
	return tasks;
}

function validateWorkspace(
	value: unknown,
	backend: ResolvedBackend | undefined,
): WorkspaceInput | ResolveInput["workspace"] | ResolveValidationResult {
	if (isWorkspaceMode(value)) return value;
	if (!isRecord(value)) {
		return failure(
			`workspace must be one of ${formatOptions(WORKSPACE_MODES)} or an object when provided.`,
			backend,
		);
	}

	const workspace: WorkspaceInput = {};
	if (value.mode !== undefined) {
		if (!isWorkspaceMode(value.mode)) {
			return failure(
				`unsupported workspace.mode ${formatValue(value.mode)}; supported workspace modes are ${formatOptions(WORKSPACE_MODES)}.`,
				backend,
			);
		}
		workspace.mode = value.mode;
	}

	if (value.path !== undefined) {
		const workspacePath = validateString(value.path, "workspace.path", backend);
		if (typeof workspacePath !== "string") return workspacePath;
		workspace.path = workspacePath;
	}

	return workspace;
}

export function validateResolveInput(
	raw: unknown = {},
): ResolveValidationResult {
	if (raw === undefined) raw = {};

	if (!isRecord(raw)) {
		return failure("subagent input must be an object.");
	}

	const input: ResolveInput = {};
	let backend: Backend | undefined;

	if (raw.backend !== undefined) {
		if (!isBackend(raw.backend)) {
			return failure(
				`unsupported backend ${formatValue(raw.backend)}; supported backends are ${BACKENDS.map(
					(value) => `"${value}"`,
				).join(", ")}.`,
			);
		}
		backend = raw.backend;
		input.backend = backend;
	}

	const backendForKnownFailure = failureBackend(backend);

	if (raw.visible !== undefined) {
		if (typeof raw.visible !== "boolean") {
			return failure(
				"visible must be a boolean when provided.",
				backendForKnownFailure,
			);
		}
		input.visible = raw.visible;
	}

	if (raw.sandbox !== undefined) {
		const sandbox = validateSandbox(
			raw.sandbox,
			"sandbox",
			backendForKnownFailure,
		);
		if (sandbox !== null && sandbox !== true && "ok" in sandbox) return sandbox;
		input.sandbox = sandbox;
	}

	if (raw.agent !== undefined) {
		const agent = validateString(raw.agent, "agent", backendForKnownFailure);
		if (typeof agent !== "string") return agent;
		input.agent = agent;
	}

	if (raw.task !== undefined) {
		const task = validateString(raw.task, "task", backendForKnownFailure);
		if (typeof task !== "string") return task;
		input.task = task;
	}

	if (raw.roleContext !== undefined) {
		const roleContext = validateString(
			raw.roleContext,
			"roleContext",
			backendForKnownFailure,
		);
		if (typeof roleContext !== "string") return roleContext;
		input.roleContext = roleContext;
	}

	if (raw.agentScope !== undefined) {
		if (!isAgentScope(raw.agentScope)) {
			return failure(
				`unsupported agentScope ${formatValue(raw.agentScope)}; supported agent scopes are ${formatOptions(AGENT_SCOPES)}.`,
				backendForKnownFailure,
			);
		}
		input.agentScope = raw.agentScope;
	}

	if (raw.confirmProjectAgents !== undefined) {
		const confirmProjectAgents = validateBoolean(
			raw.confirmProjectAgents,
			"confirmProjectAgents",
			backendForKnownFailure,
		);
		if (typeof confirmProjectAgents !== "boolean") return confirmProjectAgents;
		input.confirmProjectAgents = confirmProjectAgents;
	}

	if (raw.mode !== undefined) {
		if (!isExecutionMode(raw.mode)) {
			return failure(
				`unsupported mode ${formatValue(raw.mode)}; supported modes are ${formatOptions(EXECUTION_MODES)}.`,
				backendForKnownFailure,
			);
		}
		input.mode = raw.mode;
	}

	if (raw.tasks !== undefined) {
		const tasks = validateTaskList(raw.tasks, "tasks", backendForKnownFailure);
		if ("ok" in tasks) return tasks;
		input.tasks = tasks;
	}

	if (raw.concurrency !== undefined) {
		const concurrency = validateConcurrency(
			raw.concurrency,
			backendForKnownFailure,
		);
		if (typeof concurrency !== "number") return concurrency;
		input.concurrency = concurrency;
	}

	if (raw.chain !== undefined) {
		return failure(
			'chain mode is not supported by pi-subagent; use mode:"parallel" for fanout or have the parent orchestrate sequencing.',
			backendForKnownFailure,
		);
	}

	if (raw.workspace !== undefined) {
		const workspace = validateWorkspace(raw.workspace, backendForKnownFailure);
		if (
			typeof workspace === "object" &&
			workspace !== null &&
			"ok" in workspace
		)
			return workspace;
		input.workspace = workspace;
	}

	if (raw.worktree !== undefined) {
		if (
			typeof raw.worktree !== "boolean" &&
			(typeof raw.worktree !== "string" || raw.worktree.length === 0)
		) {
			return failure(
				"worktree must be a boolean or non-empty string path when provided.",
				backendForKnownFailure,
			);
		}
		input.worktree = raw.worktree;
	}

	if (raw.worktreePolicy !== undefined) {
		if (!isWorktreePolicy(raw.worktreePolicy)) {
			return failure(
				`unsupported worktreePolicy ${formatValue(raw.worktreePolicy)}; supported worktree policies are ${formatOptions(WORKTREE_POLICIES)}.`,
				backendForKnownFailure,
			);
		}
		input.worktreePolicy = raw.worktreePolicy;
	}

	if (raw.cwd !== undefined) {
		const cwd = validateString(raw.cwd, "cwd", backendForKnownFailure);
		if (typeof cwd !== "string") return cwd;
		input.cwd = cwd;
	}

	if (raw.runsDir !== undefined) {
		const runsDir = validateString(
			raw.runsDir,
			"runsDir",
			backendForKnownFailure,
		);
		if (typeof runsDir !== "string") return runsDir;
		input.runsDir = runsDir;
	}

	if (raw.correlationId !== undefined) {
		const correlationId = validateString(
			raw.correlationId,
			"correlationId",
			backendForKnownFailure,
		);
		if (typeof correlationId !== "string") return correlationId;
		input.correlationId = correlationId;
	}

	if (raw.sessionId !== undefined) {
		if (raw.tasks !== undefined || raw.mode === "parallel") {
			return failure(
				"top-level sessionId is not supported with parallel tasks; set tasks[i].sessionId instead.",
				backendForKnownFailure,
			);
		}

		const sessionId = validateSessionId(
			raw.sessionId,
			"sessionId",
			backendForKnownFailure,
		);
		if (typeof sessionId !== "string") return sessionId;
		input.sessionId = sessionId;
	}

	if (raw.async !== undefined) {
		const asyncValue = validateBoolean(
			raw.async,
			"async",
			backendForKnownFailure,
		);
		if (typeof asyncValue !== "boolean") return asyncValue;
		input.async = asyncValue;
	}

	if (raw.onComplete !== undefined) {
		if (!isOnCompleteAction(raw.onComplete)) {
			return failure(
				`unsupported onComplete ${formatValue(raw.onComplete)}; supported onComplete actions are ${formatOptions(ON_COMPLETE_ACTIONS)}.`,
				backendForKnownFailure,
			);
		}
		input.onComplete = raw.onComplete;
	}

	if (raw.asyncDependency !== undefined) {
		if (!isAsyncDependency(raw.asyncDependency)) {
			return failure(
				`unsupported asyncDependency ${formatValue(raw.asyncDependency)}; supported async dependencies are ${formatOptions(ASYNC_DEPENDENCIES)}.`,
				backendForKnownFailure,
			);
		}
		input.asyncDependency = raw.asyncDependency;
	}

	if (raw.timeoutMs !== undefined) {
		const timeoutMs = validateTimeoutMs(raw.timeoutMs, backendForKnownFailure);
		if (typeof timeoutMs !== "number") return timeoutMs;
		input.timeoutMs = timeoutMs;
	}

	if (raw.model !== undefined) {
		const model = validateString(raw.model, "model", backendForKnownFailure);
		if (typeof model !== "string") return model;
		input.model = model;
	}

	if (raw.tools !== undefined) {
		const tools = validateTools(raw.tools, "tools", backendForKnownFailure);
		if (!Array.isArray(tools)) return tools;
		input.tools = tools;
	}

	if (raw.systemPrompt !== undefined) {
		const systemPrompt = validateString(
			raw.systemPrompt,
			"systemPrompt",
			backendForKnownFailure,
		);
		if (typeof systemPrompt !== "string") return systemPrompt;
		input.systemPrompt = systemPrompt;
	}

	if (raw.skills !== undefined) {
		const skills = validateStringArray(
			raw.skills,
			"skills",
			backendForKnownFailure,
		);
		if (!Array.isArray(skills)) return skills;
		input.skills = skills;
	}

	if (raw.extensions !== undefined) {
		const extensions = validateStringArray(
			raw.extensions,
			"extensions",
			backendForKnownFailure,
		);
		if (!Array.isArray(extensions)) return extensions;
		input.extensions = extensions;
	}

	if (raw.captureToolCalls !== undefined) {
		const captureToolCalls = validateBoolean(
			raw.captureToolCalls,
			"captureToolCalls",
			backendForKnownFailure,
		);
		if (typeof captureToolCalls !== "boolean") return captureToolCalls;
		input.captureToolCalls = captureToolCalls;
	}

	const thinking = validateThinkingAliases(
		raw,
		"input",
		backendForKnownFailure,
	);
	if (thinking && typeof thinking !== "string") return thinking;
	if (thinking !== undefined) input.thinking = thinking;

	const requested = backend ?? "auto";
	const sandboxed = input.sandbox !== undefined && input.sandbox !== null;

	if (input.visible === true && requested !== "auto" && requested !== "tmux") {
		return failure(
			'visible execution requires backend "tmux" or "auto"; explicit non-tmux backends cannot run visibly.',
			failureBackend(backend),
		);
	}

	if (requested === "inline" && sandboxed) {
		return failure(
			"inline backend cannot provide a per-subagent OS sandbox; choose headless, tmux, or auto.",
			"inline",
		);
	}

	return { ok: true, input };
}
