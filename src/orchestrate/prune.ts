import { readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { readRunRecord, runPaths } from "../artifacts/registry.ts";
import type { RunRecord } from "../artifacts/registry.ts";
import { readRunLocator, removeRunLocator } from "./run-ref.ts";

const DEFAULT_KEEP = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
const SAFE_RUN_ID = /^[A-Za-z0-9._-]+$/;

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
	/** Directories without a readable run record; never deleted. */
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

function isTerminal(status: RunRecord["status"]): boolean {
	return status === "completed" || status === "failed" || status === "cancelled";
}

/** A run is prunable only when the run and every attempt/task are terminal. */
function isFullyTerminal(record: RunRecord): boolean {
	return (
		isTerminal(record.status) &&
		record.attempts.every((attempt) => isTerminal(attempt.status)) &&
		(record.tasks ?? []).every((task) => isTerminal(task.status))
	);
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
): Promise<void> {
	const locator = await readRunLocator(runId);
	if (locator === null) return;
	const locatorRunsDir = resolve(locator.cwd, locator.runsDir ?? ".pi/agent/runs");
	if (resolve(locator.cwd) !== cwd || locatorRunsDir !== runsDir) return;
	await removeRunLocator(runId);
}

/**
 * Delete terminal subagent runs under `<cwd>/<runsDir>` that fall outside the
 * newest `keep` and, when given, are older than `olderThanDays`. Runs that are
 * not terminal are never touched, so a run still owned by a worker survives
 * even when it is stale; reconcile it first. Dry run unless `yes` is true.
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
	const { cwd, runsDir } = probe;

	const entries = await readdir(runsDir, { withFileTypes: true }).catch(() => []);
	const terminal: Array<PruneSubagentRunCandidate & { updatedMs: number }> = [];
	const skippedActive: string[] = [];
	const skippedUnreadable: string[] = [];
	let scanned = 0;
	for (const entry of entries) {
		if (!entry.isDirectory() || !SAFE_RUN_ID.test(entry.name)) continue;
		scanned += 1;
		const runId = entry.name;
		let record: RunRecord | null = null;
		try {
			record = await readRunRecord({ cwd, runsDir: options.runsDir, runId });
		} catch {
			record = null;
		}
		if (record === null) {
			skippedUnreadable.push(runId);
			continue;
		}
		if (!isFullyTerminal(record)) {
			skippedActive.push(runId);
			continue;
		}
		const updatedAt = record.completedAt ?? record.updatedAt;
		const updatedMs = Date.parse(updatedAt);
		terminal.push({
			runId,
			status: record.status,
			updatedAt,
			updatedMs: Number.isFinite(updatedMs) ? updatedMs : 0,
			bytes: 0,
		});
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
			const runDir = join(runsDir, candidate.runId);
			try {
				// Re-read immediately before deletion so a run that became active
				// after the scan is never removed.
				const latest = await readRunRecord({
					cwd,
					runsDir: options.runsDir,
					runId: candidate.runId,
				});
				if (latest === null || !isFullyTerminal(latest)) {
					deleteErrors.push({ runId: candidate.runId, message: "run changed since scan; skipped" });
					continue;
				}
				await rm(runDir, { recursive: true, force: true });
				await removeLocatorIfOwned(candidate.runId, cwd, runsDir);
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
		cwd,
		runsDir,
		keep,
		...(olderThanDays === undefined ? {} : { olderThanDays }),
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
