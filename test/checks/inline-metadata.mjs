import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInlineModel, setInlineSdkImporterForTests } from "../../src/runners/inline.ts";

// A fake Pi SDK whose session appends assistant messages with usage and then
// either completes, rejects, or waits for an abort. Inline results must carry
// provider/model/usage/stopReason in every case.
function fakeSdk({ behavior }) {
	const messages = [];
	const session = {
		messages,
		subscribe() {
			return () => undefined;
		},
		async prompt() {
			messages.push({ role: "user", content: [{ type: "text", text: "hi" }] });
			messages.push({
				role: "assistant",
				content: [{ type: "text", text: "partial" }],
				provider: "fake",
				model: "fake/model",
				usage: { input: 10, output: 2, cost: { total: 0.01 } },
				stopReason: "toolUse",
			});
			if (behavior === "reject") throw new Error("provider stream failed mid-turn");
			if (behavior === "hang") await new Promise(() => undefined);
			messages.push({
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				provider: "fake",
				model: "fake/model",
				usage: { input: 5, output: 1, cost: { total: 0.005 } },
				stopReason: "stop",
			});
		},
		abort() {
			return Promise.resolve();
		},
		dispose() {},
	};
	return {
		module: {
			ModelRegistry: class {},
			ModelRuntime: { async create() { return {}; } },
			SessionManager: { inMemory() { return {}; } },
			DefaultResourceLoader: class {
				async reload() {}
			},
			getAgentDir() {
				return "/nonexistent-agent-dir";
			},
			async createAgentSession() {
				return { session, diagnostics: [] };
			},
		},
		source: "<fake>",
	};
}

const cwd = await mkdtemp(join(tmpdir(), "pi-subagent-inline-metadata-"));
try {
	async function run(behavior, extra = {}) {
		setInlineSdkImporterForTests(async () => fakeSdk({ behavior }));
		try {
			return await runInlineModel({
				cwd,
				runId: `run_inline_metadata_${behavior}`,
				attemptId: "attempt-1",
				agent: "meta-worker",
				task: "produce metadata",
				timeoutMs: 5_000,
				agentDefinition: { name: "meta-worker", displayName: "meta-worker", source: "global", path: "<check>", body: "fake", tools: [] },
				...extra,
			});
		} finally {
			setInlineSdkImporterForTests(undefined);
		}
	}

	const completed = await run("complete");
	assert.equal(completed.status, "completed", JSON.stringify(completed));
	assert.equal(completed.metadata.provider, "fake");
	assert.equal(completed.metadata.model, "fake/model");
	assert.deepEqual(completed.metadata.usage, { input: 15, output: 3, cost: { total: 0.015 } });
	assert.equal(completed.metadata.stopReason, "stop");

	const rejected = await run("reject");
	assert.equal(rejected.status, "failed");
	assert.equal(rejected.failureKind, "model");
	assert.equal(rejected.metadata.provider, "fake", "metadata survives a prompt rejection");
	assert.deepEqual(rejected.metadata.usage, { input: 10, output: 2, cost: { total: 0.01 } });
	assert.equal(rejected.metadata.stopReason, "toolUse");
	const rejectedStderr = await readFile(join(cwd, rejected.artifacts.find((artifact) => artifact.type === "stderr").path), "utf8");
	assert.match(rejectedStderr, /provider stream failed mid-turn/u);

	const controller = new AbortController();
	setTimeout(() => controller.abort(), 100);
	const aborted = await run("hang", { signal: controller.signal });
	assert.equal(aborted.status, "cancelled");
	assert.equal(aborted.failureKind, "abort");
	assert.equal(aborted.metadata.provider, "fake", "metadata survives an abort");
	assert.deepEqual(aborted.metadata.usage, { input: 10, output: 2, cost: { total: 0.01 } });
} finally {
	setInlineSdkImporterForTests(undefined);
	await rm(cwd, { recursive: true, force: true });
}
console.log("inline metadata checks passed");
