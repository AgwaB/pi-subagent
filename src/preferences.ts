import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** User preferences for this extension, kept across Pi sessions. */
export interface SubagentPreferences {
	/** Show the below-editor activity widget. Default true. */
	widget?: boolean;
}

export function preferencesPath(): string {
	const override = process.env.PI_SUBAGENT_PREFERENCES_PATH;
	return override !== undefined && override.length > 0
		? override
		: join(homedir(), ".pi", "agent", "pi-subagent.json");
}

export function readPreferences(): SubagentPreferences {
	try {
		const parsed: unknown = JSON.parse(readFileSync(preferencesPath(), "utf8"));
		if (typeof parsed !== "object" || parsed === null) return {};
		const widget = (parsed as { widget?: unknown }).widget;
		return typeof widget === "boolean" ? { widget } : {};
	} catch {
		return {};
	}
}

export function writePreferences(update: SubagentPreferences): void {
	const path = preferencesPath();
	let existing: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed === "object" && parsed !== null)
			existing = parsed as Record<string, unknown>;
	} catch {
		// Missing or unreadable: start fresh.
	}
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify({ ...existing, ...update }, null, 2)}\n`);
	renameSync(temp, path);
}
