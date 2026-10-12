#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResultEnvelope } from "../../src/artifacts/result.ts";
import { runTmuxModel } from "../../src/runners/tmux.ts";
import { assistantOutputFromParse, parsePiJsonLines, resolvePiJsonOutcome, runHeadlessModel } from "../../src/runners/headless-model.ts";

const completed = { status: "completed", failureKind: null, exitCode: 0, signal: null };
const failed = { ...completed, status: "failed", failureKind: "timeout" };
const message = content => ({ type: "message_end", message: { role: "assistant", content, stopReason: "toolUse" } });
const finding = message([{ type: "text", text: "Supported finding before the tool wait" }]);
const toolOnly = message([{ type: "toolCall", id: "one", name: "read", arguments: {} }]);
const parsed = parsePiJsonLines([finding, toolOnly].map(JSON.stringify).join("\n"));
assert.equal(parsed.finalAssistantText, "", "do not redefine the final message");
assert.deepEqual(assistantOutputFromParse(parsed, failed), { text: "Supported finding before the tool wait", partial: true });
assert.deepEqual(assistantOutputFromParse(parsed, completed), { text: "", partial: false }, "a completed process cannot promote stale progress to a final answer");
assert.equal(resolvePiJsonOutcome(failed, parsed, false).status, "failed");
assert.deepEqual(assistantOutputFromParse(parsePiJsonLines(""), failed), { text: "", partial: false });
const envelope = createResultEnvelope({ runId: "test", attemptId: "one", backend: "headless", status: "failed", cwd: "/tmp", metadata: { outputPartial: true } });
assert.equal(envelope.metadata.outputPartial, true, "partial marker survives result serialization");

const cwd = await mkdtemp(join(tmpdir(), "pi-subagent-output-recovery-"));
try {
	const fakePi = join(cwd, "fake-pi.mjs");
	await writeFile(fakePi, `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(finding))});\nconsole.log(${JSON.stringify(JSON.stringify(toolOnly))});\nsetInterval(() => {}, 1000);\n`);
	await chmod(fakePi, 0o700);
	const output = result => readFile(join(cwd, result.artifacts.find(a => a.type === "output").path), "utf8");
	const result = await runHeadlessModel({ cwd, piCommand: fakePi, agent: "fixture", task: "timeout", timeoutMs: 1000 });
	assert.equal(result.status, "failed");
	assert.equal(result.failureKind, "timeout");
	assert.equal(await output(result), "Supported finding before the tool wait");
	assert.equal(result.metadata.outputPartial, true);

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 1000);
	try {
		const aborted = await runHeadlessModel({ cwd, piCommand: fakePi, agent: "fixture", task: "abort", signal: controller.signal });
		assert.equal(aborted.status, "cancelled");
		assert.equal(aborted.failureKind, "abort");
		assert.equal(await output(aborted), "Supported finding before the tool wait");
		assert.equal(aborted.metadata.outputPartial, true);
	} finally { clearTimeout(timer); }

	const tmuxAvailable = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
	if (tmuxAvailable) {
		const tmux = await runTmuxModel({ cwd, piCommand: fakePi, agent: "fixture", task: "tmux timeout", timeoutMs: 1000 });
		assert.equal(tmux.status, "failed");
		assert.equal(tmux.failureKind, "timeout");
		assert.equal(await output(tmux), "Supported finding before the tool wait");
		assert.equal(tmux.metadata.outputPartial, true);
	} else {
		console.log("tmux partial-output check skipped: tmux unavailable");
	}

	const marker = join(cwd, "launched");
	await writeFile(fakePi, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'should not launch');\n`);
	const gated = await runHeadlessModel({ cwd, piCommand: fakePi, agent: "fixture", task: "deadline before release", timeoutMs: 100, onProcessStart: () => new Promise(resolve => setTimeout(resolve, 250)) });
	assert.equal(gated.failureKind, "timeout");
	await assert.rejects(readFile(marker), { code: "ENOENT" });
	assert.equal(gated.metadata.outputPartial, undefined);
	console.log(JSON.stringify({ name: "check-output-recovery", status: "completed", providerCalls: 0 }));
} finally {
	await rm(cwd, { recursive: true, force: true });
}
