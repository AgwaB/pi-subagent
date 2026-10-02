#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function readJson(relativePath) {
	try {
		return JSON.parse(
			readFileSync(new URL(relativePath, import.meta.url), "utf8"),
		);
	} catch (cause) {
		throw new Error(`Cannot read package metadata: ${relativePath}`, { cause });
	}
}

const pkg = readJson("../../package.json");
const lock = readJson("../../package-lock.json");
const hostPackages = [
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"typebox",
];

for (const name of [...hostPackages, "@earendil-works/pi-agent-core"]) {
	assert.equal(
		Object.hasOwn(pkg.dependencies ?? {}, name),
		false,
		`${name} must not be a runtime dependency`,
	);
	for (const key of ["bundleDependencies", "bundledDependencies"]) {
		assert.equal(
			Array.isArray(pkg[key]) && pkg[key].includes(name),
			false,
			`${name} must not be bundled`,
		);
	}
}
for (const name of hostPackages) {
	assert.equal(pkg.peerDependencies?.[name], "*", `${name} must be a wildcard peer`);
	assert.equal(
		typeof pkg.devDependencies?.[name],
		"string",
		`${name} must remain available for development`,
	);
}

const root = lock.packages[""];
assert.equal(lock.version, pkg.version);
assert.equal(root.version, pkg.version);
for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
	assert.deepEqual(root[key] ?? {}, pkg[key] ?? {}, `${key} lockfile drift`);
}

console.log(
	JSON.stringify(
		{ name: "check-host-peer-dependencies", status: "completed" },
		null,
		2,
	),
);
