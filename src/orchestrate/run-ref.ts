import type { Dirent } from "node:fs";
import {
	mkdir,
	readdir,
	readFile,
	rename,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { mapWithConcurrency } from "../core/concurrency.ts";
import { statsFingerprint } from "../core/file-fingerprint.ts";

const DEFAULT_RUNS_DIR = ".pi/agent/runs";
const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const RUN_LOCATOR_SCHEMA_VERSION = 1 as const;

export interface RunRefLocator {
	schemaVersion: typeof RUN_LOCATOR_SCHEMA_VERSION;
	runId: string;
	cwd: string;
	runsDir?: string;
	parentSessionId?: string;
	correlationId?: string;
	updatedAt: string;
}

export interface LocatableRunRef {
	cwd?: string;
	runId: string;
	runsDir?: string;
}

export interface WriteRunLocatorOptions extends LocatableRunRef {
	cwd: string;
	parentSessionId?: string;
	correlationId?: string;
}

export interface RunLocatorListResult {
	locators: RunRefLocator[];
	invalidCount: number;
	skippedCount: number;
	prunedCount: number;
}

function assertSafeId(name: string, value: string): void {
	if (!SAFE_ID_PATTERN.test(value))
		throw new Error(
			`${name} must contain only letters, numbers, dots, underscores, or dashes.`,
		);
}

function isInsideOrEqual(parent: string, child: string): boolean {
	const childRelative = relative(parent, child);
	return (
		childRelative === "" ||
		(!childRelative.startsWith("..") && !isAbsolute(childRelative))
	);
}

function normalizeCwd(cwd: string): string {
	return resolve(cwd);
}

function assertSafeRunsDir(cwd: string, runsDir: string | undefined): void {
	const absolute = resolve(cwd, runsDir ?? DEFAULT_RUNS_DIR);
	if (!isInsideOrEqual(cwd, absolute))
		throw new Error(
			"runsDir must be inside cwd so lifecycle refs remain relative and safe.",
		);
}

function runIndexDir(): string {
	const override = process.env.PI_SUBAGENT_RUN_INDEX_DIR;
	return resolve(
		override && override.length > 0
			? override
			: join(homedir(), ".pi", "agent", "subagent-runs"),
	);
}

function runLocatorPath(runId: string): string {
	assertSafeId("runId", runId);
	return join(runIndexDir(), `${runId}.json`);
}

const DEFAULT_LOCATOR_PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

function locatorPruneAfterMs(): number {
	const raw = process.env.PI_SUBAGENT_RUN_LOCATOR_PRUNE_AFTER_MS;
	if (raw !== undefined && raw.length > 0) {
		const parsed = Number.parseInt(raw, 10);
		if (Number.isFinite(parsed)) return parsed;
	}
	return DEFAULT_LOCATOR_PRUNE_AFTER_MS;
}

function olderThanPruneThreshold(
	timestampMs: number,
	now = Date.now(),
): boolean {
	const threshold = locatorPruneAfterMs();
	return (
		threshold >= 0 &&
		Number.isFinite(timestampMs) &&
		now - timestampMs >= threshold
	);
}

export function locatorOlderThanPruneThreshold(
	locator: Pick<RunRefLocator, "updatedAt">,
	now = Date.now(),
): boolean {
	const parsed = Date.parse(locator.updatedAt);
	return olderThanPruneThreshold(Number.isFinite(parsed) ? parsed : now, now);
}

async function pruneLocator(path: string): Promise<boolean> {
	try {
		await unlink(path);
		return true;
	} catch {
		return false;
	}
}

export async function removeRunLocator(runId: string): Promise<boolean> {
	return await pruneLocator(runLocatorPath(runId));
}

function isRunRefLocator(value: unknown): value is RunRefLocator {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { schemaVersion?: unknown }).schemaVersion ===
			RUN_LOCATOR_SCHEMA_VERSION &&
		typeof (value as { runId?: unknown }).runId === "string" &&
		typeof (value as { cwd?: unknown }).cwd === "string"
	);
}

async function localRunDirExists(
	ref: LocatableRunRef,
	defaultCwd: string,
): Promise<boolean> {
	const cwd = normalizeCwd(ref.cwd ?? defaultCwd);
	assertSafeRunsDir(cwd, ref.runsDir);
	const runsDir = resolve(cwd, ref.runsDir ?? DEFAULT_RUNS_DIR);
	const info = await stat(join(runsDir, ref.runId)).catch(() => null);
	return info?.isDirectory() === true;
}

/**
 * Stale locators were previously pruned only when the run panel listed the
 * index, so a machine that never opened the panel accumulated tens of
 * thousands of entries. Writing a locator now also sweeps the index once per
 * process, in the background, with a bounded number of deletions so the
 * launch path never waits on it.
 */
const LOCATOR_SWEEP_MAX_DELETES = 500;
let locatorSweepStarted = false;
let locatorSweepPromise: Promise<number> | undefined;

export async function pruneStaleRunLocators(
	options: { maxDeletes?: number; now?: number } = {},
): Promise<number> {
	const maxDeletes = options.maxDeletes ?? LOCATOR_SWEEP_MAX_DELETES;
	const now = options.now ?? Date.now();
	const indexDir = runIndexDir();
	const entries = await readdir(indexDir, { withFileTypes: true }).catch(
		() => [],
	);
	let pruned = 0;
	for (const entry of entries) {
		if (pruned >= maxDeletes) break;
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const path = join(indexDir, entry.name);
		try {
			const info = await stat(path);
			if (olderThanPruneThreshold(info.mtimeMs, now) && (await pruneLocator(path)))
				pruned += 1;
		} catch {
			// A concurrently removed entry is not an error.
		}
	}
	return pruned;
}

/** Test seam: forget that a sweep already ran in this process. */
export function resetRunLocatorSweepForTests(): void {
	locatorSweepStarted = false;
	locatorSweepPromise = undefined;
}

/** Test seam: await the background sweep started by the last locator write. */
export async function awaitRunLocatorSweepForTests(): Promise<number> {
	return (await locatorSweepPromise) ?? 0;
}

function scheduleRunLocatorSweep(): void {
	if (locatorSweepStarted) return;
	locatorSweepStarted = true;
	locatorSweepPromise = new Promise<number>((resolveSweep) => {
		setImmediate(() => {
			pruneStaleRunLocators()
				.then(resolveSweep)
				.catch(() => resolveSweep(0));
		});
	});
}

export async function writeRunLocator(
	options: WriteRunLocatorOptions,
): Promise<void> {
	assertSafeId("runId", options.runId);
	const cwd = normalizeCwd(options.cwd);
	assertSafeRunsDir(cwd, options.runsDir);
	const locator: RunRefLocator = {
		schemaVersion: RUN_LOCATOR_SCHEMA_VERSION,
		runId: options.runId,
		cwd,
		...(options.runsDir === undefined ? {} : { runsDir: options.runsDir }),
		...(options.parentSessionId === undefined
			? {}
			: { parentSessionId: options.parentSessionId }),
		...(options.correlationId === undefined
			? {}
			: { correlationId: options.correlationId }),
		updatedAt: new Date().toISOString(),
	};
	const path = runLocatorPath(options.runId);
	await mkdir(dirname(path), { recursive: true });
	const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tempPath, `${JSON.stringify(locator, null, 2)}\n`);
	await rename(tempPath, path);
	scheduleRunLocatorSweep();
	for (const listener of locatorListeners) {
		try {
			listener(locator);
		} catch {
			// Observers must not affect run bookkeeping.
		}
	}
}

const locatorListeners = new Set<(locator: RunRefLocator) => void>();

/**
 * Observe locators this process writes (every run start writes one), so
 * in-process observers can find new runs without scanning the global index.
 */
export function onRunLocatorWritten(
	listener: (locator: RunRefLocator) => void,
): () => void {
	locatorListeners.add(listener);
	return () => {
		locatorListeners.delete(listener);
	};
}

const RUN_ID_TIME_PATTERN = /^run_([0-9a-z]+)_[0-9a-f]+\.json$/;

/**
 * Locators of runs created at or after `sinceMs`, judged by the creation time
 * encoded in generated run ids (`run_<base36 ms>_<hex>`). Only those files are
 * read, so this stays cheap on a large index; other run ids are skipped.
 */
export async function listRecentRunLocators(
	sinceMs: number,
): Promise<RunRefLocator[]> {
	const names = await readdir(runIndexDir()).catch(() => [] as string[]);
	const recent = names.filter((name) => {
		const match = RUN_ID_TIME_PATTERN.exec(name);
		return (
			match !== null && Number.parseInt(match[1] ?? "", 36) >= sinceMs
		);
	});
	const locators = await mapWithConcurrency(
		recent,
		LOCATOR_LIST_CONCURRENCY,
		(name) => readRunLocator(name.slice(0, -".json".length)),
	);
	return locators.filter(
		(locator): locator is RunRefLocator => locator !== null,
	);
}

export async function readRunLocator(
	runId: string,
): Promise<RunRefLocator | null> {
	const path = runLocatorPath(runId);
	try {
		const parsed = JSON.parse(await readFile(path, "utf8"));
		if (!isRunRefLocator(parsed) || parsed.runId !== runId) return null;
		const cwd = normalizeCwd(parsed.cwd);
		assertSafeRunsDir(cwd, parsed.runsDir);
		return { ...parsed, cwd };
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "ENOENT"
		)
			return null;
		return null;
	}
}

type LocatorEntryOutcome =
	| { kind: "locator"; locator: RunRefLocator }
	| { kind: "skipped" | "invalid" | "pruned" };

const LOCATOR_LIST_CONCURRENCY = 32;

/**
 * Parsed locators keyed by index file path. A caller that lists the index
 * repeatedly (the live panel) passes one in so unchanged files are not
 * re-read; entries are revalidated against the file's stat fingerprint.
 */
export type RunLocatorCache = Map<
	string,
	{ fingerprint: string; locator: RunRefLocator }
>;

export interface ListRunLocatorsOptions {
	cache?: RunLocatorCache;
	/** Re-read every file even when the cache entry is still valid. */
	fresh?: boolean;
}

async function readLocatorEntry(
	indexDir: string,
	entry: Dirent,
	options: ListRunLocatorsOptions,
): Promise<LocatorEntryOutcome> {
	if (!entry.isFile()) return { kind: "skipped" };
	if (!entry.name.endsWith(".json") || entry.name.endsWith(".tmp"))
		return { kind: "skipped" };
	const runId = entry.name.slice(0, -".json".length);
	try {
		assertSafeId("runId", runId);
		const path = join(indexDir, entry.name);
		const info = await stat(path);
		const pruneOrInvalid = async (): Promise<LocatorEntryOutcome> => {
			options.cache?.delete(path);
			return olderThanPruneThreshold(info.mtimeMs) && (await pruneLocator(path))
				? { kind: "pruned" }
				: { kind: "invalid" };
		};
		if (!info.isFile() || info.size > 64 * 1024) return await pruneOrInvalid();
		const fingerprint = statsFingerprint(info);
		const cached = options.fresh ? undefined : options.cache?.get(path);
		if (cached?.fingerprint === fingerprint)
			return { kind: "locator", locator: cached.locator };
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(path, "utf8"));
		} catch {
			return await pruneOrInvalid();
		}
		if (!isRunRefLocator(parsed) || parsed.runId !== runId)
			return await pruneOrInvalid();
		const cwd = normalizeCwd(parsed.cwd);
		assertSafeRunsDir(cwd, parsed.runsDir);
		const locator = { ...parsed, cwd };
		// The fingerprint was taken before the read, so a write racing the read
		// leaves a stale fingerprint and the next listing re-reads the file.
		options.cache?.set(path, { fingerprint, locator });
		return { kind: "locator", locator };
	} catch {
		return { kind: "invalid" };
	}
}

export async function listRunLocators(
	options: ListRunLocatorsOptions = {},
): Promise<RunLocatorListResult> {
	const indexDir = runIndexDir();
	const entries = await readdir(indexDir, { withFileTypes: true }).catch(
		() => [],
	);
	// The index can hold thousands of tiny files; reading them one at a time
	// made every panel refresh wait on sequential disk round-trips.
	const outcomes = await mapWithConcurrency(
		entries,
		LOCATOR_LIST_CONCURRENCY,
		(entry) => readLocatorEntry(indexDir, entry, options),
	);
	if (options.cache !== undefined) {
		const present = new Set(entries.map((entry) => join(indexDir, entry.name)));
		for (const path of options.cache.keys())
			if (!present.has(path)) options.cache.delete(path);
	}
	const locators: RunRefLocator[] = [];
	let invalidCount = 0;
	let skippedCount = 0;
	let prunedCount = 0;
	for (const outcome of outcomes) {
		if (outcome.kind === "locator") locators.push(outcome.locator);
		else if (outcome.kind === "skipped") skippedCount += 1;
		else if (outcome.kind === "pruned") prunedCount += 1;
		else invalidCount += 1;
	}

	return { locators, invalidCount, skippedCount, prunedCount };
}

export async function resolveRunRef<T extends LocatableRunRef>(
	ref: T,
	defaultCwd = process.cwd(),
): Promise<T & { cwd: string }> {
	assertSafeId("runId", ref.runId);
	const fallbackCwd = normalizeCwd(ref.cwd ?? defaultCwd);
	if (ref.cwd !== undefined || ref.runsDir !== undefined)
		return { ...ref, cwd: fallbackCwd };
	if (await localRunDirExists(ref, fallbackCwd))
		return { ...ref, cwd: fallbackCwd };

	const locator = await readRunLocator(ref.runId);
	if (locator !== null) {
		return {
			...ref,
			cwd: locator.cwd,
			...(locator.runsDir === undefined ? {} : { runsDir: locator.runsDir }),
		};
	}

	return { ...ref, cwd: fallbackCwd };
}
