import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { piAgentDirLockPaths } from "../../src/sandbox/srt.ts";

// Pi 0.84+ takes proper-lockfile directory locks next to settings.json and
// auth.json even for reads; a sandboxed child must be allowed to create
// exactly those lock paths or it starts without credentials.
const defaults = piAgentDirLockPaths({});
assert.deepEqual(defaults, [
	join(homedir(), ".pi", "agent", "settings.json.lock"),
	join(homedir(), ".pi", "agent", "auth.json.lock"),
	join(homedir(), ".pi", "agent", "trust.json.lock"),
]);
for (const path of defaults) {
	assert.ok(path.endsWith(".lock"), `only lock paths may be writable: ${path}`);
}

const overridden = piAgentDirLockPaths({ PI_CODING_AGENT_DIR: "/tmp/pi-agent-override" });
assert.equal(overridden[0], resolve("/tmp/pi-agent-override/settings.json.lock"));
assert.equal(overridden[1], resolve("/tmp/pi-agent-override/auth.json.lock"));
assert.deepEqual(piAgentDirLockPaths({ PI_CODING_AGENT_DIR: "   " }), defaults);

// A relative override is resolved by the child against its own cwd (Pi's
// getAgentDir accepts relative values), so the grant must follow the child's
// cwd rather than the parent's.
const relative = piAgentDirLockPaths({ PI_CODING_AGENT_DIR: "agent-state" }, "/srv/worktree-b");
assert.equal(relative[0], resolve("/srv/worktree-b/agent-state/settings.json.lock"));
assert.notEqual(relative[0], resolve(process.cwd(), "agent-state/settings.json.lock"), "must not resolve against the parent cwd");

console.log("sandbox agent lock path checks passed");
