import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Component } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResultEnvelope, RunEvent } from "./artifacts/index.ts";
import type { Status } from "./core/constants.ts";
import { mapWithConcurrency } from "./core/concurrency.ts";
import { fingerprintFiles } from "./core/file-fingerprint.ts";
import { clip, stripAnsi, visibleLength } from "./core/text-width.ts";
import {
	listRecentRunLocators,
	listRunLocators,
	locatorOlderThanPruneThreshold,
	removeRunLocator,
	type RunLocatorCache,
	type RunRefLocator,
} from "./orchestrate/run-ref.ts";
import {
	summarizeChildEvents,
	type RunChildSummary,
} from "./orchestrate/status.ts";

const DEFAULT_RUNS_DIR = ".pi/agent/runs";
const LIVE_REFRESH_MS = 1_500;
const LOG_TAIL_LINES = 5;
const STALE_RUN_AFTER_MS = 30_000;
const PANEL_MIN_LINES = 12;
const PANEL_MAX_LINES = 30;
const PANEL_RESERVED_TUI_LINES = 8;
const DEFAULT_RECENT_TERMINAL_LIMIT = 20;
const ALL_SCOPE_RECENT_TERMINAL_LIMIT = 50;
const INDEX_LOAD_CONCURRENCY = 32;
const BACKGROUND_BACKOFF_FACTOR = 2;
/** Background loads bypass the file caches at least this often per scope. */
const CACHE_REVALIDATE_MS = 30_000;

type ScopeFilter = "session" | "cwd" | "all";
type StatusFilter = "all" | "running" | "completed" | "failed";
type FocusGroup = "scope" | "status" | "detail";

interface TaskRow {
	attemptId: string;
	status: Status;
	backend: string;
	failureKind: string | null;
	startedAt: string;
	completedAt: string | null;
	durationMs: number | null;
	resultPath: string;
	logPath: string | null;
	logTail: string[];
	workspace: string;
	worktreePath: string | null;
	modelLabel: string;
}

interface RunRow {
	key: string;
	runId: string;
	/** Requested agent name recorded in run.json, when known. */
	agent: string | null;
	sourceCwd: string;
	runsDir: string;
	status: Status;
	backend: string;
	updatedMs: number;
	startedAt: string;
	completedAt: string | null;
	dependency: string | null;
	eventTail: string[];
	childSummary?: RunChildSummary;
	tasks: TaskRow[];
}

interface PanelSnapshot {
	runs: RunRow[];
	totalRuns: number;
	hiddenRuns: number;
	loadedAt: Date;
	staleLocators: number;
	invalidLocators: number;
	skippedLocators: number;
}

interface PanelTheme {
	// Method signatures are intentionally used so the host Theme (with a narrower
	// ThemeColor union) remains assignable under bivariant method checks.
	fg?(color: string, text: string): string;
	bg?(color: string, text: string): string;
	bold?(text: string): string;
}

interface PanelTui {
	requestRender?: () => void;
}

interface LoadOptions {
	cwd: string;
	scope: ScopeFilter;
	statusFilter: StatusFilter;
	currentSessionId?: string;
	showMorePages: number;
	/** Per-panel caches for indexed (global) runs; omitted = always re-read. */
	cache?: PanelLoadCache;
	/** Ignore cache hits for this load (manual refresh). */
	fresh?: boolean;
}

/** A finished indexed run, reusable while its files are unchanged. */
interface CachedRunRow {
	fingerprint: string;
	resultPaths: string[];
	parentSessionId?: string;
	row: RunRow;
}

interface PanelLoadCache {
	locators: RunLocatorCache;
	runs: Map<string, CachedRunRow>;
	/** Test seam: finished runs served from the cache without re-reading. */
	runHits: number;
}

function isInsideOrEqual(parent: string, child: string): boolean {
	const childRelative = relative(parent, child);
	return (
		childRelative === "" ||
		(!childRelative.startsWith("..") && !isAbsolute(childRelative))
	);
}

function safeRelative(cwd: string, path: string): string {
	const rel = relative(cwd, path);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return path;
	return rel.split(sep).join("/");
}

function style(theme: PanelTheme, color: string, text: string): string {
	return theme.fg?.(color, text) ?? text;
}

function bold(theme: PanelTheme, text: string): string {
	return theme.bold?.(text) ?? text;
}

function pad(text: string, width: number): string {
	const visible = visibleLength(text);
	return visible >= width
		? clip(text, width)
		: text + " ".repeat(width - visible);
}

function sanitizeRunText(text: string, currentSessionId?: string): string {
	let sanitized = stripAnsi(text)
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
		.replace(/\r/g, "");
	if (currentSessionId && currentSessionId.length > 0)
		sanitized = sanitized.split(currentSessionId).join("[session]");
	return sanitized;
}

function nowMs(): number {
	const raw = process.env.PI_SUBAGENT_PANEL_NOW_MS;
	if (raw !== undefined && raw.length > 0) {
		const parsed = Number.parseInt(raw, 10);
		if (Number.isFinite(parsed)) return parsed;
	}
	return Date.now();
}

function fmtAge(ms: number, now = nowMs()): string {
	const delta = Math.max(0, now - ms);
	if (delta < 1_000) return "now";
	if (delta < 60_000) return `${Math.floor(delta / 1_000)}s ago`;
	if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
	return `${Math.floor(delta / 3_600_000)}h ago`;
}

function fmtElapsed(startedAt: string, completedAt: string | null): string {
	const start = Date.parse(startedAt);
	const end = completedAt === null ? nowMs() : Date.parse(completedAt);
	if (!Number.isFinite(start) || !Number.isFinite(end)) return "—";
	const seconds = Math.max(0, Math.floor((end - start) / 1_000));
	const mins = Math.floor(seconds / 60);
	const secs = seconds % 60;
	return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function statusPriority(status: Status): number {
	if (status === "running") return 0;
	if (status === "pending") return 1;
	if (status === "failed") return 2;
	if (status === "cancelled") return 3;
	return 4;
}

function aggregateRunStatus(attempts: TaskRow[]): Status {
	return attempts.at(-1)?.status ?? "pending";
}

function aggregateLegacyRunStatus(attempts: TaskRow[]): Status {
	if (attempts.some((attempt) => attempt.status === "running"))
		return "running";
	if (attempts.some((attempt) => attempt.status === "pending"))
		return "pending";
	if (attempts.some((attempt) => attempt.status === "failed")) return "failed";
	if (attempts.some((attempt) => attempt.status === "cancelled"))
		return "cancelled";
	return attempts.length === 0 ? "pending" : "completed";
}

export function isEscapeKey(data: string): boolean {
	return (
		data === "\u001b" ||
		data === "escape" ||
		data === "esc" ||
		data === "Esc" ||
		data === "ctrl+[" ||
		data.startsWith("escape") ||
		data.startsWith("esc") ||
		/^\u001b\[27(?:;\d+)?(?::\d+)?u$/.test(data)
	);
}

export function isEnterKey(data: string): boolean {
	return (
		data === "\r" ||
		data === "\n" ||
		data === "enter" ||
		data === "return" ||
		data === "\u001b[13u"
	);
}

function isTabKey(data: string): boolean {
	return data === "\t" || data === "tab" || data === "\u001b[9u";
}

function isPageKey(data: string, direction: "up" | "down"): boolean {
	if (direction === "up")
		return data === "pageup" || data === "pgup" || data === "\u001b[5~";
	return data === "pagedown" || data === "pgdown" || data === "\u001b[6~";
}

export function isArrowKey(
	data: string,
	direction: "up" | "down" | "left" | "right",
): boolean {
	if (data === direction) return true;
	const legacy: Record<typeof direction, string[]> = {
		up: ["\u001b[A", "\u001bOA", "\u001b[a"],
		down: ["\u001b[B", "\u001bOB", "\u001b[b"],
		left: ["\u001b[D", "\u001bOD", "\u001b[d"],
		right: ["\u001b[C", "\u001bOC", "\u001b[c"],
	};
	if (legacy[direction].includes(data)) return true;
	const suffix: Record<typeof direction, string> = {
		up: "A",
		down: "B",
		right: "C",
		left: "D",
	};
	return new RegExp(`^\\u001b\\[1;\\d+(?::\\d+)?${suffix[direction]}$`).test(
		data,
	);
}

function statusColor(status: Status): string {
	if (status === "completed") return "success";
	if (status === "running" || status === "pending") return "warning";
	if (status === "failed" || status === "cancelled") return "error";
	return "accent";
}

function statusLabel(status: Status): string {
	if (status === "completed") return "done";
	return status;
}

function childFailureCount(summary: RunChildSummary | undefined): number {
	return (summary?.failed ?? 0) + (summary?.cancelled ?? 0);
}

function runHasFailure(run: Pick<RunRow, "status" | "childSummary">): boolean {
	return (
		run.status === "failed" ||
		run.status === "cancelled" ||
		childFailureCount(run.childSummary) > 0
	);
}

function runStatusLabel(run: Pick<RunRow, "status" | "childSummary">): string {
	const base = statusLabel(run.status);
	return childFailureCount(run.childSummary) > 0 ? `${base}+child` : base;
}

function runStatusDetail(run: Pick<RunRow, "status" | "childSummary">): string {
	const failures = childFailureCount(run.childSummary);
	return failures > 0
		? `${statusLabel(run.status)} (child failures: ${failures})`
		: statusLabel(run.status);
}

function runStatusColor(run: Pick<RunRow, "status" | "childSummary">): string {
	return childFailureCount(run.childSummary) > 0
		? "error"
		: statusColor(run.status);
}

function isActive(status: Status): boolean {
	return status === "pending" || status === "running";
}

function pidAlive(pid: number | undefined): boolean {
	if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (
			error !== null &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "EPERM"
		);
	}
}

function timestampFresh(
	value: string | undefined,
	staleAfterMs = STALE_RUN_AFTER_MS,
): boolean {
	if (value === undefined) return false;
	const time = Date.parse(value);
	return Number.isFinite(time) && nowMs() - time <= staleAfterMs;
}

function runKey(cwd: string, runsDir: string, runId: string): string {
	return `${cwd}\u0000${runsDir}\u0000${runId}`;
}

async function readJson(path: string): Promise<unknown | null> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return null;
	}
}

function isResultEnvelope(value: unknown): value is ResultEnvelope {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { runId?: unknown }).runId === "string" &&
		(typeof (value as { attemptId?: unknown }).attemptId === "string" ||
			typeof (value as { taskId?: unknown }).taskId === "string")
	);
}

interface RegistryTaskRecord {
	attemptId?: string;
	taskId?: string;
	status: Status;
	backend?: string;
	failureKind?: string | null;
	startedAt?: string;
	completedAt?: string | null;
	updatedAt?: string;
	heartbeatAt?: string;
	artifactCwd?: string;
	resultPath?: string;
	outputPath?: string;
	stdoutPath?: string;
	stderrPath?: string;
	process?: { pid?: number; workerPid?: number };
	workspace?: { cwd?: string; worktreePath?: string | null };
}

interface RegistryRunRecord {
	runId: string;
	agent?: string;
	mode?: string;
	status: Status;
	backend?: string;
	dependency?: string | null;
	parentSessionId?: string;
	startedAt: string;
	updatedAt: string;
	completedAt: string | null;
	attempts?: RegistryTaskRecord[];
	tasks?: RegistryTaskRecord[];
}

function isRegistryRunRecord(value: unknown): value is RegistryRunRecord {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { runId?: unknown }).runId === "string" &&
		typeof (value as { startedAt?: unknown }).startedAt === "string" &&
		typeof (value as { updatedAt?: unknown }).updatedAt === "string" &&
		(Array.isArray((value as { attempts?: unknown }).attempts) ||
			Array.isArray((value as { tasks?: unknown }).tasks))
	);
}

function parseRunEvents(text: string): RunEvent[] {
	return text
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line) as RunEvent;
			} catch {
				return null;
			}
		})
		.filter((event): event is RunEvent => event !== null);
}

async function readTextTail(
	path: string,
	currentSessionId?: string,
): Promise<string[]> {
	const text = await readFile(path, "utf8").catch(() => "");
	return text
		.split(/\r?\n/)
		.map((line) => sanitizeRunText(line, currentSessionId))
		.filter(Boolean)
		.slice(-LOG_TAIL_LINES);
}

async function readLogTail(
	cwd: string,
	result: ResultEnvelope,
	loadTails: boolean,
	currentSessionId?: string,
): Promise<{ path: string | null; tail: string[] }> {
	const artifact =
		result.artifacts.find((candidate) => candidate.type === "output") ??
		result.artifacts.find((candidate) => candidate.type === "stdout") ??
		result.artifacts.find((candidate) => candidate.type === "stderr");
	if (artifact === undefined) return { path: null, tail: [] };
	if (isAbsolute(artifact.path) || artifact.path.split("/").includes(".."))
		return { path: artifact.path, tail: [] };
	const path = resolve(cwd, artifact.path.split("/").join(sep));
	if (!isInsideOrEqual(cwd, path)) return { path: artifact.path, tail: [] };
	const tail = loadTails ? await readTextTail(path, currentSessionId) : [];
	return { path: artifact.path, tail };
}

function modelLabel(result: ResultEnvelope): string {
	return typeof result.metadata?.model === "string"
		? result.metadata.model
		: "";
}

async function readTask(
	cwd: string,
	resultPath: string,
	mtimeMs: number,
	loadTails: boolean,
	currentSessionId?: string,
	options: { staleOverride?: boolean } = {},
): Promise<TaskRow | null> {
	const parsed = await readJson(resultPath);
	if (!isResultEnvelope(parsed)) return null;
	const log = await readLogTail(cwd, parsed, loadTails, currentSessionId);
	const stale =
		isActive(parsed.status) &&
		(options.staleOverride ?? nowMs() - mtimeMs > STALE_RUN_AFTER_MS);
	return {
		attemptId: parsed.attemptId ?? parsed.taskId ?? "unknown",
		status: stale ? "failed" : parsed.status,
		backend: parsed.backend,
		failureKind: stale ? "stale" : parsed.failureKind,
		startedAt: parsed.startedAt,
		completedAt: stale ? new Date(mtimeMs).toISOString() : parsed.completedAt,
		durationMs: parsed.durationMs,
		resultPath: safeRelative(cwd, resultPath),
		logPath: log.path,
		logTail: log.tail,
		workspace: parsed.workspace.cwd,
		worktreePath: parsed.workspace.worktreePath,
		modelLabel: modelLabel(parsed),
	};
}

async function readTailFromRegistryPath(
	task: RegistryTaskRecord,
	loadTails: boolean,
	currentSessionId?: string,
): Promise<{ path: string | null; tail: string[] }> {
	const artifactCwd = task.artifactCwd;
	const path = task.outputPath ?? task.stdoutPath ?? task.stderrPath;
	if (
		artifactCwd === undefined ||
		path === undefined ||
		isAbsolute(path) ||
		path.split("/").includes("..")
	)
		return { path: path ?? null, tail: [] };
	const absolute = resolve(artifactCwd, path.split("/").join(sep));
	if (!isInsideOrEqual(resolve(artifactCwd), absolute))
		return { path, tail: [] };
	const tail = loadTails ? await readTextTail(absolute, currentSessionId) : [];
	return { path, tail };
}

function registryTaskStale(task: RegistryTaskRecord): boolean {
	if (!isActive(task.status)) return false;
	if (pidAlive(task.process?.pid) || pidAlive(task.process?.workerPid))
		return false;
	if (timestampFresh(task.heartbeatAt) || timestampFresh(task.updatedAt))
		return false;
	return true;
}

/** The result.json a registry attempt points at, when it is safely inside its artifact cwd. */
function registryResultPath(task: RegistryTaskRecord): string | undefined {
	if (
		task.artifactCwd === undefined ||
		task.resultPath === undefined ||
		isAbsolute(task.resultPath) ||
		task.resultPath.split("/").includes("..")
	)
		return undefined;
	const absolute = resolve(
		task.artifactCwd,
		task.resultPath.split("/").join(sep),
	);
	return isInsideOrEqual(resolve(task.artifactCwd), absolute)
		? absolute
		: undefined;
}

async function readTaskFromRegistry(
	cwd: string,
	task: RegistryTaskRecord,
	loadTails: boolean,
	currentSessionId?: string,
): Promise<TaskRow> {
	const registryStale = registryTaskStale(task);
	const absolute = registryResultPath(task);
	if (task.artifactCwd !== undefined && absolute !== undefined) {
		const statInfo = await stat(absolute).catch(() => null);
		if (statInfo !== null) {
			const parsed = await readTask(
				task.artifactCwd,
				absolute,
				statInfo.mtimeMs,
				loadTails,
				currentSessionId,
				isActive(task.status) ? { staleOverride: registryStale } : undefined,
			);
			if (parsed !== null) return parsed;
		}
	}
	const log = await readTailFromRegistryPath(task, loadTails, currentSessionId);
	const stale = registryStale;
	return {
		attemptId: task.attemptId ?? task.taskId ?? "unknown",
		status: stale ? "failed" : task.status,
		backend: task.backend ?? "unknown",
		failureKind: stale ? "stale" : (task.failureKind ?? null),
		startedAt:
			task.startedAt ?? task.updatedAt ?? new Date(nowMs()).toISOString(),
		completedAt:
			task.completedAt ??
			(stale
				? (task.updatedAt ??
					task.heartbeatAt ??
					new Date(nowMs()).toISOString())
				: null),
		durationMs: null,
		resultPath: task.resultPath ?? "—",
		logPath: log.path,
		logTail: log.tail,
		workspace: task.workspace?.cwd ?? cwd,
		worktreePath: task.workspace?.worktreePath ?? null,
		modelLabel: "",
	};
}

async function readRunFromRegistry(
	cwd: string,
	runsDir: string,
	runDir: string,
	registry: RegistryRunRecord,
	loadTails: boolean,
	currentSessionId?: string,
): Promise<RunRow | null> {
	const eventsText = await readFile(join(runDir, "events.jsonl"), "utf8").catch(
		() => "",
	);
	const eventTail = loadTails
		? eventsText
				.split(/\r?\n/)
				.map((line) => sanitizeRunText(line, currentSessionId))
				.filter(Boolean)
				.slice(-LOG_TAIL_LINES)
		: [];
	const childSummary = summarizeChildEvents(parseRunEvents(eventsText));
	const records = registry.attempts ?? registry.tasks ?? [];
	const recordedActive = records.some((record) => isActive(record.status));
	const tasks = await Promise.all(
		records.map((task) =>
			readTaskFromRegistry(cwd, task, loadTails, currentSessionId),
		),
	);
	tasks.sort((a, b) =>
		a.attemptId.localeCompare(b.attemptId, undefined, { numeric: true }),
	);
	const registryStatus = registry.status ?? aggregateRunStatus(tasks);
	// run.json keeps saying "running" when its worker died (or finished)
	// without finalizing the run. Attempts recorded as active were already
	// checked against their process, heartbeat, and result file; when none of
	// them is still active, neither is the run.
	const settled =
		isActive(registryStatus) &&
		recordedActive &&
		tasks.length > 0 &&
		!tasks.some((task) => isActive(task.status));
	return {
		key: runKey(cwd, runsDir, registry.runId),
		runId: registry.runId,
		agent:
			typeof registry.agent === "string" && registry.agent.length > 0
				? registry.agent
				: null,
		sourceCwd: cwd,
		runsDir,
		status: settled ? aggregateRunStatus(tasks) : registryStatus,
		backend:
			registry.backend ??
			tasks.at(-1)?.backend ??
			tasks[0]?.backend ??
			"unknown",
		updatedMs: Number.isFinite(Date.parse(registry.updatedAt))
			? Date.parse(registry.updatedAt)
			: nowMs(),
		startedAt: registry.startedAt,
		completedAt:
			settled && registry.completedAt === null
				? (tasks
						.map((task) => task.completedAt)
						.filter((value): value is string => value !== null)
						.sort()
						.at(-1) ?? null)
				: registry.completedAt,
		dependency: registry.dependency ?? null,
		eventTail,
		...(childSummary === undefined ? {} : { childSummary }),
		tasks,
	};
}

async function loadRunsFromCwd(
	cwd: string,
	options: Pick<LoadOptions, "currentSessionId"> & { sessionOnly?: string },
): Promise<{
	runs: RunRow[];
	stale: number;
	invalid: number;
	skipped: number;
}> {
	const runsDir = resolve(cwd, DEFAULT_RUNS_DIR);
	if (!isInsideOrEqual(cwd, runsDir))
		return { runs: [], stale: 0, invalid: 0, skipped: 0 };
	const runEntries = await readdir(runsDir, { withFileTypes: true }).catch(
		() => [],
	);
	const runs: RunRow[] = [];
	let invalid = 0;

	for (const runEntry of runEntries) {
		// Hidden entries such as the `.locks` directory are not runs.
		if (!runEntry.isDirectory() || runEntry.name.startsWith(".")) continue;
		const runDir = join(runsDir, runEntry.name);
		const registry = await readJson(join(runDir, "run.json"));
		if (isRegistryRunRecord(registry)) {
			if (
				options.sessionOnly !== undefined &&
				registry.parentSessionId !== options.sessionOnly
			)
				continue;
			const row = await readRunFromRegistry(
				cwd,
				DEFAULT_RUNS_DIR,
				runDir,
				registry,
				true,
				options.currentSessionId,
			).catch(() => null);
			if (row !== null) runs.push(row);
			else invalid += 1;
			continue;
		}

		if (options.sessionOnly !== undefined) continue;

		const taskEntries = await readdir(runDir, { withFileTypes: true }).catch(
			() => [],
		);
		const attemptEntries = await readdir(join(runDir, "attempts"), {
			withFileTypes: true,
		}).catch(() => []);
		const candidates = [
			...attemptEntries
				.filter((entry) => entry.isDirectory())
				.map((entry) => join(runDir, "attempts", entry.name, "result.json")),
			...taskEntries
				.filter((entry) => entry.isDirectory() && entry.name !== "attempts")
				.map((entry) => join(runDir, entry.name, "result.json")),
		];
		const eventsText = await readFile(
			join(runDir, "events.jsonl"),
			"utf8",
		).catch(() => "");
		const eventTail = eventsText
			.split(/\r?\n/)
			.map((line) => sanitizeRunText(line, options.currentSessionId))
			.filter(Boolean)
			.slice(-LOG_TAIL_LINES);
		const childSummary = summarizeChildEvents(parseRunEvents(eventsText));
		const tasks: TaskRow[] = [];
		let updatedMs = 0;
		for (const resultPath of candidates) {
			const resultStat = await stat(resultPath).catch(() => null);
			if (resultStat === null) continue;
			updatedMs = Math.max(updatedMs, resultStat.mtimeMs);
			const task = await readTask(
				cwd,
				resultPath,
				resultStat.mtimeMs,
				true,
				options.currentSessionId,
			);
			if (task !== null) tasks.push(task);
		}
		if (tasks.length === 0) continue;
		tasks.sort((a, b) =>
			a.attemptId.localeCompare(b.attemptId, undefined, { numeric: true }),
		);
		const status = aggregateLegacyRunStatus(tasks);
		runs.push({
			key: runKey(cwd, DEFAULT_RUNS_DIR, runEntry.name),
			runId: runEntry.name,
			agent: null,
			sourceCwd: cwd,
			runsDir: DEFAULT_RUNS_DIR,
			status,
			backend: tasks[0]?.backend ?? "unknown",
			updatedMs,
			startedAt:
				tasks.map((task) => task.startedAt).sort()[0] ??
				new Date(updatedMs).toISOString(),
			completedAt: tasks.every((task) => task.completedAt !== null)
				? (tasks
						.map((task) => task.completedAt)
						.sort()
						.at(-1) ?? null)
				: null,
			dependency: null,
			eventTail,
			...(childSummary === undefined ? {} : { childSummary }),
			tasks,
		});
	}
	return { runs, stale: 0, invalid, skipped: 0 };
}

/**
 * Files a registry-backed row is built from when tails are not loaded:
 * run.json, events.jsonl, and every attempt's result.json.
 */
async function runFilesFingerprint(
	runDir: string,
	resultPaths: readonly string[],
): Promise<string> {
	return await fingerprintFiles([
		join(runDir, "run.json"),
		join(runDir, "events.jsonl"),
		...resultPaths,
	]);
}

/**
 * Only settled runs are cached: active rows depend on the clock (staleness),
 * and so does a run whose run.json still says active but whose attempts were
 * found dead.
 */
function isCacheableRun(row: RunRow, registry: RegistryRunRecord): boolean {
	return (
		!isActive(registry.status) &&
		!isActive(row.status) &&
		row.tasks.every((task) => !isActive(task.status)) &&
		Number.isFinite(Date.parse(registry.updatedAt))
	);
}

async function loadRunFromLocator(
	locator: RunRefLocator,
	options: Pick<LoadOptions, "scope" | "currentSessionId" | "cache" | "fresh">,
): Promise<{
	row: RunRow | null;
	stale: boolean;
	invalid: boolean;
	pruned: boolean;
}> {
	try {
		const cwd = resolve(locator.cwd);
		const runsDir = locator.runsDir ?? DEFAULT_RUNS_DIR;
		const absoluteRunsDir = resolve(cwd, runsDir);
		if (!isInsideOrEqual(cwd, absoluteRunsDir))
			return { row: null, stale: false, invalid: true, pruned: false };
		const runDir = join(absoluteRunsDir, locator.runId);
		const cacheKey = runKey(cwd, runsDir, locator.runId);
		const runDirStat = await stat(runDir).catch(() => null);
		if (runDirStat === null || !runDirStat.isDirectory()) {
			options.cache?.runs.delete(cacheKey);
			if (
				locatorOlderThanPruneThreshold(locator) &&
				(await removeRunLocator(locator.runId))
			) {
				return { row: null, stale: false, invalid: false, pruned: true };
			}
			return { row: null, stale: true, invalid: false, pruned: false };
		}
		const outsideSession = (parentSessionId: string | undefined): boolean =>
			options.scope === "session" &&
			(options.currentSessionId === undefined ||
				parentSessionId !== options.currentSessionId);
		const cached = options.fresh
			? undefined
			: options.cache?.runs.get(cacheKey);
		if (
			cached !== undefined &&
			(await runFilesFingerprint(runDir, cached.resultPaths)) ===
				cached.fingerprint
		) {
			if (outsideSession(cached.parentSessionId))
				return { row: null, stale: false, invalid: false, pruned: false };
			if (options.cache !== undefined) options.cache.runHits += 1;
			return { row: cached.row, stale: false, invalid: false, pruned: false };
		}
		// Fingerprint run.json/events.jsonl before reading them: a write racing
		// the read then leaves a stale fingerprint, so the next load re-reads.
		const headFingerprint =
			options.cache === undefined
				? undefined
				: await runFilesFingerprint(runDir, []);
		const registry = await readJson(join(runDir, "run.json"));
		if (!isRegistryRunRecord(registry)) {
			options.cache?.runs.delete(cacheKey);
			return { row: null, stale: false, invalid: true, pruned: false };
		}
		if (outsideSession(registry.parentSessionId))
			return { row: null, stale: false, invalid: false, pruned: false };
		const resultPaths = (registry.attempts ?? registry.tasks ?? [])
			.map(registryResultPath)
			.filter((path): path is string => path !== undefined);
		const resultFingerprint =
			options.cache === undefined
				? undefined
				: await fingerprintFiles(resultPaths);
		const row = await readRunFromRegistry(
			cwd,
			runsDir,
			runDir,
			registry,
			false,
			options.currentSessionId,
		);
		if (options.cache !== undefined) {
			if (
				row !== null &&
				headFingerprint !== undefined &&
				resultFingerprint !== undefined &&
				isCacheableRun(row, registry)
			) {
				options.cache.runs.set(cacheKey, {
					fingerprint: [headFingerprint, resultFingerprint]
						.filter((part) => part.length > 0)
						.join(","),
					resultPaths,
					...(registry.parentSessionId === undefined
						? {}
						: { parentSessionId: registry.parentSessionId }),
					row,
				});
			} else options.cache.runs.delete(cacheKey);
		}
		return { row, stale: row === null, invalid: false, pruned: false };
	} catch {
		return { row: null, stale: false, invalid: true, pruned: false };
	}
}

function statusMatches(run: RunRow, filter: StatusFilter): boolean {
	if (filter === "all") return true;
	if (filter === "running")
		return run.status === "running" || run.status === "pending";
	if (filter === "completed")
		return run.status === "completed" && !runHasFailure(run);
	return runHasFailure(run);
}

function recentTerminalLimit(
	scope: ScopeFilter,
	showMorePages: number,
): number {
	const base =
		scope === "all"
			? ALL_SCOPE_RECENT_TERMINAL_LIMIT
			: DEFAULT_RECENT_TERMINAL_LIMIT;
	return base * Math.max(1, showMorePages + 1);
}

function compareRecentRuns(a: RunRow, b: RunRow): number {
	return b.updatedMs - a.updatedMs || a.key.localeCompare(b.key);
}

function takeRecentRuns(runs: RunRow[], limit: number): RunRow[] {
	if (runs.length <= limit) return runs;
	const visibleKeys = new Set(
		runs
			.toSorted(compareRecentRuns)
			.slice(0, limit)
			.map((run) => run.key),
	);
	return runs.filter((run) => visibleKeys.has(run.key));
}

function limitRunsForPanel(
	runs: RunRow[],
	options: Pick<LoadOptions, "scope" | "statusFilter" | "showMorePages">,
): { runs: RunRow[]; hiddenRuns: number } {
	if (options.statusFilter === "running") return { runs, hiddenRuns: 0 };
	const limit = recentTerminalLimit(options.scope, options.showMorePages);
	if (options.statusFilter !== "all") {
		const limited = takeRecentRuns(runs, limit);
		return {
			runs: limited,
			hiddenRuns: Math.max(0, runs.length - limited.length),
		};
	}
	const active = runs.filter((run) => isActive(run.status));
	const terminal = runs.filter((run) => !isActive(run.status));
	const limitedTerminal = takeRecentRuns(terminal, limit);
	return {
		runs: [...active, ...limitedTerminal],
		hiddenRuns: Math.max(0, terminal.length - limitedTerminal.length),
	};
}

/** Every run of one scope, before status filtering and paging. */
interface LoadedScope {
	runs: RunRow[];
	loadedAt: Date;
	stale: number;
	invalid: number;
	skipped: number;
}

async function loadScope(
	options: Pick<
		LoadOptions,
		"cwd" | "scope" | "currentSessionId" | "cache" | "fresh"
	>,
): Promise<LoadedScope> {
	const effectiveScope =
		options.scope === "session" && options.currentSessionId === undefined
			? "cwd"
			: options.scope;
	const loaded = await loadRunsForScope({
		...options,
		scope: effectiveScope,
		statusFilter: "all",
		showMorePages: 0,
	});
	const unique = new Map<string, RunRow>();
	for (const run of loaded.runs) unique.set(run.key, run);
	const runs = [...unique.values()].sort(
		(a, b) =>
			statusPriority(a.status) - statusPriority(b.status) ||
			b.updatedMs - a.updatedMs ||
			a.key.localeCompare(b.key),
	);
	return {
		runs,
		loadedAt: new Date(nowMs()),
		stale: loaded.stale,
		invalid: loaded.invalid,
		skipped: loaded.skipped,
	};
}

/** Apply the status filter and paging to an already loaded scope (no I/O). */
function projectSnapshot(
	loaded: LoadedScope,
	options: Pick<LoadOptions, "scope" | "statusFilter" | "showMorePages">,
): PanelSnapshot {
	const filtered = loaded.runs.filter((run) =>
		statusMatches(run, options.statusFilter),
	);
	const limited = limitRunsForPanel(filtered, options);
	return {
		runs: limited.runs,
		totalRuns: filtered.length,
		hiddenRuns: limited.hiddenRuns,
		loadedAt: loaded.loadedAt,
		staleLocators: loaded.stale,
		invalidLocators: loaded.invalid,
		skippedLocators: loaded.skipped,
	};
}

async function mergeLoadedRuns(
	...groups: Array<{
		runs: RunRow[];
		stale: number;
		invalid: number;
		skipped: number;
	}>
): Promise<{
	runs: RunRow[];
	stale: number;
	invalid: number;
	skipped: number;
}> {
	return {
		runs: groups.flatMap((group) => group.runs),
		stale: groups.reduce((sum, group) => sum + group.stale, 0),
		invalid: groups.reduce((sum, group) => sum + group.invalid, 0),
		skipped: groups.reduce((sum, group) => sum + group.skipped, 0),
	};
}

async function loadRunsForScope(options: LoadOptions): Promise<{
	runs: RunRow[];
	stale: number;
	invalid: number;
	skipped: number;
}> {
	if (options.scope === "cwd") {
		// Indexed runs recorded for this workspace include runs kept under a
		// custom runsDir (e.g. `.pi/agent/runs/<batch>/<task>/`), which the
		// direct scan below cannot find.
		const indexed = await loadRunsFromIndex(options);
		const local = await loadRunsFromCwd(options.cwd, options);
		return mergeLoadedRuns(indexed, local);
	}
	if (options.scope === "session") {
		const indexed = await loadRunsFromIndex(options);
		if (options.currentSessionId === undefined) return indexed;
		const local = await loadRunsFromCwd(options.cwd, {
			currentSessionId: options.currentSessionId,
			sessionOnly: options.currentSessionId,
		});
		return mergeLoadedRuns(indexed, local);
	}
	const indexed = await loadRunsFromIndex(options);
	const local = await loadRunsFromCwd(options.cwd, options);
	return mergeLoadedRuns(indexed, local);
}

/** A workspace path and its symlink-resolved form; locators may record either. */
async function workspaceKeys(cwd: string): Promise<Set<string>> {
	const resolved = resolve(cwd);
	const real = await realpath(resolved).catch(() => resolved);
	return new Set([resolved, real]);
}

async function loadRunsFromIndex(options: LoadOptions): Promise<{
	runs: RunRow[];
	stale: number;
	invalid: number;
	skipped: number;
}> {
	const listed = await listRunLocators({
		...(options.cache === undefined ? {} : { cache: options.cache.locators }),
		...(options.fresh === true ? { fresh: true } : {}),
	});
	const cwdKeys =
		options.scope === "cwd" ? await workspaceKeys(options.cwd) : undefined;
	const locators = listed.locators.filter((locator) => {
		if (options.scope === "session" && options.currentSessionId !== undefined)
			return locator.parentSessionId === options.currentSessionId;
		if (cwdKeys !== undefined) return cwdKeys.has(locator.cwd);
		return true;
	});
	const runs: RunRow[] = [];
	let stale = 0;
	let invalid = listed.invalidCount;
	let pruned = listed.prunedCount;
	// Each locator costs several small reads; loading them one by one made the
	// `all` scope take seconds per refresh.
	const results = await mapWithConcurrency(
		locators,
		INDEX_LOAD_CONCURRENCY,
		(locator) => loadRunFromLocator(locator, options),
	);
	for (const loaded of results) {
		if (loaded.row !== null) runs.push(loaded.row);
		if (loaded.stale) stale += 1;
		if (loaded.invalid) invalid += 1;
		if (loaded.pruned) pruned += 1;
	}
	return {
		runs,
		stale,
		invalid,
		skipped: listed.skippedCount + pruned,
	};
}

function splitLine(left: string, right: string, width: number): string {
	const gap = width - visibleLength(left) - visibleLength(right);
	if (gap <= 1) return clip(`${left} ${right}`, width);
	return `${left}${" ".repeat(gap)}${right}`;
}

function border(width: number): string {
	return "─".repeat(Math.max(1, width));
}

function panelLineBudget(): number {
	const rows = process.stdout.rows;
	if (typeof rows !== "number" || !Number.isFinite(rows) || rows <= 0)
		return PANEL_MAX_LINES;
	return Math.max(
		PANEL_MIN_LINES,
		Math.min(PANEL_MAX_LINES, rows - PANEL_RESERVED_TUI_LINES),
	);
}

function currentSessionIdFromCtx(ctx: unknown): string | undefined {
	const raw = ctx as unknown as {
		sessionManager?: { getSessionId?: () => unknown };
	};
	try {
		const id = raw.sessionManager?.getSessionId?.();
		return typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

interface RefreshRequest {
	preserveSelection: boolean;
	fresh: boolean;
}

function emptySnapshot(): PanelSnapshot {
	return {
		runs: [],
		totalRuns: 0,
		loadedAt: new Date(nowMs()),
		hiddenRuns: 0,
		staleLocators: 0,
		invalidLocators: 0,
		skippedLocators: 0,
	};
}

export class SubagentPanel implements Component {
	private snapshot: PanelSnapshot = emptySnapshot();
	/** Latest unfiltered load per scope; filter and paging are projected from it. */
	private readonly loadedByScope = new Map<ScopeFilter, LoadedScope>();
	/** A user-requested refresh that arrived while a load was in flight. */
	private pendingRefresh: RefreshRequest | undefined;
	/** Finished indexed runs and parsed locators, valid while files are unchanged. */
	private readonly loadCache: PanelLoadCache = {
		locators: new Map(),
		runs: new Map(),
		runHits: 0,
	};
	/** Duration and end (performance.now) of the latest load, for timer backoff. */
	private lastLoadMs = 0;
	private lastLoadEndedAt = 0;
	/** performance.now() of each scope's latest cache-bypassing load. */
	private readonly lastFreshLoadAt = new Map<ScopeFilter, number>();
	private selectedRun = 0;
	private showMorePages = 0;
	private scope: ScopeFilter;
	private statusFilter: StatusFilter = "all";
	private focus: FocusGroup = "scope";
	private detailOffset = 0;
	private timer: NodeJS.Timeout | undefined;
	private disposed = false;
	private loading = false;
	/** Run to select (and show in the detail pane) once it first loads. */
	private pendingSelectKey: string | undefined;

	constructor(
		private readonly cwd: string,
		private readonly theme: PanelTheme,
		private readonly tui: PanelTui,
		private readonly done: () => void,
		private readonly currentSessionId?: string,
		initialRunKey?: string,
	) {
		this.scope = currentSessionId === undefined ? "cwd" : "session";
		if (initialRunKey !== undefined) {
			this.pendingSelectKey = initialRunKey;
			this.focus = "detail";
		}
		void this.refresh({ preserveSelection: false });
		this.timer = setInterval(
			() => void this.refresh({ background: true }),
			LIVE_REFRESH_MS,
		);
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer !== undefined) clearInterval(this.timer);
	}

	invalidate(): void {
		// Stateless render; refresh loop owns data invalidation.
	}

	handleInput(data: string): void {
		if (data === "q" || isEscapeKey(data)) {
			this.dispose();
			this.done();
			return;
		}
		if (data === "r") {
			// Manual refresh re-reads everything, bypassing the file caches.
			void this.refresh({ fresh: true });
			return;
		}
		if (data === "m") {
			if (this.snapshot.hiddenRuns > 0) {
				this.showMorePages += 1;
				this.applySnapshot(true);
			}
			return;
		}
		if (isTabKey(data) || data === "shift+tab" || data === "\u001b[Z") {
			const groups: FocusGroup[] = ["scope", "status", "detail"];
			const direction = data === "shift+tab" || data === "\u001b[Z" ? -1 : 1;
			const current = groups.indexOf(this.focus);
			this.focus =
				groups[(current + direction + groups.length) % groups.length] ??
				"scope";
			this.tui.requestRender?.();
			return;
		}
		if (isArrowKey(data, "right") || data === "l") {
			this.cycleFocused(1);
			return;
		}
		if (isArrowKey(data, "left") || data === "h") {
			this.cycleFocused(-1);
			return;
		}
		if (isEnterKey(data)) return;
		if (this.focus === "detail") {
			if (isArrowKey(data, "up") || data === "k") this.scrollDetail(-1);
			if (isArrowKey(data, "down") || data === "j") this.scrollDetail(1);
			if (isPageKey(data, "up")) this.scrollDetail(-8);
			if (isPageKey(data, "down")) this.scrollDetail(8);
			return;
		}
		if (isArrowKey(data, "up") || data === "k") this.moveRun(-1);
		if (isArrowKey(data, "down") || data === "j") this.moveRun(1);
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const maxLines = panelLineBudget();
		const lines: string[] = [];
		const active = this.snapshot.runs.filter((run) =>
			isActive(run.status),
		).length;
		const failed = this.snapshot.runs.filter((run) =>
			runHasFailure(run),
		).length;
		const title = `${style(this.theme, "accent", "●")} ${bold(this.theme, "Subagents")}`;
		const stale = this.snapshot.staleLocators + this.snapshot.invalidLocators;
		const staleText =
			stale > 0 || this.snapshot.skippedLocators > 0
				? ` · stale ${this.snapshot.staleLocators} · skipped ${this.snapshot.invalidLocators + this.snapshot.skippedLocators}`
				: "";
		const loadingView = !this.loadedByScope.has(this.scope);
		const status = loadingView
			? `loading ${this.scope} runs…`
			: `live · ${active} active · ${failed} failed · ${this.snapshot.runs.length}/${this.snapshot.totalRuns} shown${staleText} · updated ${fmtAge(this.snapshot.loadedAt.getTime())}`;
		lines.push(splitLine(title, style(this.theme, "muted", status), safeWidth));
		lines.push(style(this.theme, "border", border(safeWidth)));
		lines.push(this.renderControls(safeWidth));
		lines.push(this.renderScopeHelp(safeWidth));
		lines.push(style(this.theme, "border", border(safeWidth)));

		if (loadingView || this.snapshot.runs.length === 0) {
			const bodyHeight = Math.max(1, maxLines - lines.length - 2);
			const message = loadingView
				? `Loading ${this.scope} runs…`
				: this.emptyMessage();
			lines.push(style(this.theme, "muted", clip(message, safeWidth)));
			for (let index = 1; index < bodyHeight; index += 1) lines.push("");
			lines.push(style(this.theme, "border", border(safeWidth)));
			lines.push(style(this.theme, "dim", this.footerHelp(false)));
			return lines.slice(0, maxLines).map((line) => clip(line, safeWidth));
		}

		let leftWidth = Math.max(30, Math.min(64, Math.floor(safeWidth * 0.42)));
		if (safeWidth - leftWidth - 3 < 30)
			leftWidth = Math.max(18, safeWidth - 33);
		const rightWidth = safeWidth - leftWidth - 3;
		const selectedRun =
			this.snapshot.runs[
				Math.min(this.selectedRun, this.snapshot.runs.length - 1)
			];
		const selectedTask = selectedRun.tasks.at(-1);
		const bodyHeight = Math.max(1, maxLines - lines.length - 2);
		const runLines = this.renderRuns(leftWidth, bodyHeight);
		const detailLines = this.renderDetailWindow(
			this.renderDetail(selectedRun, selectedTask, rightWidth),
			rightWidth,
			bodyHeight,
		);
		const bodyLines = bodyHeight;
		for (let index = 0; index < bodyLines; index += 1) {
			lines.push(
				`${pad(runLines[index] ?? "", leftWidth)} ${style(this.theme, "border", "│")} ${pad(detailLines[index] ?? "", rightWidth)}`,
			);
		}
		lines.push(style(this.theme, "border", border(safeWidth)));
		lines.push(style(this.theme, "dim", this.footerHelp(true)));
		return lines.slice(0, maxLines).map((line) => clip(line, safeWidth));
	}

	private emptyMessage(): string {
		if (this.scope === "session" && this.currentSessionId === undefined)
			return `No current session id; showing current cwd ${DEFAULT_RUNS_DIR}`;
		if (this.scope === "session")
			return "No subagent runs found for this session";
		if (this.scope === "all")
			return "No indexed or current-workspace subagent runs found";
		return `No subagent runs found under ${DEFAULT_RUNS_DIR}`;
	}

	/** Re-project the loaded scope with the current filter/paging (no I/O). */
	private applySnapshot(preserveSelection: boolean): void {
		const loaded = this.loadedByScope.get(this.scope);
		if (loaded === undefined) return;
		const shownKey = this.snapshot.runs[this.selectedRun]?.key;
		const previousKey =
			this.pendingSelectKey ??
			(preserveSelection
				? this.snapshot.runs[this.selectedRun]?.key
				: undefined);
		const snapshot = projectSnapshot(loaded, {
			scope: this.scope,
			statusFilter: this.statusFilter,
			showMorePages: this.showMorePages,
		});
		this.snapshot = snapshot;
		const nextIndex =
			previousKey === undefined
				? -1
				: snapshot.runs.findIndex((run) => run.key === previousKey);
		if (nextIndex >= 0) this.pendingSelectKey = undefined;
		this.selectedRun =
			nextIndex >= 0
				? nextIndex
				: Math.min(this.selectedRun, Math.max(0, snapshot.runs.length - 1));
		// Rows reorder as runs update; keep the detail scroll while the same
		// run stays selected.
		if (snapshot.runs[this.selectedRun]?.key !== shownKey) this.detailOffset = 0;
		this.tui.requestRender?.();
	}

	private async refresh(
		options: {
			preserveSelection?: boolean;
			background?: boolean;
			fresh?: boolean;
		} = {},
	): Promise<void> {
		if (this.disposed) return;
		const preserveSelection = options.preserveSelection !== false;
		// Caches are validated by file stats; as a backstop against changes a
		// stat cannot reveal (coarse timestamps), the timer periodically
		// re-reads everything so a missed change heals within the interval.
		const fresh =
			options.fresh === true ||
			(options.background === true &&
				performance.now() -
					(this.lastFreshLoadAt.get(this.scope) ?? Number.NEGATIVE_INFINITY) >=
					CACHE_REVALIDATE_MS);
		if (this.loading) {
			// Timer ticks may be skipped, but a user request (scope change, `r`)
			// must not be dropped: run it right after the in-flight load.
			if (options.background !== true)
				this.pendingRefresh = {
					preserveSelection:
						(this.pendingRefresh?.preserveSelection ?? true) &&
						preserveSelection,
					fresh: (this.pendingRefresh?.fresh ?? false) || fresh,
				};
			return;
		}
		// Back off timer ticks when loads are slow (busy machine, huge index):
		// stay idle at least BACKGROUND_BACKOFF_FACTOR x the last load time, so
		// background loading uses at most ~1/(factor+1) of wall time.
		if (
			options.background === true &&
			performance.now() - this.lastLoadEndedAt <
				this.lastLoadMs * BACKGROUND_BACKOFF_FACTOR
		)
			return;
		this.loading = true;
		let request: RefreshRequest | undefined = { preserveSelection, fresh };
		try {
			while (request !== undefined && !this.disposed) {
				const scope = this.scope;
				// A scope's first load reads everything, which also starts its
				// revalidation clock.
				const current: RefreshRequest = {
					...request,
					fresh: request.fresh || !this.lastFreshLoadAt.has(scope),
				};
				const startedAt = performance.now();
				const loaded = await loadScope({
					cwd: this.cwd,
					scope,
					currentSessionId: this.currentSessionId,
					cache: this.loadCache,
					fresh: current.fresh,
				});
				this.lastLoadEndedAt = performance.now();
				this.lastLoadMs = this.lastLoadEndedAt - startedAt;
				if (current.fresh) this.lastFreshLoadAt.set(scope, startedAt);
				request = this.pendingRefresh;
				this.pendingRefresh = undefined;
				if (this.disposed) return;
				this.loadedByScope.set(scope, loaded);
				// The scope changed mid-load: keep the result cached but do not show
				// it; load the scope the user is looking at next.
				if (scope !== this.scope) {
					request ??= { preserveSelection: false, fresh: false };
					continue;
				}
				this.applySnapshot(current.preserveSelection);
			}
		} finally {
			this.loading = false;
		}
	}

	private cycleFocused(delta: number): void {
		if (this.focus === "detail") {
			this.scrollDetail(delta > 0 ? 1 : -1);
			return;
		}
		this.detailOffset = 0;
		this.selectedRun = 0;
		this.showMorePages = 0;
		if (this.focus === "status") {
			const filters: StatusFilter[] = ["all", "running", "completed", "failed"];
			const current = filters.indexOf(this.statusFilter);
			this.statusFilter =
				filters[(current + delta + filters.length) % filters.length] ?? "all";
			// Filtering needs no disk reads; the live timer keeps the data fresh.
			this.applySnapshot(false);
			this.tui.requestRender?.();
			return;
		}
		const scopes: ScopeFilter[] = ["session", "cwd", "all"];
		const current = scopes.indexOf(this.scope);
		this.scope =
			scopes[(current + delta + scopes.length) % scopes.length] ?? "cwd";
		// Never keep showing the previous scope's rows while the new one loads;
		// show this scope's last load (if any) at once and refresh it.
		this.snapshot = emptySnapshot();
		this.applySnapshot(false);
		this.tui.requestRender?.();
		void this.refresh({ preserveSelection: false });
	}

	private footerHelp(withDetailKeys: boolean): string {
		const detail = withDetailKeys ? " · PgUp/PgDn detail" : "";
		const more = this.snapshot.hiddenRuns > 0 ? " · m show more" : "";
		return `tab focus scope/status/detail · ←→ change · ↑↓/j/k select/scroll${detail} · r refresh${more} · q/esc close`;
	}

	private moveRun(delta: number): void {
		const runCount = this.snapshot.runs.length;
		if (runCount === 0) return;
		const current = Math.max(0, Math.min(runCount - 1, this.selectedRun));
		const next = (current + delta + runCount) % runCount;
		if (next !== this.selectedRun) this.detailOffset = 0;
		this.selectedRun = next;
		this.tui.requestRender?.();
	}

	private scrollDetail(delta: number): void {
		this.detailOffset = Math.max(0, this.detailOffset + delta);
		this.tui.requestRender?.();
	}

	private renderControls(width: number): string {
		const focused = (group: FocusGroup, text: string): string =>
			this.focus === group
				? style(this.theme, "accent", text)
				: style(this.theme, "dim", text);
		const scopeTabs = this.renderTabSet(
			[
				["session", "session"],
				["cwd", "cwd"],
				["all", "all"],
			],
			this.scope,
		);
		const statusTabs = this.renderTabSet(
			[
				["all", "all"],
				["running", "running"],
				["completed", "completed"],
				["failed", "failed"],
			],
			this.statusFilter,
		);
		return clip(
			`${focused("scope", "scope:")} ${scopeTabs}   ${focused("status", "status:")} ${statusTabs}   ${focused("detail", "detail:")} scroll`,
			width,
		);
	}

	private renderTabSet<T extends string>(
		tabs: Array<[T, string]>,
		current: T,
	): string {
		return tabs
			.map(([value, label]) =>
				value === current
					? style(this.theme, "accent", `[${label}]`)
					: style(this.theme, "dim", label),
			)
			.join(" ");
	}

	private renderScopeHelp(width: number): string {
		return clip(
			style(
				this.theme,
				"dim",
				"session: this conversation · cwd: this workspace · all: global index + cwd legacy",
			),
			width,
		);
	}

	private renderRuns(width: number, maxVisible: number): string[] {
		const maxStart = Math.max(0, this.snapshot.runs.length - maxVisible);
		const windowStart = Math.min(
			maxStart,
			Math.max(0, this.selectedRun - maxVisible + 1),
		);
		const showCwd = this.scope !== "cwd" && width >= 46;
		return this.snapshot.runs
			.slice(windowStart, windowStart + maxVisible)
			.map((run, index) => {
				const runIndex = windowStart + index;
				const marker =
					runIndex === this.selectedRun
						? style(this.theme, "accent", "▸")
						: " ";
				const status = runStatusLabel(run);
				const age = fmtAge(run.updatedMs);
				const cwdLabel = showCwd
					? ` · ${basename(run.sourceCwd) || run.sourceCwd}`
					: "";
				const fullMeta = `${age}${cwdLabel}`;
				const statusWidth = Math.max(4, Math.min(13, status.length));
				const fullIdWidth = visibleLength(run.runId);
				let metaWidth = visibleLength(fullMeta);
				let idWidth = width - statusWidth - metaWidth - 4;
				if (showCwd && idWidth < fullIdWidth) {
					metaWidth = Math.max(
						visibleLength(age),
						width - statusWidth - fullIdWidth - 4,
					);
					idWidth = width - statusWidth - metaWidth - 4;
				}
				idWidth = Math.max(6, idWidth);
				const meta = clip(fullMeta, metaWidth);
				const line = `${marker} ${pad(clip(run.runId, idWidth), idWidth)} ${style(this.theme, runStatusColor(run), pad(status, statusWidth))} ${style(this.theme, "muted", meta)}`;
				return clip(line, width);
			});
	}

	private renderDetailWindow(
		detailLines: string[],
		width: number,
		height: number,
	): string[] {
		if (detailLines.length <= height) {
			this.detailOffset = 0;
			return detailLines;
		}
		const hintHeight = 1;
		const contentHeight = Math.max(1, height - hintHeight);
		const maxOffset = Math.max(0, detailLines.length - contentHeight);
		this.detailOffset = Math.min(this.detailOffset, maxOffset);
		const end = Math.min(detailLines.length, this.detailOffset + contentHeight);
		const hint = style(
			this.theme,
			this.focus === "detail" ? "accent" : "dim",
			`detail ${this.detailOffset + 1}-${end}/${detailLines.length} · ${this.focus === "detail" ? "↑↓/Pg scroll" : "tab to detail"}`,
		);
		return [...detailLines.slice(this.detailOffset, end), clip(hint, width)];
	}

	private renderDetail(
		run: RunRow,
		task: TaskRow | undefined,
		width: number,
	): string[] {
		const lines: string[] = [];
		const labelWidth = Math.max(8, Math.min(12, Math.floor(width * 0.18)));
		const divider = (): void => {
			lines.push(style(this.theme, "border", "─".repeat(Math.max(1, width))));
		};
		const section = (title: string): void => {
			if (lines.length > 0) divider();
			lines.push(style(this.theme, "accent", title));
		};
		const field = (
			name: string,
			value: string | null | undefined,
			color = "muted",
		): void => {
			const rendered =
				value && value.length > 0
					? sanitizeRunText(value, this.currentSessionId)
					: "—";
			const label = style(
				this.theme,
				"dim",
				pad(clip(name, labelWidth), labelWidth),
			);
			lines.push(
				`${label} ${style(this.theme, color, clip(rendered, Math.max(1, width - labelWidth - 1)))}`,
			);
		};

		section("RUN");
		field("Run ID", run.runId, "text");
		field("Status", runStatusDetail(run), runStatusColor(run));
		field("Elapsed", fmtElapsed(run.startedAt, run.completedAt));
		field("Updated", fmtAge(run.updatedMs));

		if (run.childSummary !== undefined) {
			const latest = run.childSummary.latestFailure;
			field(
				"Children",
				latest === null
					? `total ${run.childSummary.total} · running ${run.childSummary.running} · failed ${run.childSummary.failed}`
					: `total ${run.childSummary.total} · failed ${run.childSummary.failed} · latest ${latest.childRunId}${latest.taskId ? `/${latest.taskId}` : ""}${latest.failureKind ? ` · ${latest.failureKind}` : ""}`,
				childFailureCount(run.childSummary) > 0 ? "error" : "muted",
			);
			if (run.childSummary.activeChildRunIds.length > 0) {
				field(
					"Active children",
					clip(run.childSummary.activeChildRunIds.join(", "), width - 16),
					"muted",
				);
			}
		}

		section("ATTEMPT");
		field(
			"All",
			run.tasks
				.map(
					(candidate) =>
						`${candidate.attemptId}:${statusLabel(candidate.status)}`,
				)
				.join(" · "),
		);
		if (task === undefined) {
			field("Selected", "no attempts recorded", "muted");
			return lines;
		}
		field(
			"Selected",
			`${run.tasks.indexOf(task) + 1}/${run.tasks.length} · ${task.attemptId} · ${statusLabel(task.status)} · ${fmtElapsed(task.startedAt, task.completedAt)}${task.modelLabel ? ` · ${task.modelLabel}` : ""}`,
			statusColor(task.status),
		);
		field("Started", task.startedAt);
		field("Completed", task.completedAt ?? "running");
		if (task.failureKind !== null) field("Failure", task.failureKind, "error");

		section(`LOG TAIL (${task.attemptId})`);
		field("Source", task.logPath ?? task.resultPath);
		const tail =
			task.logTail.length > 0
				? task.logTail
				: ["No log output loaded for this scope yet."];
		for (const logLine of tail)
			lines.push(
				`${style(this.theme, "dim", "›")} ${clip(sanitizeRunText(logLine, this.currentSessionId), Math.max(1, width - 2))}`,
			);

		field("Result", task.resultPath);
		field("Log", task.logPath ?? "—");

		section("WORKSPACE");
		field("Registry", safeRelative(this.cwd, run.sourceCwd));
		field("RunsDir", run.runsDir);
		field("Attempt", safeRelative(this.cwd, task.workspace));
		field(
			"Worktree",
			task.worktreePath === null
				? "—"
				: safeRelative(this.cwd, task.worktreePath),
		);

		if (run.eventTail.length > 0) {
			section("EVENTS");
			for (const eventLine of run.eventTail)
				lines.push(
					`${style(this.theme, "dim", "›")} ${clip(sanitizeRunText(eventLine, this.currentSessionId), Math.max(1, width - 2))}`,
				);
		}
		return lines;
	}
}

export type PanelHostContext = Pick<
	ExtensionContext,
	"cwd" | "mode" | "hasUI" | "ui"
>;

export async function showSubagentPanel(
	ctx: PanelHostContext,
	options: { runKey?: string } = {},
): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		ctx.ui.notify?.(
			"/subagent panel is available only in the interactive TUI.",
			"warning",
		);
		return;
	}
	const currentSessionId = currentSessionIdFromCtx(ctx);
	await ctx.ui.custom<void>(
		(
			tui: PanelTui,
			theme: PanelTheme,
			_keybindings: unknown,
			done: () => void,
		) =>
			new SubagentPanel(
				ctx.cwd,
				theme,
				tui,
				done,
				currentSessionId,
				options.runKey,
			),
	);
}

/** One session run as the editor activity widget shows it. */
export interface ActivityRun {
	key: string;
	runId: string;
	agent: string | null;
	status: Status;
	/** The run or one of its children failed. */
	failed: boolean;
	backend: string;
	model: string;
	startedAt: string;
	completedAt: string | null;
	updatedMs: number;
	attempts: number;
	failureKind: string | null;
	children?: { total: number; running: number; failed: number };
}

/** Panel clock; tests pin it with PI_SUBAGENT_PANEL_NOW_MS. */
export function panelNowMs(): number {
	return nowMs();
}

export function isActiveStatus(status: Status): boolean {
	return isActive(status);
}

export function formatRunElapsed(
	startedAt: string,
	completedAt: string | null,
): string {
	return fmtElapsed(startedAt, completedAt);
}

function toActivityRun(run: RunRow): ActivityRun {
	const latest = run.tasks.at(-1);
	return {
		key: run.key,
		runId: run.runId,
		agent: run.agent,
		status: run.status,
		failed: runHasFailure(run),
		backend: run.backend,
		model: latest?.modelLabel ?? "",
		startedAt: run.startedAt,
		completedAt: run.completedAt,
		updatedMs: run.updatedMs,
		attempts: run.tasks.length,
		failureKind: latest?.failureKind ?? null,
		...(run.childSummary === undefined
			? {}
			: {
					children: {
						total: run.childSummary.total,
						running: run.childSummary.running,
						failed: childFailureCount(run.childSummary),
					},
				}),
	};
}

/** How long the activity loader keeps re-reading a run after it finished. */
const ACTIVITY_FORGET_AFTER_MS = 10 * 60_000;

export interface SessionActivityLoader {
	/** Start following a run (its locator was just written). */
	track(locator: RunRefLocator): void;
	/** Find this session's recent runs in the index (e.g. a resumed session). */
	seed(sinceMs: number): Promise<void>;
	load(): Promise<ActivityRun[]>;
}

/**
 * Loads the current session's runs for the activity widget. Unlike the panel
 * it never scans the whole run index on a timer: it re-reads only the runs it
 * was told about (`track`, `seed`), reusing the panel's file caches so
 * finished runs are not re-read while their files are unchanged.
 */
export function createSessionActivityLoader(
	sessionId: string,
): SessionActivityLoader {
	const cache: PanelLoadCache = {
		locators: new Map(),
		runs: new Map(),
		runHits: 0,
	};
	const tracked = new Map<string, RunRefLocator>();
	const track = (locator: RunRefLocator): void => {
		if (locator.parentSessionId === sessionId)
			tracked.set(locator.runId, locator);
	};
	return {
		track,
		async seed(sinceMs) {
			for (const locator of await listRecentRunLocators(sinceMs))
				track(locator);
		},
		async load() {
			const locators = [...tracked.values()];
			const loaded = await mapWithConcurrency(
				locators,
				INDEX_LOAD_CONCURRENCY,
				(locator) =>
					loadRunFromLocator(locator, {
						scope: "session",
						currentSessionId: sessionId,
						cache,
					}),
			);
			const runs: ActivityRun[] = [];
			const now = nowMs();
			loaded.forEach((result, index) => {
				const locator = locators[index];
				if (locator === undefined) return;
				if (result.row === null) {
					// Gone or unreadable: stop following it once it is not new.
					if (result.invalid || result.pruned || result.stale)
						tracked.delete(locator.runId);
					return;
				}
				if (
					!isActive(result.row.status) &&
					now - result.row.updatedMs > ACTIVITY_FORGET_AFTER_MS
				) {
					tracked.delete(locator.runId);
					return;
				}
				runs.push(toActivityRun(result.row));
			});
			return runs;
		},
	};
}

export function currentSessionId(ctx: unknown): string | undefined {
	return currentSessionIdFromCtx(ctx);
}
