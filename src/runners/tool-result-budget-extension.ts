/**
 * Pi child extension: transcript-level tool-result budget with eviction.
 *
 * Loaded into child Pi runs (via --extension) only when the engine caller
 * opted into toolResultBudget. Configuration flows through environment
 * variables set by the headless runner; telemetry is written to a state
 * file the runner folds back into run metadata.
 */
import { writeFileSync } from "node:fs";
import {
	readToolResultBudgetEnv,
	ToolResultBudgetEnforcer,
	type ToolResultBudgetState,
} from "./tool-result-budget.ts";

interface ContextEventLike {
	type: "context";
	messages: unknown[];
}

interface ExtensionApiLike {
	on(
		event: "context",
		handler: (event: ContextEventLike) => { messages: unknown[] },
	): void;
}

function writeState(
	statePath: string | undefined,
	state: ToolResultBudgetState,
): void {
	if (statePath === undefined) return;
	try {
		writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
	} catch {
		// Telemetry only; never fail the child run over state persistence.
	}
}

export default function toolResultBudgetExtension(
	pi: ExtensionApiLike,
): void {
	const config = readToolResultBudgetEnv(process.env);
	if (config === undefined) return;
	const enforcer = new ToolResultBudgetEnforcer(config);
	pi.on("context", (event) => {
		const state = enforcer.enforce(event.messages);
		writeState(config.statePath, state);
		return { messages: event.messages };
	});
}
