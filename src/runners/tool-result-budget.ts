import type { ToolResultBudgetInput } from "../core/constants.ts";

export const TOOL_RESULT_BUDGET_SCHEMA_VERSION = 1 as const;
export const TOOL_RESULT_BUDGET_STATE_FILENAME = "tool-result-budget.json";
export const CONTEXT_RECOVERY_EVICT_FRACTION = 0.25;

export const TOOL_RESULT_BUDGET_ENV = {
	maxTotalChars: "PI_SUBAGENT_TOOL_RESULT_BUDGET_MAX_CHARS",
	statePath: "PI_SUBAGENT_TOOL_RESULT_BUDGET_STATE_PATH",
	forceEvictFraction: "PI_SUBAGENT_TOOL_RESULT_BUDGET_FORCE_EVICT_FRACTION",
} as const;

export interface NormalizedToolResultBudget {
	budget?: { maxTotalChars: number };
	warning?: string;
}

/**
 * Lenient by contract: an invalid budget must never fail the run. It is
 * ignored and surfaced as a recorded warning in run metadata instead.
 */
export function normalizeToolResultBudget(
	value: unknown,
): NormalizedToolResultBudget {
	if (value === undefined) return {};
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {
			warning:
				"toolResultBudget ignored: expected an object like { maxTotalChars: <positive number> }.",
		};
	}
	const maxTotalChars = (value as { maxTotalChars?: unknown }).maxTotalChars;
	if (
		typeof maxTotalChars !== "number" ||
		!Number.isFinite(maxTotalChars) ||
		maxTotalChars <= 0
	) {
		return {
			warning:
				"toolResultBudget ignored: maxTotalChars must be a positive finite number.",
		};
	}
	return { budget: { maxTotalChars: Math.floor(maxTotalChars) } };
}

export interface ToolResultBudgetConfig {
	maxTotalChars: number;
	forceEvictFraction?: number;
	statePath?: string;
}

export function readToolResultBudgetEnv(
	env: Record<string, string | undefined>,
): ToolResultBudgetConfig | undefined {
	const rawMax = env[TOOL_RESULT_BUDGET_ENV.maxTotalChars];
	if (rawMax === undefined || rawMax.length === 0) return undefined;
	const maxTotalChars = Number(rawMax);
	if (!Number.isFinite(maxTotalChars) || maxTotalChars <= 0) return undefined;

	const config: ToolResultBudgetConfig = {
		maxTotalChars: Math.floor(maxTotalChars),
	};
	const statePath = env[TOOL_RESULT_BUDGET_ENV.statePath];
	if (statePath !== undefined && statePath.length > 0)
		config.statePath = statePath;
	const rawFraction = env[TOOL_RESULT_BUDGET_ENV.forceEvictFraction];
	if (rawFraction !== undefined && rawFraction.length > 0) {
		const fraction = Number(rawFraction);
		if (Number.isFinite(fraction) && fraction > 0)
			config.forceEvictFraction = Math.min(1, fraction);
	}
	return config;
}

export interface ToolResultBudgetState {
	schemaVersion: typeof TOOL_RESULT_BUDGET_SCHEMA_VERSION;
	maxTotalChars: number;
	toolResults: number;
	retainedChars: number;
	evictedCount: number;
	evictedChars: number;
	/** Retained tool results that could still be evicted (excludes the newest). */
	evictableCount: number;
	forcedEvictionApplied: boolean;
}

export function evictionPlaceholder(toolName: string, chars: number): string {
	return `[evicted tool result: ${toolName}, ${chars} chars]`;
}

interface ToolResultEntry {
	key: string;
	toolName: string;
	chars: number;
	message: Record<string, unknown>;
}

function isToolResultMessage(
	message: unknown,
): message is Record<string, unknown> {
	return (
		typeof message === "object" &&
		message !== null &&
		(message as Record<string, unknown>).role === "toolResult"
	);
}

function toolResultChars(message: Record<string, unknown>): number {
	const content = message.content;
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const part of content) {
		if (
			typeof part === "object" &&
			part !== null &&
			(part as Record<string, unknown>).type === "text" &&
			typeof (part as Record<string, unknown>).text === "string"
		) {
			chars += ((part as Record<string, unknown>).text as string).length;
		}
	}
	return chars;
}

function messageKey(message: Record<string, unknown>, index: number): string {
	const toolCallId = message.toolCallId;
	return typeof toolCallId === "string" && toolCallId.length > 0
		? toolCallId
		: `#${index}`;
}

function messageToolName(message: Record<string, unknown>): string {
	const toolName = message.toolName;
	return typeof toolName === "string" && toolName.length > 0
		? toolName
		: "unknown";
}

/**
 * Enforces a cumulative character budget over tool-result messages before
 * each model call. Eviction replaces only the message content with a short
 * placeholder; message role, toolCallId, and toolName stay intact so the
 * provider payload structure remains valid. The newest tool result is never
 * evicted. Eviction decisions are sticky for the lifetime of the enforcer.
 */
export class ToolResultBudgetEnforcer {
	private readonly maxTotalChars: number;
	private pendingForceEvictFraction: number;
	private forcedEvictionApplied = false;
	private readonly evicted = new Map<
		string,
		{ toolName: string; chars: number }
	>();

	constructor(options: {
		maxTotalChars: number;
		forceEvictFraction?: number;
	}) {
		this.maxTotalChars = options.maxTotalChars;
		this.pendingForceEvictFraction = options.forceEvictFraction ?? 0;
	}

	enforce(messages: unknown[]): ToolResultBudgetState {
		const entries: ToolResultEntry[] = [];
		for (const [index, message] of messages.entries()) {
			if (!isToolResultMessage(message)) continue;
			entries.push({
				key: messageKey(message, index),
				toolName: messageToolName(message),
				chars: toolResultChars(message),
				message,
			});
		}

		// Re-apply placeholders: the transcript owner hands us a fresh clone of
		// the full message history before every model call.
		for (const entry of entries) {
			const evicted = this.evicted.get(entry.key);
			if (evicted !== undefined) this.replaceWithPlaceholder(entry, evicted);
		}

		const newestKey = entries.at(-1)?.key;
		const retained = entries.filter((entry) => !this.evicted.has(entry.key));
		const retainedChars = () =>
			retained.reduce((total, entry) => total + entry.chars, 0);
		const evictOldest = () => {
			const entry = retained.shift();
			if (entry === undefined) return;
			const record = { toolName: entry.toolName, chars: entry.chars };
			this.evicted.set(entry.key, record);
			this.replaceWithPlaceholder(entry, record);
		};

		if (this.pendingForceEvictFraction > 0) {
			const fraction = this.pendingForceEvictFraction;
			this.pendingForceEvictFraction = 0;
			const target = retainedChars() * (1 - fraction);
			while (
				retained.length > 1 &&
				retained[0]!.key !== newestKey &&
				retainedChars() > target
			) {
				evictOldest();
				this.forcedEvictionApplied = true;
			}
		}

		while (
			retained.length > 1 &&
			retained[0]!.key !== newestKey &&
			retainedChars() > this.maxTotalChars
		) {
			evictOldest();
		}

		return this.stateFor(entries.length, retainedChars(), retained.length);
	}

	get state(): ToolResultBudgetState {
		return this.stateFor(0, 0, 0);
	}

	private stateFor(
		toolResults: number,
		retainedChars: number,
		retainedCount: number,
	): ToolResultBudgetState {
		let evictedChars = 0;
		for (const record of this.evicted.values()) evictedChars += record.chars;
		return {
			schemaVersion: TOOL_RESULT_BUDGET_SCHEMA_VERSION,
			maxTotalChars: this.maxTotalChars,
			toolResults,
			retainedChars,
			evictedCount: this.evicted.size,
			evictedChars,
			evictableCount: Math.max(0, retainedCount - 1),
			forcedEvictionApplied: this.forcedEvictionApplied,
		};
	}

	private replaceWithPlaceholder(
		entry: ToolResultEntry,
		record: { toolName: string; chars: number },
	): void {
		entry.message.content = [
			{
				type: "text",
				text: evictionPlaceholder(record.toolName, record.chars),
			},
		];
		entry.chars = 0;
	}
}

export type { ToolResultBudgetInput };
