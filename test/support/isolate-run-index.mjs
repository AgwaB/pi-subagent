// Preloaded by the check scripts (`node --import`): point the global run
// index at a per-process temp directory so checks never write run locators
// into the user's real index (~/.pi/agent/subagent-runs). Without this,
// every check run left locators pointing at deleted temp workspaces. A check
// or caller that already chose an index directory keeps it; child processes
// inherit the environment.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.PI_SUBAGENT_RUN_INDEX_DIR) {
	const indexDir = mkdtempSync(join(tmpdir(), "pi-subagent-check-index-"));
	process.env.PI_SUBAGENT_RUN_INDEX_DIR = indexDir;
	process.on("exit", () => {
		rmSync(indexDir, { recursive: true, force: true });
	});
}
