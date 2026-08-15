#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runSubagent } from "../../api.mjs";

const cwd = await mkdtemp(join(tmpdir(), "pi-subagent-inline-sdk-"));

try {
	const result = await runSubagent({
		cwd,
		backend: "inline",
		task: "Provider-free SDK compatibility check.",
		model: "pi-subagent-missing-provider/pi-subagent-missing-model",
	});
	assert.equal(result.status, "failed");
	const stderrRef = result.artifacts.find(
		(artifact) => artifact.type === "stderr",
	);
	assert.ok(stderrRef, "inline failure should retain stderr evidence");
	const stderr = await readFile(resolve(cwd, stderrRef.path), "utf8");
	assert.match(stderr, /was not found or is not available/u);
	assert.doesNotMatch(stderr, /AuthStorage|ModelRegistry\.create/u);

	console.log(
		JSON.stringify(
			{
				name: "check-inline-sdk-compat",
				status: "completed",
			},
			null,
			2,
		),
	);
} finally {
	await rm(cwd, { recursive: true, force: true });
}
