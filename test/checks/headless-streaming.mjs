#!/usr/bin/env node
import assert from "node:assert/strict";
import childProcess, { spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import {
	access,
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
	abortFailureKind,
	userCancelledAbortReason,
} from "../../src/core/constants.ts";
import {
	buildPiArgv,
	runHeadlessModel,
} from "../../src/runners/headless-model.ts";
import {
	captureProcessIdentity,
	verifyProcessIdentity,
} from "../../src/process-identity.ts";

function artifactByType(result, type) {
	const artifact = result.artifacts.find((candidate) => candidate.type === type);
	assert.ok(artifact, `missing ${type} artifact`);
	return artifact;
}

function maybeArtifactByType(result, type) {
	return result.artifacts.find((candidate) => candidate.type === type);
}

// Exercise the real child, ownership capture and group drain, but make a gate
// write deterministically report the disconnected-pipe error seen on macOS.
async function withDisconnectedGate(check) {
	const originalSpawn = childProcess.spawn;
	const probe = {
		writes: 0,
		error: Object.assign(new Error("write ENOTCONN"), { code: "ENOTCONN" }),
	};
	childProcess.spawn = (...args) => {
		const child = originalSpawn(...args);
		if (args[1]?.[0]?.endsWith("/process-gate.mjs")) {
			child.stdin.end = () => {
				probe.writes += 1;
				queueMicrotask(() => child.stdin.emit("error", probe.error));
				return child.stdin;
			};
		}
		return child;
	};
	syncBuiltinESMExports();
	try {
		await check(probe);
	} finally {
		childProcess.spawn = originalSpawn;
		syncBuiltinESMExports();
	}
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
const sleep = (ms) =>
	new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
try {
	const cwd = join(tempRoot, "workspace");
	await mkdir(cwd, { recursive: true });
	const execProbe = spawn(
		"/bin/bash",
		["-c", "IFS= read -r gate; exec /bin/sleep 30", "identity-exec-probe"],
		{ detached: true, stdio: ["pipe", "ignore", "ignore"] },
	);
	assert.equal(typeof execProbe.pid, "number");
	try {
		const preExecIdentity = await captureProcessIdentity(execProbe.pid);
		execProbe.stdin.end("go\n");
		await sleep(100);
		assert.equal(
			await verifyProcessIdentity(preExecIdentity),
			"alive",
			"birth identity must remain stable across exec",
		);
	} finally {
		try {
			process.kill(-execProbe.pid, "SIGKILL");
		} catch {
			// The owned identity probe already exited.
		}
	}
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

	const envPi = join(tempRoot, "env-pi.mjs");
	await writeFile(
		envPi,
		`#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: process.env.PI_SUBAGENT_DURABLE_WORKER_BINDING_JSON ?? "unset" }], provider: "fake", model: "fake/model", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end" } }) + "\\n");
`,
		"utf8",
	);
	await chmod(envPi, 0o700);
	process.env.PI_SUBAGENT_DURABLE_WORKER_BINDING_JSON = "stale-parent-binding";
	const unsetBinding = await runHeadlessModel({
		cwd,
		runId: "run_check_headless_env_unset",
		attemptId: "attempt-env-unset",
		piCommand: envPi,
		agent: "env-worker",
		task: "inspect env",
	});
	assert.equal(
		await readFile(
			join(cwd, artifactByType(unsetBinding, "output").path),
			"utf8",
		),
		"unset",
	);
	const explicitBinding = await runHeadlessModel({
		cwd,
		runId: "run_check_headless_env_explicit",
		attemptId: "attempt-env-explicit",
		piCommand: envPi,
		agent: "env-worker",
		task: "inspect env",
		childEnv: { PI_SUBAGENT_DURABLE_WORKER_BINDING_JSON: "current-binding" },
	});
	assert.equal(
		await readFile(
			join(cwd, artifactByType(explicitBinding, "output").path),
			"utf8",
		),
		"current-binding",
	);
	delete process.env.PI_SUBAGENT_DURABLE_WORKER_BINDING_JSON;

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
	assert.deepEqual(nonFatal.metadata.streamErrors, ["transient stream warning"]);
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

	// An abort whose reason is tagged by the durable worker (operator interrupt
	// delivered as SIGINT/SIGTERM) is recorded as user_cancelled, matching the
	// worker's own pre-execution cancellations.
	const interruptController = new AbortController();
	const interrupted = await runHeadlessModel({
		cwd,
		runId: "run_check_headless_user_cancelled",
		attemptId: "attempt-user-cancelled",
		piCommand: abortPi,
		agent: "stream-worker",
		task: "stay alive until interrupted",
		timeoutMs: 30_000,
		signal: interruptController.signal,
		onProcessStart: () =>
			interruptController.abort(
				userCancelledAbortReason("durable worker received SIGINT"),
			),
	});
	assert.equal(interrupted.status, "cancelled");
	assert.equal(interrupted.failureKind, "user_cancelled");

	for (const reason of [
		undefined,
		userCancelledAbortReason("operator interrupt"),
	]) {
		await withDisconnectedGate(async (probe) => {
			const controller = new AbortController();
			const result = await runHeadlessModel({
				cwd,
				piCommand: abortPi,
				agent: "stream-worker",
				task: "never release an aborted ownership gate",
				timeoutMs: 30_000,
				signal: controller.signal,
				onProcessStart: async () => {
					controller.abort(reason);
					await Promise.resolve();
				},
			});
			assert.equal(result.status, "cancelled");
			assert.equal(result.failureKind, abortFailureKind(controller.signal));
			assert.equal(
				probe.writes,
				0,
				"an aborted gate must receive no launch payload",
			);
		});
	}
	await withDisconnectedGate(async (probe) => {
		await assert.rejects(
			runHeadlessModel({
				cwd,
				piCommand: abortPi,
				agent: "stream-worker",
				task: "unexpected pipe errors must still fail closed",
				timeoutMs: 30_000,
			}),
			(error) => error === probe.error,
		);
		assert.equal(probe.writes, 1);
	});

	// A process-group kill that fails with EPERM (seen on macOS while the leader
	// exits) must not escape the abort listener; the runner falls back to
	// signalling the child directly and still settles as cancelled.
	const originalKill = process.kill;
	let groupKillAttempts = 0;
	process.kill = (pid, signal) => {
		// Fail real group signals only; signal 0 liveness probes keep working.
		if (typeof pid === "number" && pid < 0 && signal !== 0) {
			groupKillAttempts += 1;
			const error = new Error("kill EPERM");
			error.code = "EPERM";
			throw error;
		}
		return originalKill.call(process, pid, signal);
	};
	try {
		const epermController = new AbortController();
		const epermAborted = await runHeadlessModel({
			cwd,
			runId: "run_check_headless_eperm",
			attemptId: "attempt-eperm",
			piCommand: abortPi,
			agent: "stream-worker",
			task: "stay alive until aborted despite EPERM",
			timeoutMs: 30_000,
			signal: epermController.signal,
			onProcessStart: () => epermController.abort(),
		});
		assert.equal(epermAborted.status, "cancelled");
		assert.equal(epermAborted.failureKind, "abort");
		assert.ok(groupKillAttempts >= 1, "group kill was attempted");
		const epermStderr = await readFile(
			join(cwd, artifactByType(epermAborted, "stderr").path),
			"utf8",
		);
		assert.match(epermStderr, /process-group kill failed: EPERM/u);
	} finally {
		process.kill = originalKill;
	}
	assert.equal(abortFailureKind(undefined), "abort");
	assert.equal(abortFailureKind(interruptController.signal), "user_cancelled");

	const gatedPi = join(tempRoot, "fake-pi-gated.mjs");
	const gatedSideEffect = join(cwd, "gated-side-effect");
	await writeFile(
		gatedPi,
		`#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(gatedSideEffect)}, "started");
process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "gated" }], provider: "fake", model: "fake/model", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end" } }) + "\\n");
`,
		"utf8",
	);
	await chmod(gatedPi, 0o700);
	const shellHook = join(tempRoot, "gate-shell-hook.sh");
	const shellHookSideEffect = join(cwd, "shell-hook-side-effect");
	const nodeHook = join(tempRoot, "gate-node-hook.cjs");
	const nodeHookSideEffect = join(cwd, "node-hook-side-effect");
	await writeFile(
		shellHook,
		`echo unsafe > ${JSON.stringify(shellHookSideEffect)}\n`,
	);
	await writeFile(
		nodeHook,
		`require("node:fs").writeFileSync(${JSON.stringify(nodeHookSideEffect)}, "loaded");\n`,
	);
	const previousBashEnv = process.env.BASH_ENV;
	const previousNodeOptions = process.env.NODE_OPTIONS;
	process.env.BASH_ENV = shellHook;
	process.env.NODE_OPTIONS = `--require=${nodeHook}`;
	let releaseOwnership;
	const ownershipReleased = new Promise((resolveRelease) => {
		releaseOwnership = resolveRelease;
	});
	let recordedProcess;
	const gatedRun = runHeadlessModel({
		cwd,
		runId: "run_check_headless_gate",
		attemptId: "attempt-headless-gate",
		piCommand: gatedPi,
		agent: "stream-worker",
		task: "wait for ownership",
		timeoutMs: 30_000,
		onProcessStart: async (processMetadata) => {
			recordedProcess = processMetadata;
			await ownershipReleased;
		},
	});
	for (let index = 0; index < 100 && recordedProcess === undefined; index += 1)
		await sleep(10);
	if (previousBashEnv === undefined) delete process.env.BASH_ENV;
	else process.env.BASH_ENV = previousBashEnv;
	if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
	else process.env.NODE_OPTIONS = previousNodeOptions;
	assert.equal(typeof recordedProcess?.pid, "number");
	assert.equal(typeof recordedProcess?.processGroupId, "number");
	assert.equal(typeof recordedProcess?.processBirthIdentity, "string");
	await sleep(100);
	await assert.rejects(access(gatedSideEffect));
	await assert.rejects(
		access(shellHookSideEffect),
		"shell startup hooks must not run before the ownership gate",
	);
	await assert.rejects(
		access(nodeHookSideEffect),
		"loader hooks must not run in the ownership gate",
	);
	releaseOwnership();
	const gatedResult = await gatedRun;
	assert.equal(gatedResult.status, "completed");
	assert.equal(await access(gatedSideEffect), undefined);
	assert.equal(await access(nodeHookSideEffect), undefined);

	const rejectedSideEffect = join(cwd, "rejected-gate-side-effect");
	await writeFile(
		gatedPi,
		`#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(rejectedSideEffect)}, "started");
`,
		"utf8",
	);
	await assert.rejects(
		runHeadlessModel({
			cwd,
			runId: "run_check_headless_gate_rejected",
			attemptId: "attempt-headless-gate-rejected",
			piCommand: gatedPi,
			agent: "stream-worker",
			task: "reject ownership",
			timeoutMs: 30_000,
			onProcessStart: async () => {
				throw new Error("persistence rejected");
			},
		}),
		/persistence rejected/u,
	);
	await sleep(100);
	await assert.rejects(access(rejectedSideEffect));

	const stubbornPi = join(tempRoot, "fake-pi-stubborn-group.mjs");
	const stubbornChildPidPath = join(cwd, "stubborn-child.pid");
	const stubbornSideEffect = join(cwd, "stubborn-late-side-effect");
	await writeFile(
		stubbornPi,
		`#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(`import { writeFileSync } from "node:fs"; for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(signal, () => {}); await new Promise((resolve) => setTimeout(resolve, 3000)); writeFileSync(${JSON.stringify(stubbornSideEffect)}, "late"); await new Promise((resolve) => setTimeout(resolve, 10000));`)}], { stdio: "ignore" });
child.unref();
writeFileSync(${JSON.stringify(stubbornChildPidPath)}, String(child.pid));
process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "stubborn-group" }], provider: "fake", model: "fake/model", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end" } }) + "\\n");
`,
		"utf8",
	);
	await chmod(stubbornPi, 0o700);
	const stubbornResult = await runHeadlessModel({
		cwd,
		runId: "run_check_headless_stubborn_group",
		attemptId: "attempt-headless-stubborn-group",
		piCommand: stubbornPi,
		agent: "stream-worker",
		task: "drain stubborn process group",
		timeoutMs: 30_000,
	});
	assert.equal(stubbornResult.status, "completed");
	const stubbornChildPid = Number(
		(await readFile(stubbornChildPidPath, "utf8")).trim(),
	);
	assert.throws(() => process.kill(stubbornChildPid, 0));
	await sleep(3_100);
	await assert.rejects(access(stubbornSideEffect));

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
