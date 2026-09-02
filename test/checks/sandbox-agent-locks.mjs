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

console.log("sandbox agent lock path checks passed");
