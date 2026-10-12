#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
	runSubagent,
	supportsExplicitExtensionIsolation,
	waitForSubagent,
} from "../../src/api.ts";
import { supportsExplicitExtensionIsolation as supportsExplicitExtensionIsolationFromEntrypoint } from "../../api.mjs";
import { validateResolveInput } from "../../src/core/validation.ts";
import { setInlineSdkImporterForTests } from "../../src/runners/inline.ts";

assert.equal(supportsExplicitExtensionIsolation(), true);
assert.equal(supportsExplicitExtensionIsolationFromEntrypoint(), true);

const validated = validateResolveInput({
	task: "validate extension isolation",
	noExtensions: true,
	extensions: ["/tmp/explicit-extension.ts"],
	tasks: [
		{ task: "inherit", noExtensions: true },
		{ task: "override", noExtensions: false },
	],
});
assert.equal(validated.ok, true);
assert.equal(validated.input.noExtensions, true);
assert.equal(validated.input.tasks?.[0]?.noExtensions, true);
assert.equal(validated.input.tasks?.[1]?.noExtensions, false);

for (const [input, errorPattern] of [
	[
		{ task: "bad top-level option", noExtensions: "yes" },
		/noExtensions must be a boolean/u,
	],
	[
		{ tasks: [{ task: "bad task option", noExtensions: 1 }] },
		/tasks\[0\]\.noExtensions must be a boolean/u,
	],
]) {
	const result = validateResolveInput(input);
	assert.equal(result.ok, false);
	assert.match(result.failure.error, errorPattern);
}

function fakeInlineSdk(captures) {
	class DefaultResourceLoader {
		constructor(options) {
			this.options = options;
		}

		async reload() {}
	}

	return {
		module: {
			ModelRegistry: class {},
			ModelRuntime: {
				async create() {
					return {};
				},
			},
			SessionManager: {
				inMemory() {
					return {};
				},
			},
			DefaultResourceLoader,
			getAgentDir() {
				return "/nonexistent-agent-dir";
			},
			async createAgentSession(options) {
				const messages = [];
				return {
					diagnostics: [],
					session: {
						messages,
						subscribe() {
							return () => undefined;
						},
						async prompt(prompt) {
							captures.push({
								prompt,
								loaderOptions: options.resourceLoader.options,
							});
							messages.push({
								role: "assistant",
								content: [{ type: "text", text: "inline-ok" }],
								provider: "fake",
								model: "fake/model",
								stopReason: "stop",
							});
						},
						dispose() {},
					},
				};
			},
		},
		source: "<extension-isolation-fake-sdk>",
	};
}

function taskFromPrompt(prompt) {
	const marker = "Task:\n";
	const index = prompt.lastIndexOf(marker);
	assert.notEqual(index, -1, `missing task marker in ${JSON.stringify(prompt)}`);
	return prompt.slice(index + marker.length);
}

function extensionValues(argv) {
	const values = [];
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] === "--extension") values.push(argv[index + 1]);
	}
	return values;
}

const root = await mkdtemp(join(tmpdir(), "pi-subagent-extension-isolation-"));
const originalPath = process.env.PATH;
const originalCapturePath = process.env.PI_SUBAGENT_EXTENSION_ARGV_CAPTURE;

try {
	const inlineCwd = join(root, "inline");
	await mkdir(inlineCwd, { recursive: true });
	const inlineCaptures = [];
	setInlineSdkImporterForTests(async () => fakeInlineSdk(inlineCaptures));

	const omittedInline = await runSubagent({
		cwd: inlineCwd,
		backend: "inline",
		task: "inline-omitted",
	});
	assert.equal(omittedInline.status, "completed");

	const parallelInline = await runSubagent({
		cwd: inlineCwd,
		backend: "inline",
		noExtensions: true,
		extensions: ["/tmp/top-explicit.ts"],
		tasks: [
			{ task: "inline-inherit" },
			{
				task: "inline-override-additive",
				noExtensions: false,
				extensions: ["/tmp/task-explicit.ts"],
			},
			{
				task: "inline-empty-list",
				noExtensions: false,
				extensions: [],
			},
		],
	});
	assert.equal(parallelInline.mode, "parallel");
	assert.deepEqual(
		parallelInline.results.map((result) => result.status),
		["completed", "completed", "completed"],
	);

	const inlineByTask = new Map(
		inlineCaptures.map((capture) => [taskFromPrompt(capture.prompt), capture]),
	);
	assert.equal(
		inlineByTask.get("inline-omitted")?.loaderOptions.noExtensions,
		false,
	);
	assert.equal(
		inlineByTask.get("inline-omitted")?.loaderOptions.additionalExtensionPaths,
		undefined,
	);
	assert.equal(
		inlineByTask.get("inline-inherit")?.loaderOptions.noExtensions,
		true,
	);
	assert.deepEqual(
		inlineByTask.get("inline-inherit")?.loaderOptions.additionalExtensionPaths,
		["/tmp/top-explicit.ts"],
	);
	assert.equal(
		inlineByTask.get("inline-override-additive")?.loaderOptions.noExtensions,
		false,
	);
	assert.deepEqual(
		inlineByTask.get("inline-override-additive")?.loaderOptions
			.additionalExtensionPaths,
		["/tmp/task-explicit.ts"],
	);
	assert.equal(
		inlineByTask.get("inline-empty-list")?.loaderOptions.noExtensions,
		true,
	);
	assert.equal(
		inlineByTask.get("inline-empty-list")?.loaderOptions.additionalExtensionPaths,
		undefined,
	);
	setInlineSdkImporterForTests(undefined);

	const headlessCwd = join(root, "headless");
	const binDir = join(root, "bin");
	await mkdir(headlessCwd, { recursive: true });
	await mkdir(binDir, { recursive: true });
	const fakePi = join(binDir, "pi");
	await writeFile(
		fakePi,
		`#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.env.PI_SUBAGENT_EXTENSION_ARGV_CAPTURE, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "headless-ok" }], provider: "fake", model: "fake/model", stopReason: "stop" } }) + "\\n");\n`,
		"utf8",
	);
	await chmod(fakePi, 0o700);
	process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;

	async function captureHeadless(label, options) {
		const capturePath = join(root, `${label}-argv.json`);
		process.env.PI_SUBAGENT_EXTENSION_ARGV_CAPTURE = capturePath;
		const result = await runSubagent({
			cwd: headlessCwd,
			backend: "headless",
			task: label,
			...options,
		});
		assert.equal(result.status, "completed", JSON.stringify(result));
		return JSON.parse(await readFile(capturePath, "utf8"));
	}

	const omittedArgv = await captureHeadless("headless-omitted", {});
	assert.equal(omittedArgv.includes("--no-extensions"), false);
	assert.deepEqual(extensionValues(omittedArgv), []);

	const additiveArgv = await captureHeadless("headless-additive", {
		extensions: ["/tmp/additive-a.ts", "/tmp/additive-b.ts"],
	});
	assert.equal(additiveArgv.includes("--no-extensions"), false);
	assert.deepEqual(extensionValues(additiveArgv), [
		"/tmp/additive-a.ts",
		"/tmp/additive-b.ts",
	]);

	const explicitFalseArgv = await captureHeadless("headless-explicit-false", {
		noExtensions: false,
		extensions: ["/tmp/explicit-false.ts"],
	});
	assert.equal(explicitFalseArgv.includes("--no-extensions"), false);
	assert.deepEqual(extensionValues(explicitFalseArgv), [
		"/tmp/explicit-false.ts",
	]);

	const isolatedArgv = await captureHeadless("headless-isolated", {
		noExtensions: true,
		extensions: ["/tmp/isolated-a.ts", "/tmp/isolated-b.ts"],
	});
	assert.equal(isolatedArgv.includes("--no-extensions"), true);
	assert.deepEqual(extensionValues(isolatedArgv), [
		"/tmp/isolated-a.ts",
		"/tmp/isolated-b.ts",
	]);

	const emptyArgv = await captureHeadless("headless-empty", {
		noExtensions: false,
		extensions: [],
	});
	assert.equal(emptyArgv.includes("--no-extensions"), true);
	assert.deepEqual(extensionValues(emptyArgv), []);

	const durableCapturePath = join(root, "durable-argv.json");
	process.env.PI_SUBAGENT_EXTENSION_ARGV_CAPTURE = durableCapturePath;
	const durable = await runSubagent({
		cwd: headlessCwd,
		backend: "headless",
		async: true,
		task: "durable-isolated",
		noExtensions: true,
		extensions: ["/tmp/durable-explicit.ts"],
	});
	assert.equal(durable.status, "running");
	const workerArtifact = durable.artifacts.find(
		(artifact) => artifact.type === "worker",
	);
	assert.ok(
		workerArtifact,
		"durable launch must expose worker payload evidence",
	);
	const workerPayload = JSON.parse(
		await readFile(resolve(headlessCwd, workerArtifact.path), "utf8"),
	);
	assert.equal(workerPayload.input.noExtensions, true);
	assert.deepEqual(workerPayload.input.extensions, ["/tmp/durable-explicit.ts"]);
	const durableWait = await waitForSubagent({
		cwd: headlessCwd,
		runId: durable.runId,
		attemptId: durable.attemptId,
		timeoutMs: 30_000,
		pollIntervalMs: 50,
	});
	assert.equal(durableWait.status, "completed");
	assert.equal(durableWait.snapshot?.status, "completed");
	const durableArgv = JSON.parse(await readFile(durableCapturePath, "utf8"));
	assert.equal(durableArgv.includes("--no-extensions"), true);
	assert.deepEqual(extensionValues(durableArgv), ["/tmp/durable-explicit.ts"]);

	const pi11NodeModules =
		process.env.PI_SUBAGENT_PI11_NODE_MODULES ??
		resolve(import.meta.dirname, "../../node_modules");
	const pi11PackagePath = join(
		pi11NodeModules,
		"@earendil-works/pi-coding-agent/package.json",
	);
	await access(pi11PackagePath);
	const pi11Package = JSON.parse(await readFile(pi11PackagePath, "utf8"));
	assert.equal(pi11Package.version, "1.1.0");
	const pi11Cli = join(
		pi11NodeModules,
		"@earendil-works/pi-coding-agent/dist/bundle/cli.js",
	);
	const pi11Root = join(root, "pi11");
	const pi11AgentDir = join(pi11Root, "agent");
	const pi11WorkDir = join(pi11Root, "work");
	const pi11Home = join(pi11Root, "home");
	const ambientExtension = join(pi11AgentDir, "extensions/ambient.js");
	const explicitExtension = join(pi11Root, "explicit.js");
	await mkdir(join(pi11AgentDir, "extensions"), { recursive: true });
	await mkdir(pi11WorkDir, { recursive: true });
	await mkdir(pi11Home, { recursive: true });
	await writeFile(
		ambientExtension,
		'export default function (pi) { pi.registerFlag("ambient-loaded", { description: "AMBIENT_COLLISION_MARKER", type: "boolean", default: false }); pi.registerMcpServer("collision-probe", { url: "https://ambient.invalid/mcp" }); }\n',
	);
	await writeFile(
		explicitExtension,
		'export default function (pi) { pi.registerMcpServer("collision-probe", { url: "https://explicit.invalid/mcp" }); pi.registerFlag("explicit-loaded", { description: "EXPLICIT_COLLISION_MARKER", type: "boolean", default: false }); }\n',
	);

	const pi11Sdk = await import(
		pathToFileURL(
			join(pi11NodeModules, "@earendil-works/pi-coding-agent/dist/index.js"),
		).href
	);
	async function loadPi11Extensions(noExtensions) {
		const loader = new pi11Sdk.DefaultResourceLoader({
			cwd: pi11WorkDir,
			agentDir: pi11AgentDir,
			additionalExtensionPaths: [explicitExtension],
			noExtensions,
			disabledBuiltinExtensions: [],
		});
		await loader.reload();
		return loader.getExtensions();
	}
	const additivePi11Extensions = await loadPi11Extensions(false);
	assert.deepEqual(
		additivePi11Extensions.extensions.map((extension) => extension.path),
		[explicitExtension],
	);
	assert.equal(additivePi11Extensions.errors.length, 1);
	assert.equal(additivePi11Extensions.errors[0].path, ambientExtension);
	assert.match(
		additivePi11Extensions.errors[0].error,
		/MCP server "collision-probe" is already registered/u,
	);

	const isolatedPi11Extensions = await loadPi11Extensions(true);
	assert.deepEqual(
		isolatedPi11Extensions.extensions.map((extension) => extension.path),
		[explicitExtension],
	);
	assert.deepEqual(isolatedPi11Extensions.errors, []);

	const pi11Env = {
		HOME: pi11Home,
		PATH: process.env.PATH ?? "",
		PI_CODING_AGENT_DIR: pi11AgentDir,
		PI_OFFLINE: "1",
	};
	const isolatedPi11 = spawnSync(
		process.execPath,
		[pi11Cli, "--no-extensions", "--extension", explicitExtension, "--help"],
		{
			cwd: pi11WorkDir,
			env: pi11Env,
			encoding: "utf8",
			timeout: 30_000,
		},
	);
	assert.equal(isolatedPi11.status, 0, isolatedPi11.stderr);
	assert.match(isolatedPi11.stdout, /EXPLICIT_COLLISION_MARKER/u);
	assert.doesNotMatch(isolatedPi11.stdout, /AMBIENT_COLLISION_MARKER/u);

	console.log(
		JSON.stringify(
			{
				name: "check-extension-isolation",
				status: "completed",
				piVersion: pi11Package.version,
				pi11CollisionProbe: "passed",
			},
			null,
			2,
		),
	);
} finally {
	setInlineSdkImporterForTests(undefined);
	if (originalPath === undefined) delete process.env.PATH;
	else process.env.PATH = originalPath;
	if (originalCapturePath === undefined)
		delete process.env.PI_SUBAGENT_EXTENSION_ARGV_CAPTURE;
	else process.env.PI_SUBAGENT_EXTENSION_ARGV_CAPTURE = originalCapturePath;
	await rm(root, { recursive: true, force: true });
}
