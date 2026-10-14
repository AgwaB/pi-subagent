#!/usr/bin/env node
// Inline runs must load the Pi SDK of the running host even when `pi` on PATH
// is a wrapper script (issue #4), both in the parent process and in the
// detached worker that executes async runs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import {
	chmod,
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { getSubagentLogs, runSubagent, waitForSubagent } from "../../api.mjs";
import {
	hostPiPackageRoot,
	PI_PACKAGE_ROOT_ENV,
} from "../../src/runners/inline.ts";

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const originalArgv1 = process.argv[1];
const originalPath = process.env.PATH;
const originalRoot = process.env[PI_PACKAGE_ROOT_ENV];
const originalIndexDir = process.env.PI_SUBAGENT_RUN_INDEX_DIR;

function restoreEnv(name, value) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

async function fakePiPackage(root, name = PI_PACKAGE_NAME) {
	await mkdir(join(root, "dist"), { recursive: true });
	await writeFile(join(root, "package.json"), JSON.stringify({ name }));
	await writeFile(join(root, "dist", "cli.js"), "");
	return await realpath(root);
}

function piPackageRootOf(file) {
	for (
		let dir = dirname(realpathSync(file));
		dir !== dirname(dir);
		dir = dirname(dir)
	) {
		try {
			if (
				JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name ===
				PI_PACKAGE_NAME
			)
				return dir;
		} catch {
			// Keep walking.
		}
	}
	return undefined;
}

const scratch = await mkdtemp(join(tmpdir(), "pi-subagent-inline-host-sdk-"));

try {
	// Resolution order: the running host entry, then the root a parent host
	// passed to a detached worker; anything else is not a Pi package.
	const hostRoot = await fakePiPackage(join(scratch, "host-pi"));
	const otherRoot = await fakePiPackage(join(scratch, "other-pi"));
	const notPi = await fakePiPackage(join(scratch, "not-pi"), "not-pi");
	await mkdir(join(scratch, "bin"));
	await symlink(join(hostRoot, "dist", "cli.js"), join(scratch, "bin", "pi"));
	const unrelatedEntry = join(scratch, "unrelated.mjs");
	await writeFile(unrelatedEntry, "");

	process.argv[1] = join(scratch, "bin", "pi");
	process.env[PI_PACKAGE_ROOT_ENV] = otherRoot;
	assert.equal(hostPiPackageRoot(), hostRoot, "the running host entry wins");
	process.argv[1] = unrelatedEntry;
	assert.equal(
		hostPiPackageRoot(),
		otherRoot,
		"a worker uses the inherited root",
	);
	process.env[PI_PACKAGE_ROOT_ENV] = notPi;
	assert.equal(hostPiPackageRoot(), undefined, "a non-Pi root is rejected");
	delete process.env[PI_PACKAGE_ROOT_ENV];
	assert.equal(hostPiPackageRoot(), undefined);

	// End to end: a wrapper script shadows the real `pi` on PATH while this
	// process stands in for the Pi host.
	const realPi = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
	assert.ok(
		piPackageRootOf(realPi),
		`could not locate ${PI_PACKAGE_NAME} from ${realPi}`,
	);
	const wrapperDir = join(scratch, "wrapper-bin");
	await mkdir(wrapperDir);
	const wrapper = join(wrapperDir, "pi");
	await writeFile(
		wrapper,
		`#!/bin/sh\nexec "${process.execPath}" "${realPi}" "$@"\n`,
	);
	await chmod(wrapper, 0o755);
	process.env.PATH = `${wrapperDir}${delimiter}${originalPath ?? ""}`;
	assert.equal(
		execFileSync("which", ["pi"], { encoding: "utf8" }).trim(),
		wrapper,
	);
	process.argv[1] = realPi;
	process.env.PI_SUBAGENT_RUN_INDEX_DIR = join(scratch, "run-index");

	const cwd = join(scratch, "cwd");
	await mkdir(cwd);
	const common = {
		cwd,
		backend: "inline",
		task: "Provider-free host SDK resolution check.",
		model: "pi-subagent-missing-provider/pi-subagent-missing-model",
		extensions: [],
	};
	const assertSdkLoaded = async (runId, label) => {
		const stderr = (await getSubagentLogs({ cwd, runId }))?.logText.stderr ?? "";
		assert.doesNotMatch(stderr, /could not locate|could not find pi/u, label);
		assert.match(stderr, /was not found or is not available/u, label);
	};

	const foreground = await runSubagent(common);
	assert.equal(foreground.status, "failed");
	await assertSdkLoaded(foreground.runId, "foreground");

	const background = await runSubagent({ ...common, async: true });
	const waited = await waitForSubagent({
		cwd,
		runId: background.runId,
		timeoutMs: 60_000,
	});
	assert.equal(waited.outcome, "terminal");
	assert.equal(waited.snapshot.status, "failed");
	await assertSdkLoaded(background.runId, "async worker");

	console.log(
		JSON.stringify(
			{ name: "check-inline-host-sdk", status: "completed" },
			null,
			2,
		),
	);
} finally {
	process.argv[1] = originalArgv1;
	restoreEnv("PATH", originalPath);
	restoreEnv(PI_PACKAGE_ROOT_ENV, originalRoot);
	restoreEnv("PI_SUBAGENT_RUN_INDEX_DIR", originalIndexDir);
	await rm(scratch, { recursive: true, force: true });
}
