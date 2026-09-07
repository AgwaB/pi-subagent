import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInlineModel, setInlineSdkImporterForTests } from "../../src/runners/inline.ts";

// A fake Pi SDK whose session appends assistant messages with usage and then
// either completes, rejects, waits for an abort, or resolves a final provider
// error. Inline results must carry provider/model/usage/stopReason in every case.
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
			if (behavior === "final-error") {
				messages.push({
					role: "assistant",
					content: [{ type: "text", text: "error output" }],
					provider: "fake",
					model: "fake/model",
					usage: { input: 5, output: 1, cost: { total: 0.005 } },
					stopReason: "error",
					errorMessage: "final provider error",
				});
				return;
			}
			if (behavior === "recovered") {
				messages.push({ role: "assistant", content: [{ type: "text", text: "retry failed" }], stopReason: "error", errorMessage: "recovered error" });
			}
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

	const finalError = await run("final-error");
	assert.equal(finalError.status, "failed", JSON.stringify(finalError));
	assert.equal(finalError.failureKind, "model");
	assert.equal(finalError.metadata.stopReason, "error");
	const finalErrorStderr = await readFile(join(cwd, finalError.artifacts.find((artifact) => artifact.type === "stderr").path), "utf8");
	assert.match(finalErrorStderr, /final provider error/u);

	const recovered = await run("recovered");
	assert.equal(recovered.status, "completed", JSON.stringify(recovered));
	assert.equal(recovered.failureKind, null);
	assert.equal(recovered.metadata.stopReason, "stop", "final success wins over an earlier error");

	const rejected = await run("reject");
	assert.equal(rejected.status, "failed");
	assert.equal(rejected.failureKind, "model");
	assert.equal(rejected.metadata.provider, "fake", "metadata survives a prompt rejection");
	assert.deepEqual(rejected.metadata.usage, { input: 10, output: 2, cost: { total: 0.01 } });
	assert.equal(rejected.metadata.stopReason, "toolUse");
	const rejectedStderr = await readFile(join(cwd, rejected.artifacts.find((artifact) => artifact.type === "stderr").path), "utf8");
	assert.match(rejectedStderr, /provider stream failed mid-turn/u);

	function watchedSignal() {
		const controller = new AbortController();
		let added = 0;
		let removed = 0;
		const add = controller.signal.addEventListener.bind(controller.signal);
		const remove = controller.signal.removeEventListener.bind(controller.signal);
		controller.signal.addEventListener = (...args) => { added++; return add(...args); };
		controller.signal.removeEventListener = (...args) => { removed++; return remove(...args); };
		return { controller, counts: () => ({ added, removed }) };
	}
	const successfulSignal = watchedSignal();
	const signalledSuccess = await run("complete", { signal: successfulSignal.controller.signal });
	assert.equal(signalledSuccess.status, "completed");
	assert.deepEqual(successfulSignal.counts(), { added: 1, removed: 1 }, "listener is cleaned up after success");

	const failedSignal = watchedSignal();
	const signalledFailure = await run("reject", { signal: failedSignal.controller.signal });
	assert.equal(signalledFailure.status, "failed");
	assert.deepEqual(failedSignal.counts(), { added: 1, removed: 1 }, "listener is cleaned up after failure");

	const abortedSignal = watchedSignal();
	setTimeout(() => abortedSignal.controller.abort(), 100);
	const aborted = await run("hang", { signal: abortedSignal.controller.signal });
	assert.equal(aborted.status, "cancelled");
	assert.deepEqual(abortedSignal.counts(), { added: 1, removed: 1 }, "listener is cleaned up after abort");
	assert.equal(aborted.failureKind, "abort");
	assert.equal(aborted.metadata.provider, "fake", "metadata survives an abort");
	assert.deepEqual(aborted.metadata.usage, { input: 10, output: 2, cost: { total: 0.01 } });
} finally {
	setInlineSdkImporterForTests(undefined);
	await rm(cwd, { recursive: true, force: true });
}
console.log("inline metadata checks passed");
