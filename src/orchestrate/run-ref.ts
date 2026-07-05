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

export async function listRunLocators(): Promise<RunLocatorListResult> {
	const indexDir = runIndexDir();
	const entries = await readdir(indexDir, { withFileTypes: true }).catch(
		() => [],
	);
	const locators: RunRefLocator[] = [];
	let invalidCount = 0;
	let skippedCount = 0;
	let prunedCount = 0;

	for (const entry of entries) {
		if (!entry.isFile()) {
			skippedCount += 1;
			continue;
		}
		if (!entry.name.endsWith(".json") || entry.name.endsWith(".tmp")) {
			skippedCount += 1;
			continue;
		}
		const runId = entry.name.slice(0, -".json".length);
		try {
			assertSafeId("runId", runId);
			const path = join(indexDir, entry.name);
			const info = await stat(path);
			if (!info.isFile() || info.size > 64 * 1024) {
				if (olderThanPruneThreshold(info.mtimeMs) && (await pruneLocator(path)))
					prunedCount += 1;
				else invalidCount += 1;
				continue;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(await readFile(path, "utf8"));
			} catch {
				if (olderThanPruneThreshold(info.mtimeMs) && (await pruneLocator(path)))
					prunedCount += 1;
				else invalidCount += 1;
				continue;
			}
			if (!isRunRefLocator(parsed) || parsed.runId !== runId) {
				if (olderThanPruneThreshold(info.mtimeMs) && (await pruneLocator(path)))
					prunedCount += 1;
				else invalidCount += 1;
				continue;
			}
			const cwd = normalizeCwd(parsed.cwd);
			assertSafeRunsDir(cwd, parsed.runsDir);
			locators.push({ ...parsed, cwd });
		} catch {
			invalidCount += 1;
		}
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
