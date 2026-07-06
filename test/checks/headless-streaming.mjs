#!/usr/bin/env node
import assert from "node:assert/strict";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildPiArgv,
	runHeadlessModel,
} from "../../src/runners/headless-model.ts";

function artifactByType(result, type) {
	const artifact = result.artifacts.find(
		(candidate) => candidate.type === type,
	);
	assert.ok(artifact, `missing ${type} artifact`);
	return artifact;
}

function maybeArtifactByType(result, type) {
	return result.artifacts.find((candidate) => candidate.type === type);
}

const argvWithSession = buildPiArgv({
	agent: "argv-worker",
	task: "inspect argv",
	sessionId: "abc-123",
});
assert.equal(argvWithSession.includes("--session-id"), true);
assert.equal(
	argvWithSession[argvWithSession.indexOf("--session-id") + 1],
	"abc-123",
);
assert.equal(argvWithSession.includes("--no-session"), false);

const argvWithoutSession = buildPiArgv({
	agent: "argv-worker",
	task: "inspect argv",
	sessionId: undefined,
});
assert.equal(argvWithoutSession.includes("--no-session"), true);
assert.equal(argvWithoutSession.includes("--session-id"), false);

const tempRoot = await mkdtemp(
	join(tmpdir(), "pi-subagent-headless-streaming-"),
);
try {
	const cwd = join(tempRoot, "workspace");
	await mkdir(cwd, { recursive: true });
	const fakePi = join(tempRoot, "fake-pi.mjs");
	await writeFile(
		fakePi,
		`#!/usr/bin/env node
const filler = "x".repeat(4096);
for (let index = 0; index < 768; index += 1) {
  process.stdout.write(JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: filler + index }] } }) + "\\n");
}
process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "fetch_content", args: { url: "https://user:pass@docs.example.test/a/b?token=secret#fragment", headers: { Authorization: "Bearer secret-token", Cookie: "cookie-secret" }, nested: { apiKey: "api-key-secret" }, prompt: "summarize this page" } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "tool_execution_update", toolCallId: "tool-1", toolName: "fetch_content", args: {}, partialResult: { text: "should-not-appear-update-secret" } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "fetch_content", result: { content: [{ type: "text", text: "result-body-secret" + filler }], url: "https://docs.example.test/a/b?token=secret#fragment" }, isError: false }) + "\\n");
process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolCallId: "tool-2", toolName: "read", args: { path: "/tmp/missing-evidence.json", limit: 20, url: "https://user:pass@files.example.test/private?token=secret#fragment", headers: { Authorization: "Bearer failed-secret" }, nested: { token: "nested-token-secret", safe: "safe-value" }, items: Array.from({ length: 18 }, (_, index) => index), deep: { a: { b: { c: "too-deep" } } } } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "tool_execution_update", toolCallId: "tool-2", toolName: "read", partialResult: { content: "failed-update-secret" } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "tool_execution_end", toolCallId: "tool-2", toolName: "read", result: { content: "File not found: /tmp/missing-evidence.json", diagnosticUrl: "https://user:pass@errors.example.test/detail?token=secret#fragment", longText: filler, secret: "result-secret-redacted", nested: { password: "password-secret", message: "safe-message" } }, isError: true }) + "\\n");
process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "stream-parser-ok" }], provider: "fake", model: "fake/model", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end" } }) + "\\n");
`,
		"utf8",
	);
	await chmod(fakePi, 0o700);

	const result = await runHeadlessModel({
		cwd,
		runId: "run_check_headless_streaming",
		attemptId: "attempt-streaming",
		piCommand: fakePi,
		agent: "stream-worker",
		task: "emit a large event stream",
		parentSessionId: "parent-session-1",
		sessionId: "abc-123",
		timeoutMs: 30_000,
	});

	assert.equal(result.status, "completed");
	assert.equal(result.failureKind, null);
	assert.equal(result.metadata.contextLengthExceeded, false);
	assert.equal(result.metadata.provider, "fake");
	assert.equal(result.metadata.model, "fake/model");
	assert.equal(result.metadata.parentSessionId, "parent-session-1");
	assert.equal(result.metadata.sessionId, "abc-123");
	assert.deepEqual(result.metadata.session, {
		id: "abc-123",
		requested: true,
		disposition: "created",
	});

	const outputPath = join(cwd, artifactByType(result, "output").path);
	assert.equal(await readFile(outputPath, "utf8"), "stream-parser-ok");

	assert.equal(
		result.artifacts.some((artifact) => artifact.type === "stdout"),
		false,
		"stdout event streams should not be stored by default",
	);
	assert.equal(
		maybeArtifactByType(result, "tool-calls"),
		undefined,
		"tool call telemetry should be off by default",
	);
	assert.equal(
		maybeArtifactByType(result, "tool-calls-summary"),
		undefined,
		"tool call telemetry summary should be off by default",
	);

	const captured = await runHeadlessModel({
		cwd,
		runId: "run_check_headless_tool_calls",
		attemptId: "attempt-tool-calls",
		piCommand: fakePi,
		agent: "stream-worker",
		task: "emit a tool call stream",
		timeoutMs: 30_000,
		captureToolCalls: true,
	});
	assert.equal(captured.status, "completed");
	assert.deepEqual(captured.metadata.session, {
		requested: false,
		disposition: "ephemeral",
	});
	const callsText = await readFile(
		join(cwd, artifactByType(captured, "tool-calls").path),
		"utf8",
	);
	const summary = JSON.parse(
		await readFile(
			join(cwd, artifactByType(captured, "tool-calls-summary").path),
			"utf8",
		),
	);
	const callRecords = callsText
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.equal(callRecords.length, 2);
	assert.equal(callRecords[0].toolCallId, "tool-1");
	assert.equal(callRecords[0].toolName, "fetch_content");
	assert.equal(callRecords[0].category, "network");
	assert.equal(callRecords[0].status, "completed");
	assert.equal(callRecords[0].isError, false);
	assert.equal(callRecords[0].failedArgs, undefined);
	assert.equal(callRecords[0].failedResult, undefined);
	assert.ok(callRecords[0].durationMs >= 0);
	assert.equal(callRecords[1].toolCallId, "tool-2");
	assert.equal(callRecords[1].toolName, "read");
	assert.equal(callRecords[1].category, "filesystem");
	assert.equal(callRecords[1].status, "failed");
	assert.equal(callRecords[1].isError, true);
	assert.equal(
		callRecords[1].failedArgs.value.path,
		"/tmp/missing-evidence.json",
	);
	assert.equal(
		callRecords[1].failedArgs.value.url,
		"https://files.example.test/private",
	);
	assert.equal(callRecords[1].failedArgs.value.headers, "[REDACTED]");
	assert.equal(callRecords[1].failedArgs.value.nested.token, "[REDACTED]");
	assert.equal(callRecords[1].failedArgs.value.items.length, 16);
	assert.equal(callRecords[1].failedArgs.value.deep.a.b, "[truncated]");
	assert.equal(callRecords[1].failedArgs.truncated, true);
	assert.equal(
		callRecords[1].failedResult.value.content,
		"File not found: /tmp/missing-evidence.json",
	);
	assert.equal(
		callRecords[1].failedResult.value.diagnosticUrl,
		"https://errors.example.test/detail",
	);
	assert.ok(callRecords[1].failedResult.value.longText.length <= 500);
	assert.equal(callRecords[1].failedResult.value.secret, "[REDACTED]");
	assert.equal(callRecords[1].failedResult.value.nested.password, "[REDACTED]");
	assert.equal(callRecords[1].failedResult.truncated, true);
	assert.deepEqual(summary.callsByTool, { fetch_content: 1, read: 1 });
	assert.equal(summary.callsByCategory.network, 1);
	assert.equal(summary.callsByCategory.filesystem, 1);
	assert.equal(summary.errorsByTool.read, 1);
	assert.equal(summary.totalCalls, 2);
	assert.equal(summary.limits.updatesCaptured, false);
	assert.equal(summary.limits.fullArgsStored, false);
	assert.equal(summary.limits.fullResultsStored, false);
	assert.equal(summary.limits.failedArgsStored, true);
	assert.equal(summary.limits.failedResultsStored, true);
	assert.equal(summary.limits.maxDetailStringLength, 500);
	assert.equal(summary.limits.maxDetailArrayItems, 16);
	assert.equal(summary.limits.maxDetailDepth, 3);
	assert.ok(summary.resources.urls.includes("https://docs.example.test/a/b"));
	assert.ok(summary.resources.hosts.includes("docs.example.test"));
	assert.match(callsText, /"redactedKeys":\["headers"\]/);
	assert.doesNotMatch(
		callsText,
		/Bearer secret-token|cookie-secret|api-key-secret|Bearer failed-secret|nested-token-secret|result-body-secret|result-secret-redacted|password-secret|should-not-appear-update-secret|failed-update-secret|user:pass@|token=secret|#fragment/,
	);

	const nonFatalErrorPi = join(tempRoot, "fake-pi-non-fatal-error.mjs");
	await writeFile(
		nonFatalErrorPi,
		`#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "error", error: { message: "transient stream warning" } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "valid-final-output" }], provider: "fake", model: "fake/model", stopReason: "stop" } }) + "\\n");
`,
		"utf8",
	);
	await chmod(nonFatalErrorPi, 0o700);

	const nonFatal = await runHeadlessModel({
		cwd,
		runId: "run_check_headless_non_fatal_error",
		attemptId: "attempt-non-fatal-error",
		piCommand: nonFatalErrorPi,
		agent: "stream-worker",
		task: "emit a warning before final output",
		timeoutMs: 30_000,
	});
	assert.equal(nonFatal.status, "completed");
	assert.equal(nonFatal.failureKind, null);
	assert.deepEqual(nonFatal.metadata.streamErrors, [
		"transient stream warning",
	]);
	assert.deepEqual(nonFatal.metadata.nonFatalStreamErrors, [
		"transient stream warning",
	]);
	assert.equal(
		await readFile(join(cwd, artifactByType(nonFatal, "output").path), "utf8"),
		"valid-final-output",
	);

	const recoveredContextPi = join(tempRoot, "fake-pi-recovered-context.mjs");
	await writeFile(
		recoveredContextPi,
		`#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "error", error: { message: "context_length_exceeded: compacted and retrying" } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "recovered-final-output" }], provider: "fake", model: "fake/model", stopReason: "stop" } }) + "\\n");
`,
		"utf8",
	);
	await chmod(recoveredContextPi, 0o700);

	const recoveredContext = await runHeadlessModel({
		cwd,
		runId: "run_check_headless_recovered_context",
		attemptId: "attempt-recovered-context",
		piCommand: recoveredContextPi,
		agent: "stream-worker",
		task: "recover from context overflow before final output",
		timeoutMs: 30_000,
	});
	assert.equal(recoveredContext.status, "completed");
	assert.equal(recoveredContext.failureKind, null);
	assert.equal(recoveredContext.metadata.contextLengthExceeded, false);
	assert.equal(recoveredContext.metadata.contextOverflowRecovered, true);
	assert.deepEqual(recoveredContext.metadata.streamErrors, [
		"context_length_exceeded: compacted and retrying",
	]);
	assert.deepEqual(recoveredContext.metadata.nonFatalStreamErrors, [
		"context_length_exceeded: compacted and retrying",
	]);
	assert.deepEqual(recoveredContext.metadata.recoveredStreamErrors, [
		"context_length_exceeded: compacted and retrying",
	]);
	assert.equal(
		await readFile(
			join(cwd, artifactByType(recoveredContext, "output").path),
			"utf8",
		),
		"recovered-final-output",
	);

	const terminalContextPi = join(tempRoot, "fake-pi-terminal-context.mjs");
	await writeFile(
		terminalContextPi,
		`#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "error", error: { message: "context_length_exceeded: cannot continue" } }) + "\\n");
`,
		"utf8",
	);
	await chmod(terminalContextPi, 0o700);

	const terminalContext = await runHeadlessModel({
		cwd,
		runId: "run_check_headless_terminal_context",
		attemptId: "attempt-terminal-context",
		piCommand: terminalContextPi,
		agent: "stream-worker",
		task: "fail after unrecovered context overflow",
		timeoutMs: 30_000,
	});
	assert.equal(terminalContext.status, "failed");
	assert.equal(terminalContext.failureKind, "model");
	assert.equal(terminalContext.metadata.contextLengthExceeded, true);
	assert.equal(terminalContext.metadata.contextOverflowRecovered, undefined);
	assert.deepEqual(terminalContext.metadata.streamErrors, [
		"context_length_exceeded: cannot continue",
	]);
	assert.equal(terminalContext.metadata.nonFatalStreamErrors, undefined);
	assert.equal(terminalContext.metadata.recoveredStreamErrors, undefined);

	const fatalErrorPi = join(tempRoot, "fake-pi-fatal-error.mjs");
	await writeFile(
		fatalErrorPi,
		`#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "error", error: { message: "fatal stream error" } }) + "\\n");
`,
		"utf8",
	);
	await chmod(fatalErrorPi, 0o700);

	const fatal = await runHeadlessModel({
		cwd,
		runId: "run_check_headless_fatal_error",
		attemptId: "attempt-fatal-error",
		piCommand: fatalErrorPi,
		agent: "stream-worker",
		task: "emit only an error event",
		timeoutMs: 30_000,
	});
	assert.equal(fatal.status, "failed");
	assert.equal(fatal.failureKind, "model");
	assert.deepEqual(fatal.metadata.streamErrors, ["fatal stream error"]);
	assert.equal(fatal.metadata.nonFatalStreamErrors, undefined);

	const abortPi = join(tempRoot, "fake-pi-abort.mjs");
	await writeFile(
		abortPi,
		`#!/usr/bin/env node
setInterval(() => undefined, 1000);
`,
		"utf8",
	);
	await chmod(abortPi, 0o700);
	const abortController = new AbortController();
	const aborted = await runHeadlessModel({
		cwd,
		runId: "run_check_headless_abort",
		attemptId: "attempt-abort",
		piCommand: abortPi,
		agent: "stream-worker",
		task: "stay alive until aborted",
		timeoutMs: 30_000,
		signal: abortController.signal,
		onProcessStart: () => abortController.abort(),
	});
	assert.equal(aborted.status, "cancelled");
	assert.equal(aborted.failureKind, "abort");

	console.log(
		JSON.stringify(
			{ name: "check-headless-streaming", status: "completed" },
			null,
			2,
		),
	);
} finally {
	await rm(tempRoot, { recursive: true, force: true });
}
