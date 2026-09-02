import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { readRunRecord, removeRunIfStill, runPaths } from "../artifacts/registry.ts";
import type { RunRecord } from "../artifacts/registry.ts";
import { STATUSES } from "../core/constants.ts";
import { readRunLocator, removeRunLocator } from "./run-ref.ts";

const DEFAULT_KEEP = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
const SAFE_RUN_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const TERMINAL = new Set<string>(["completed", "failed", "cancelled"]);
const KNOWN_STATUS = new Set<string>(STATUSES);

export interface PruneSubagentRunsOptions {
	cwd?: string;
	runsDir?: string;
	/** Newest terminal runs to keep regardless of age. Default 50. */
	keep?: number;
	/** Only delete terminal runs whose last update is older than this. */
	olderThanDays?: number;
	/** Delete. Without it the call is a dry run that only reports. */
	yes?: boolean;
	now?: number;
}

export interface PruneSubagentRunCandidate {
	runId: string;
	status: RunRecord["status"];
	/** Last update of the run record; ordering and `olderThanDays` use this. */
	updatedAt: string;
	bytes: number;
}

export interface PruneSubagentRunsSummary {
	status: "dry-run" | "pruned";
	cwd: string;
	runsDir: string;
	keep: number;
	olderThanDays?: number;
	scanned: number;
	terminal: number;
	selected: PruneSubagentRunCandidate[];
	deletedRunIds: string[];
	deletedBytes: number;
	/** Non-terminal runs; never deleted. Use `reconcile` on stale ones first. */
	skippedActive: string[];
	/** Directories without a readable, well-formed run record; never deleted. */
	skippedUnreadable: string[];
	deleteErrors: Array<{ runId: string; message: string }>;
}

function normalizeKeep(value: number | undefined): number {
	if (value === undefined) return DEFAULT_KEEP;
	if (!Number.isInteger(value) || value < 0)
		throw new Error("keep must be a non-negative integer.");
	return value;
}

function normalizeOlderThanDays(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value) || value < 0)
		throw new Error("olderThanDays must be a non-negative number.");
	return value;
}

function requireStatus(value: unknown, what: string): string {
	if (typeof value !== "string" || !KNOWN_STATUS.has(value))
		throw new Error(`${what} has an unknown status ${JSON.stringify(value)}`);
	return value;
}

/**
 * A run is prunable only when the record is well formed and the run and every
 * attempt/task carry a terminal status. Throws on anything malformed (missing
 * ids, unknown statuses, dangling active attempt, id mismatch) so the caller
 * classifies the directory as unreadable instead of guessing.
 */
export function isFullyTerminalRunRecord(record: RunRecord, expectedRunId?: string): boolean {
	if (typeof record !== "object" || record === null) throw new Error("run record is not an object");
	if (typeof record.runId !== "string" || record.runId.length === 0)
		throw new Error("run record has no runId");
	if (expectedRunId !== undefined && record.runId !== expectedRunId)
		throw new Error(`run record id ${record.runId} does not match directory ${expectedRunId}`);
	const status = requireStatus(record.status, "run record");
	if (!Array.isArray(record.attempts)) throw new Error("run record has no attempts array");
	const attemptIds = new Set<string>();
	let terminal = TERMINAL.has(status);
	for (const attempt of record.attempts) {
		if (typeof attempt?.attemptId !== "string" || attempt.attemptId.length === 0)
			throw new Error("attempt record has no attemptId");
		attemptIds.add(attempt.attemptId);
		if (!TERMINAL.has(requireStatus(attempt.status, `attempt ${attempt.attemptId}`))) terminal = false;
	}
	for (const task of record.tasks ?? []) {
		if (typeof task?.taskId !== "string" || task.taskId.length === 0)
			throw new Error("task record has no taskId");
		if (!TERMINAL.has(requireStatus(task.status, `task ${task.taskId}`))) terminal = false;
	}
	if (
		record.activeAttemptId !== null &&
		record.activeAttemptId !== undefined &&
		!attemptIds.has(record.activeAttemptId)
	)
		throw new Error(`run record activeAttemptId ${record.activeAttemptId} is not an attempt`);
	return terminal;
}

function recordUpdatedAt(record: RunRecord): { updatedAt: string; updatedMs: number } {
	for (const candidate of [record.updatedAt, record.completedAt]) {
		if (typeof candidate !== "string") continue;
		const parsed = Date.parse(candidate);
		if (Number.isFinite(parsed)) return { updatedAt: candidate, updatedMs: parsed };
	}
	throw new Error("run record has no valid updatedAt");
}

async function directoryBytes(path: string): Promise<number> {
	let total = 0;
	const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		const child = join(path, entry.name);
		if (entry.isDirectory()) total += await directoryBytes(child);
		else if (entry.isFile()) {
			const info = await stat(child).catch(() => null);
			if (info) total += info.size;
		}
	}
	return total;
}

async function removeLocatorIfOwned(
	runId: string,
	cwd: string,
	runsDir: string,
	notAfterMs: number,
): Promise<void> {
	const locator = await readRunLocator(runId);
	if (locator === null) return;
	const locatorUpdatedMs = Date.parse(locator.updatedAt);
	if (Number.isFinite(locatorUpdatedMs) && locatorUpdatedMs > notAfterMs) return;
	// Compare physical paths: cwd/runsDir here are realpaths, locators store
	// the path as given (for example /var vs /private/var on macOS).
	const locatorCwd = await realpath(locator.cwd).catch(() => resolve(locator.cwd));
	const locatorRunsDir = await realpath(
		resolve(locator.cwd, locator.runsDir ?? ".pi/agent/runs"),
	).catch(() => resolve(locatorCwd, locator.runsDir ?? ".pi/agent/runs"));
	if (locatorCwd !== cwd || locatorRunsDir !== runsDir) return;
	await removeRunLocator(runId);
}

/**
 * Resolve the physical runs directory and require it to sit inside the
 * physical cwd: a symlinked `runsDir` (or ancestor) must not turn a prune
 * into a deletion elsewhere on disk. Returns null when the directory does
 * not exist (nothing to prune).
 */
async function resolvePhysicalRunsDir(
	cwd: string,
	runsDir: string,
): Promise<{ physicalCwd: string; physicalRunsDir: string } | null> {
	const physicalCwd = await realpath(cwd);
	let physicalRunsDir: string;
	try {
		physicalRunsDir = await realpath(runsDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
		throw error;
	}
	const rel = relative(physicalCwd, physicalRunsDir);
	if (rel.startsWith("..") || resolve(physicalCwd, rel) !== physicalRunsDir)
		throw new Error(
			`runsDir resolves outside cwd (${physicalRunsDir} is not inside ${physicalCwd}); refusing to prune through a symlink.`,
		);
	return { physicalCwd, physicalRunsDir };
}

/**
 * Delete terminal subagent runs under `<cwd>/<runsDir>` that fall outside the
 * newest `keep` and, when given, are older than `olderThanDays`. Runs that are
 * not terminal are never touched, so a run still owned by a worker survives
 * even when it is stale; reconcile it first. Dry run unless `yes` is true.
 * Each deletion re-validates the record under the run lock and renames the
 * directory before removing it, so a concurrent mutation cannot reactivate a
 * run that is being deleted.
 */
export async function pruneSubagentRuns(
	options: PruneSubagentRunsOptions = {},
): Promise<PruneSubagentRunsSummary> {
	const keep = normalizeKeep(options.keep);
	const olderThanDays = normalizeOlderThanDays(options.olderThanDays);
	const now = options.now ?? Date.now();
	const cutoff = olderThanDays === undefined ? undefined : now - olderThanDays * DAY_MS;
	const probe = runPaths({
		cwd: options.cwd,
		runsDir: options.runsDir,
		runId: "run_prune_probe",
	});
	const summaryBase = {
		cwd: probe.cwd,
		runsDir: probe.runsDir,
		keep,
		...(olderThanDays === undefined ? {} : { olderThanDays }),
	};
	const physical = await resolvePhysicalRunsDir(probe.cwd, probe.runsDir);
	if (physical === null)
		return {
			status: options.yes === true ? "pruned" : "dry-run",
			...summaryBase,
			scanned: 0,
			terminal: 0,
			selected: [],
			deletedRunIds: [],
			deletedBytes: 0,
			skippedActive: [],
			skippedUnreadable: [],
			deleteErrors: [],
		};
	// All further work uses physical paths so no symlink is followed.
	const cwd = physical.physicalCwd;
	const runsDir = physical.physicalRunsDir;
	const runsDirRelative = relative(cwd, runsDir);
	const ref = (runId: string) => ({ cwd, runsDir: runsDirRelative, runId });

	const scanStartedAt = Date.now();
	const entries = await readdir(runsDir, { withFileTypes: true }).catch(() => []);
	const terminal: Array<PruneSubagentRunCandidate & { updatedMs: number }> = [];
	const skippedActive: string[] = [];
	const skippedUnreadable: string[] = [];
	let scanned = 0;
	for (const entry of entries) {
		// Dirent.isDirectory() is false for symlinks, so linked entries are
		// skipped; hidden entries (the `.locks` directory) are not runs.
		if (!entry.isDirectory() || !SAFE_RUN_ID.test(entry.name)) continue;
		scanned += 1;
		const runId = entry.name;
		try {
			const record = await readRunRecord(ref(runId));
			if (record === null) {
				skippedUnreadable.push(runId);
				continue;
			}
			if (!isFullyTerminalRunRecord(record, runId)) {
				skippedActive.push(runId);
				continue;
			}
			const { updatedAt, updatedMs } = recordUpdatedAt(record);
			terminal.push({ runId, status: record.status, updatedAt, updatedMs, bytes: 0 });
		} catch {
			skippedUnreadable.push(runId);
		}
	}
	terminal.sort((a, b) => b.updatedMs - a.updatedMs || a.runId.localeCompare(b.runId));

	const selected: PruneSubagentRunCandidate[] = [];
	for (const [index, candidate] of terminal.entries()) {
		if (index < keep) continue;
		if (cutoff !== undefined && candidate.updatedMs > cutoff) continue;
		const bytes = await directoryBytes(join(runsDir, candidate.runId));
		selected.push({
			runId: candidate.runId,
			status: candidate.status,
			updatedAt: candidate.updatedAt,
			bytes,
		});
	}

	const deletedRunIds: string[] = [];
	const deleteErrors: Array<{ runId: string; message: string }> = [];
	let deletedBytes = 0;
	if (options.yes === true) {
		for (const candidate of selected) {
			try {
				const info = await lstat(join(runsDir, candidate.runId));
				if (!info.isDirectory()) {
					deleteErrors.push({ runId: candidate.runId, message: "run directory changed since scan; skipped" });
					continue;
				}
				const outcome = await removeRunIfStill(
					ref(candidate.runId),
					(record) => {
						try {
							return isFullyTerminalRunRecord(record, candidate.runId);
						} catch {
							return false;
						}
					},
					{
						// Exact generation check: a record touched since the scan is
						// not the one that was selected.
						expectedUpdatedAt: candidate.updatedAt,
						// Locator cleanup runs under the same lock, and only for a
						// locator that predates this prune.
						afterRemove: () => removeLocatorIfOwned(candidate.runId, cwd, runsDir, scanStartedAt),
					},
				);
				if (outcome !== "removed") {
					deleteErrors.push({ runId: candidate.runId, message: `run ${outcome} since scan; skipped` });
					continue;
				}
				deletedRunIds.push(candidate.runId);
				deletedBytes += candidate.bytes;
			} catch (error) {
				deleteErrors.push({
					runId: candidate.runId,
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	return {
		status: options.yes === true ? "pruned" : "dry-run",
		...summaryBase,
		scanned,
		terminal: terminal.length,
		selected,
		deletedRunIds,
		deletedBytes,
		skippedActive,
		skippedUnreadable,
		deleteErrors,
	};
}

export function formatPruneSubagentRunsSummary(summary: PruneSubagentRunsSummary): string {
	const lines = [
		summary.status === "dry-run" ? "Subagent run prune (dry run)" : "Subagent run prune",
		`Runs dir: ${summary.runsDir}`,
		`Scanned: ${summary.scanned}; terminal: ${summary.terminal}; keep newest: ${summary.keep}${
			summary.olderThanDays === undefined ? "" : `; older than ${summary.olderThanDays} day(s)`
		}`,
	];
	if (summary.selected.length === 0) lines.push("Nothing to delete.");
	else {
		const totalBytes = summary.selected.reduce((sum, run) => sum + run.bytes, 0);
		lines.push(
			summary.status === "dry-run"
				? `Runs that would be deleted (${summary.selected.length}, ${totalBytes} bytes):`
				: `Runs selected for deletion (${summary.selected.length}, ${totalBytes} bytes):`,
		);
		for (const run of summary.selected)
			lines.push(`  ${run.runId}  ${run.status}  ${run.updatedAt}  ${run.bytes} bytes`);
	}
	if (summary.status === "pruned")
		lines.push(`Deleted: ${summary.deletedRunIds.length} run(s), ${summary.deletedBytes} bytes`);
	if (summary.skippedActive.length > 0)
		lines.push(`Skipped non-terminal runs: ${summary.skippedActive.length} (reconcile stale ones first)`);
	if (summary.skippedUnreadable.length > 0)
		lines.push(`Skipped unreadable run directories: ${summary.skippedUnreadable.length}`);
	for (const failure of summary.deleteErrors) lines.push(`  ! ${failure.runId}: ${failure.message}`);
	if (summary.status === "dry-run" && summary.selected.length > 0)
		lines.push("Re-run with yes: true to delete.");
	return lines.join("\n");
}
