#!/usr/bin/env node
// Inline runs must see models that extensions register (issue #5): an explicit
// model, the settings default, and a virtual model. Each case runs in a child
// process without provider credentials, against a local fake provider, so a
// regression cannot reach a real provider.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv[2] === "--case") {
	const { getSubagentLogs, runSubagent } = await import("../../api.mjs");
	const options = JSON.parse(process.argv[3]);
	const result = await runSubagent(options);
	const logs = await getSubagentLogs({ cwd: options.cwd, runId: result.runId });
	console.log(
		JSON.stringify({
			status: result.status,
			provider: result.metadata?.provider,
			model: result.metadata?.model,
			output: logs?.logText.output ?? "",
			stderr: logs?.logText.stderr ?? "",
			virtualModels: globalThis.__piSubagentCheckVirtualModels === true,
		}),
	);
	process.exit(0);
}

const requests = [];
const server = createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => {
		body += chunk;
	});
	req.on("end", () => {
		const parsed = JSON.parse(body || "{}");
		requests.push({ url: req.url, model: parsed.model });
		const base = { id: "chatcmpl-check", created: 0, model: parsed.model };
		if (parsed.stream !== true) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					...base,
					object: "chat.completion",
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: "OK" },
							finish_reason: "stop",
						},
					],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				}),
			);
			return;
		}
		const event = (payload) =>
			`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", ...payload })}\n\n`;
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
		});
		res.write(
			event({
				choices: [
					{
						index: 0,
						delta: { role: "assistant", content: "OK" },
						finish_reason: null,
					},
				],
			}),
		);
		res.write(
			event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
		);
		res.write(
			event({
				choices: [],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			}),
		);
		res.end("data: [DONE]\n\n");
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const scratch = await mkdtemp(
	join(tmpdir(), "pi-subagent-inline-ext-providers-"),
);

const extensionSource = `const baseUrl = ${JSON.stringify(baseUrl)};
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const m1 = { id: "m1", name: "m1", reasoning: false, input: ["text"], cost, contextWindow: 8000, maxTokens: 256 };
export default function (pi) {
	pi.registerProvider("fakeprov", { baseUrl, apiKey: "pi-subagent-check", api: "openai-completions", models: [m1] });
	if (typeof pi.registerVirtualModel === "function") {
		globalThis.__piSubagentCheckVirtualModels = true;
		pi.registerVirtualModel({
			provider: "fakevirt",
			id: "router",
			name: "router",
			route: () => ({ model: { ...m1, api: "openai-completions", provider: "fakeprov", baseUrl }, thinkingLevel: "off" }),
		});
	}
}
`;
const noRetry = { retry: { enabled: false, provider: { maxRetries: 0 } } };

async function agentDir(name, settings, withAmbientExtension) {
	const dir = join(scratch, name);
	await mkdir(join(dir, "extensions"), { recursive: true });
	await writeFile(
		join(dir, "settings.json"),
		JSON.stringify({ ...noRetry, ...settings }),
	);
	if (withAmbientExtension)
		await writeFile(join(dir, "extensions", "fake-provider.ts"), extensionSource);
	return dir;
}

function runCase(options, piAgentDir) {
	// Only what the case needs: no provider credentials are inherited.
	const env = {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? scratch,
		TMPDIR: process.env.TMPDIR ?? tmpdir(),
		PI_CODING_AGENT_DIR: piAgentDir,
		PI_SUBAGENT_RUN_INDEX_DIR: join(scratch, "run-index"),
	};
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[fileURLToPath(import.meta.url), "--case", JSON.stringify(options)],
			{
				env,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			const line = stdout.trim().split("\n").at(-1) ?? "";
			try {
				resolve(JSON.parse(line));
			} catch {
				reject(
					new Error(`case exited ${code} without a result:\n${stdout}\n${stderr}`),
				);
			}
		});
	});
}

try {
	const extensionPath = join(scratch, "fake-provider.ts");
	await writeFile(extensionPath, extensionSource);
	const cwd = join(scratch, "cwd");
	await mkdir(cwd);
	const common = {
		cwd,
		backend: "inline",
		task: "Reply with OK.",
		timeoutMs: 60_000,
	};
	const plainAgentDir = await agentDir("agent-plain", {}, false);
	const defaultAgentDir = await agentDir(
		"agent-default",
		{ defaultProvider: "fakeprov", defaultModel: "m1" },
		true,
	);

	const cases = [
		[
			"explicit model",
			{ ...common, model: "fakeprov/m1", extensions: [extensionPath] },
			plainAgentDir,
		],
		["settings default model", common, defaultAgentDir],
		[
			"virtual model",
			{ ...common, model: "fakevirt/router", extensions: [extensionPath] },
			plainAgentDir,
		],
	];
	const results = {};
	for (const [label, options, piAgentDir] of cases) {
		const before = requests.length;
		const result = await runCase(options, piAgentDir);
		if (label === "virtual model" && !result.virtualModels) {
			results[label] = "skipped: host Pi has no registerVirtualModel";
			continue;
		}
		assert.equal(result.status, "completed", `${label}: ${result.stderr}`);
		assert.equal(result.provider, "fakeprov", label);
		assert.equal(result.model, "m1", label);
		assert.match(result.output, /OK/u, label);
		assert.ok(
			requests.slice(before).some((request) => request.model === "m1"),
			`${label}: the fake provider was not called`,
		);
		results[label] = "completed";
	}

	console.log(
		JSON.stringify(
			{ name: "check-inline-extension-providers", status: "completed", results },
			null,
			2,
		),
	);
} finally {
	server.close();
	await rm(scratch, { recursive: true, force: true });
}
