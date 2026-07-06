import type { ArtifactRef, ArtifactType } from "../artifacts/index.ts";

const TOOL_CALL_SCHEMA_VERSION = 1 as const;
const MAX_SUMMARY_DEPTH = 3;
const MAX_KEYS = 24;
const MAX_RESOURCES_PER_SUMMARY = 8;
const MAX_RESOURCE_SAMPLES = 50;
const MAX_RESOURCE_LENGTH = 240;
const MAX_DETAIL_STRING_LENGTH = 500;
const MAX_DETAIL_ARRAY_ITEMS = 16;
const MAX_DETAIL_DEPTH = 3;
const MAX_RECORDS = 1_000;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
const SENSITIVE_KEY_PATTERN =
	/(?:authorization|auth|bearer|cookie|session|token|secret|password|passwd|api[-_]?key|access[-_]?key|refresh[-_]?token|credential|headers?)/i;

type ToolCallStatus = "completed" | "failed" | "incomplete";
type ToolCategory =
	| "network"
	| "filesystem"
	| "shell"
	| "vcs"
	| "browser"
	| "agent"
	| "unknown";

type ToolCallArtifactType = Extract<
	ArtifactType,
	"tool-calls" | "tool-calls-summary"
>;

export interface ToolResourceSummary {
	kind: "url";
	scheme: string;
	host: string;
	value: string;
}

export interface ToolValueSummary {
	type: string;
	keys?: string[];
	redactedKeys?: string[];
	arrayLength?: number;
	stringCount: number;
	stringChars: number;
	resources: ToolResourceSummary[];
	truncated: boolean;
}

export interface ToolValueDetail {
	value: unknown;
	truncated: boolean;
	redactedKeys?: string[];
}

export interface ToolCallTelemetryRecord {
	schemaVersion: typeof TOOL_CALL_SCHEMA_VERSION;
	type: "tool_call";
	toolCallId: string;
	toolName: string;
	category: ToolCategory;
	status: ToolCallStatus;
	startedAt: string;
	completedAt: string | null;
	durationMs: number | null;
	isError: boolean;
	argsSummary: ToolValueSummary;
	resultSummary: ToolValueSummary;
	failedArgs?: ToolValueDetail;
	failedResult?: ToolValueDetail;
}

export interface ToolCallTelemetrySummary {
	schemaVersion: typeof TOOL_CALL_SCHEMA_VERSION;
	enabled: true;
	totalCalls: number;
	callsByTool: Record<string, number>;
	callsByCategory: Record<string, number>;
	errorsByTool: Record<string, number>;
	errorsByCategory: Record<string, number>;
	statusCounts: Record<ToolCallStatus, number>;
	resources: {
		urls: string[];
		hosts: string[];
	};
	droppedRecords: number;
	limits: {
		updatesCaptured: false;
		fullArgsStored: false;
		fullResultsStored: false;
		failedArgsStored: true;
		failedResultsStored: true;
		maxRecords: number;
		maxSummaryDepth: number;
		maxKeys: number;
		maxResourceSamples: number;
		maxDetailStringLength: number;
		maxDetailArrayItems: number;
		maxDetailDepth: number;
	};
}

interface AttemptStoreLike {
	writeTextArtifact(
		type: ToolCallArtifactType,
		content: string | Uint8Array,
	): Promise<ArtifactRef>;
}

interface PendingToolCall {
	toolCallId: string;
	toolName: string;
	category: ToolCategory;
	startedAt: string;
	startedMs: number;
	argsSummary: ToolValueSummary;
	argsDetail: ToolValueDetail;
}

function emptyValueSummary(type = "undefined"): ToolValueSummary {
	return {
		type,
		stringCount: 0,
		stringChars: 0,
		resources: [],
		truncated: false,
	};
}

function valueType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function uniquePush<T>(items: T[], value: T, max: number): void {
	if (items.length >= max || items.includes(value)) return;
	items.push(value);
}

function trimTrailingUrlPunctuation(value: string): string {
	return value.replace(/[),.;!?]+$/g, "");
}

function truncate(value: string, max: number): string {
	return value.length <= max ? value : value.slice(0, max - 1) + "…";
}

function sanitizedUrlResource(raw: string): ToolResourceSummary | undefined {
	try {
		const parsed = new URL(trimTrailingUrlPunctuation(raw));
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
			return undefined;
		parsed.username = "";
		parsed.password = "";
		parsed.search = "";
		parsed.hash = "";
		const path = parsed.pathname === "/" ? "" : truncate(parsed.pathname, 120);
		const value = truncate(
			`${parsed.protocol}//${parsed.host}${path}`,
			MAX_RESOURCE_LENGTH,
		);
		return {
			kind: "url",
			scheme: parsed.protocol.replace(/:$/, ""),
			host: parsed.host,
			value,
		};
	} catch {
		return undefined;
	}
}

function collectUrlResources(
	value: string,
	resources: ToolResourceSummary[],
): void {
	URL_PATTERN.lastIndex = 0;
	for (const match of value.matchAll(URL_PATTERN)) {
		const resource = sanitizedUrlResource(match[0]);
		if (!resource) continue;
		if (resources.some((candidate) => candidate.value === resource.value))
			continue;
		resources.push(resource);
		if (resources.length >= MAX_RESOURCES_PER_SUMMARY) return;
	}
}

function mergeSummary(
	target: ToolValueSummary,
	nested: ToolValueSummary,
): void {
	target.stringCount += nested.stringCount;
	target.stringChars += nested.stringChars;
	target.truncated ||= nested.truncated;
	for (const resource of nested.resources) {
		if (target.resources.length >= MAX_RESOURCES_PER_SUMMARY) break;
		if (
			!target.resources.some((candidate) => candidate.value === resource.value)
		)
			target.resources.push(resource);
	}
}

export function summarizeToolValue(
	value: unknown,
	depth = 0,
): ToolValueSummary {
	const type = valueType(value);
	if (value === undefined) return emptyValueSummary("undefined");
	if (
		value === null ||
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "bigint"
	)
		return emptyValueSummary(type);
	if (typeof value === "string") {
		const summary = emptyValueSummary("string");
		summary.stringCount = 1;
		summary.stringChars = value.length;
		collectUrlResources(value, summary.resources);
		return summary;
	}
	if (typeof value !== "object") return emptyValueSummary(type);

	const summary = emptyValueSummary(type);
	if (depth >= MAX_SUMMARY_DEPTH) {
		summary.truncated = true;
		return summary;
	}

	if (Array.isArray(value)) {
		summary.arrayLength = value.length;
		for (const item of value.slice(0, MAX_KEYS))
			mergeSummary(summary, summarizeToolValue(item, depth + 1));
		if (value.length > MAX_KEYS) summary.truncated = true;
		return summary;
	}

	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	summary.keys = [];
	summary.redactedKeys = [];
	for (const key of keys.slice(0, MAX_KEYS)) {
		if (SENSITIVE_KEY_PATTERN.test(key)) {
			uniquePush(summary.redactedKeys, key, MAX_KEYS);
			continue;
		}
		uniquePush(summary.keys, key, MAX_KEYS);
		mergeSummary(summary, summarizeToolValue(record[key], depth + 1));
	}
	if (keys.length > MAX_KEYS) summary.truncated = true;
	if (summary.keys.length === 0) delete summary.keys;
	if (summary.redactedKeys.length === 0) delete summary.redactedKeys;
	return summary;
}

function sanitizeUrlsInString(value: string): string {
	URL_PATTERN.lastIndex = 0;
	return value.replace(
		URL_PATTERN,
		(raw) => sanitizedUrlResource(raw)?.value ?? "[url]",
	);
}

function sanitizeDetailString(
	value: string,
	state: { truncated: boolean },
): string {
	const sanitized = sanitizeUrlsInString(value);
	if (sanitized.length <= MAX_DETAIL_STRING_LENGTH) return sanitized;
	state.truncated = true;
	return truncate(sanitized, MAX_DETAIL_STRING_LENGTH);
}

function sanitizeToolDetail(value: unknown): ToolValueDetail {
	const state: { truncated: boolean; redactedKeys: string[] } = {
		truncated: false,
		redactedKeys: [],
	};
	const detail: ToolValueDetail = {
		value: sanitizeToolDetailValue(value, 0, state),
		truncated: state.truncated,
	};
	if (state.redactedKeys.length > 0) detail.redactedKeys = state.redactedKeys;
	return detail;
}

function sanitizeToolDetailValue(
	value: unknown,
	depth: number,
	state: { truncated: boolean; redactedKeys: string[] },
): unknown {
	if (value === undefined) return "[undefined]";
	if (value === null || typeof value === "number" || typeof value === "boolean")
		return value;
	if (typeof value === "bigint") return String(value);
	if (typeof value === "string") return sanitizeDetailString(value, state);
	if (typeof value !== "object") return `[${typeof value}]`;
	if (depth >= MAX_DETAIL_DEPTH) {
		state.truncated = true;
		return "[truncated]";
	}
	if (Array.isArray(value)) {
		if (value.length > MAX_DETAIL_ARRAY_ITEMS) state.truncated = true;
		return value
			.slice(0, MAX_DETAIL_ARRAY_ITEMS)
			.map((item) => sanitizeToolDetailValue(item, depth + 1, state));
	}
	const record = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	const keys = Object.keys(record);
	if (keys.length > MAX_KEYS) state.truncated = true;
	for (const key of keys.slice(0, MAX_KEYS)) {
		if (SENSITIVE_KEY_PATTERN.test(key)) {
			uniquePush(state.redactedKeys, key, MAX_KEYS);
			out[key] = "[REDACTED]";
			continue;
		}
		out[key] = sanitizeToolDetailValue(record[key], depth + 1, state);
	}
	return out;
}

function categorizeTool(toolName: string): ToolCategory {
	const lower = toolName.toLowerCase();
	if (
		/^(web_search|fetch_content|fetch|code_search|get_search_content|scrapling_fetch)$/.test(
			lower,
		) ||
		/(?:web|fetch|http|url|search|scrap)/.test(lower)
	)
		return "network";
	if (/^(read|write|edit)$/.test(lower) || /(?:file|fs|path)/.test(lower))
		return "filesystem";
	if (
		/^(bash|shell|exec|command)$/.test(lower) ||
		/(?:shell|terminal|process)/.test(lower)
	)
		return "shell";
	if (/^(git|gh)$/.test(lower) || /(?:git|github)/.test(lower)) return "vcs";
	if (/(?:browser|playwright|chromium)/.test(lower)) return "browser";
	if (/(?:agent|subagent)/.test(lower)) return "agent";
	return "unknown";
}

function increment(map: Record<string, number>, key: string): void {
	map[key] = (map[key] ?? 0) + 1;
}

function eventString(
	record: Record<string, unknown>,
	field: string,
): string | undefined {
	const value = record[field];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export class ToolCallTelemetryCollector {
	private readonly pending = new Map<string, PendingToolCall>();
	private readonly records: ToolCallTelemetryRecord[] = [];
	private droppedRecords = 0;
	private observedCalls = 0;
	private finished = false;

	processEvent(event: unknown, observedAt: Date = new Date()): void {
		if (typeof event !== "object" || event === null) return;
		const record = event as Record<string, unknown>;
		if (
			record.type !== "tool_execution_start" &&
			record.type !== "tool_execution_end"
		)
			return;
		const toolCallId = eventString(record, "toolCallId");
		const toolName = eventString(record, "toolName");
		if (toolCallId === undefined || toolName === undefined) return;

		if (record.type === "tool_execution_start") {
			const startedAt = observedAt.toISOString();
			this.pending.set(toolCallId, {
				toolCallId,
				toolName,
				category: categorizeTool(toolName),
				startedAt,
				startedMs: observedAt.getTime(),
				argsSummary: summarizeToolValue(record.args),
				argsDetail: sanitizeToolDetail(record.args),
			});
			return;
		}

		const pending = this.pending.get(toolCallId);
		const completedAt = observedAt.toISOString();
		const isError = record.isError === true;
		const fallback: PendingToolCall = {
			toolCallId,
			toolName,
			category: categorizeTool(toolName),
			startedAt: completedAt,
			startedMs: observedAt.getTime(),
			argsSummary: emptyValueSummary(),
			argsDetail: sanitizeToolDetail(undefined),
		};
		this.pending.delete(toolCallId);
		this.addRecord({
			schemaVersion: TOOL_CALL_SCHEMA_VERSION,
			type: "tool_call",
			toolCallId,
			toolName,
			category: pending?.category ?? fallback.category,
			status: isError ? "failed" : "completed",
			startedAt: pending?.startedAt ?? fallback.startedAt,
			completedAt,
			durationMs: Math.max(
				0,
				observedAt.getTime() - (pending?.startedMs ?? fallback.startedMs),
			),
			isError,
			argsSummary: pending?.argsSummary ?? fallback.argsSummary,
			resultSummary: summarizeToolValue(record.result),
			...(isError
				? {
						failedArgs: pending?.argsDetail ?? fallback.argsDetail,
						failedResult: sanitizeToolDetail(record.result),
					}
				: {}),
		});
	}

	async flush(
		store: AttemptStoreLike,
		finishedAt: Date = new Date(),
	): Promise<ArtifactRef[]> {
		if (this.finished) return [];
		this.finished = true;
		for (const pending of this.pending.values()) {
			this.addRecord({
				schemaVersion: TOOL_CALL_SCHEMA_VERSION,
				type: "tool_call",
				toolCallId: pending.toolCallId,
				toolName: pending.toolName,
				category: pending.category,
				status: "incomplete",
				startedAt: pending.startedAt,
				completedAt: null,
				durationMs: Math.max(0, finishedAt.getTime() - pending.startedMs),
				isError: true,
				argsSummary: pending.argsSummary,
				resultSummary: emptyValueSummary(),
				failedArgs: pending.argsDetail,
			});
		}
		this.pending.clear();
		if (this.observedCalls === 0 && this.droppedRecords === 0) return [];

		const callsText =
			this.records.map((record) => JSON.stringify(record)).join("\n") +
			(this.records.length > 0 ? "\n" : "");
		const summaryText = `${JSON.stringify(this.summary(), null, 2)}\n`;
		const callsRef = await store.writeTextArtifact("tool-calls", callsText);
		const summaryRef = await store.writeTextArtifact(
			"tool-calls-summary",
			summaryText,
		);
		return [callsRef, summaryRef];
	}

	private addRecord(record: ToolCallTelemetryRecord): void {
		this.observedCalls += 1;
		if (this.records.length >= MAX_RECORDS) {
			this.droppedRecords += 1;
			return;
		}
		this.records.push(record);
	}

	private summary(): ToolCallTelemetrySummary {
		const callsByTool: Record<string, number> = {};
		const callsByCategory: Record<string, number> = {};
		const errorsByTool: Record<string, number> = {};
		const errorsByCategory: Record<string, number> = {};
		const statusCounts: Record<ToolCallStatus, number> = {
			completed: 0,
			failed: 0,
			incomplete: 0,
		};
		const urls: string[] = [];
		const hosts: string[] = [];

		for (const record of this.records) {
			increment(callsByTool, record.toolName);
			increment(callsByCategory, record.category);
			statusCounts[record.status] += 1;
			if (record.isError) {
				increment(errorsByTool, record.toolName);
				increment(errorsByCategory, record.category);
			}
			for (const summary of [record.argsSummary, record.resultSummary]) {
				for (const resource of summary.resources) {
					uniquePush(urls, resource.value, MAX_RESOURCE_SAMPLES);
					uniquePush(hosts, resource.host, MAX_RESOURCE_SAMPLES);
				}
			}
		}

		return {
			schemaVersion: TOOL_CALL_SCHEMA_VERSION,
			enabled: true,
			totalCalls: this.observedCalls,
			callsByTool,
			callsByCategory,
			errorsByTool,
			errorsByCategory,
			statusCounts,
			resources: { urls, hosts },
			droppedRecords: this.droppedRecords,
			limits: {
				updatesCaptured: false,
				fullArgsStored: false,
				fullResultsStored: false,
				failedArgsStored: true,
				failedResultsStored: true,
				maxRecords: MAX_RECORDS,
				maxSummaryDepth: MAX_SUMMARY_DEPTH,
				maxKeys: MAX_KEYS,
				maxResourceSamples: MAX_RESOURCE_SAMPLES,
				maxDetailStringLength: MAX_DETAIL_STRING_LENGTH,
				maxDetailArrayItems: MAX_DETAIL_ARRAY_ITEMS,
				maxDetailDepth: MAX_DETAIL_DEPTH,
			},
		};
	}
}

export async function flushToolCallTelemetry(
	collector: ToolCallTelemetryCollector | undefined,
	store: AttemptStoreLike,
): Promise<ArtifactRef[]> {
	if (collector === undefined) return [];
	try {
		return await collector.flush(store);
	} catch {
		return [];
	}
}
