#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function validateReleaseVersion(value) {
	if (typeof value !== "string" || value.length === 0)
		throw new Error("release version is required");
	if (value.includes("+"))
		throw new Error("release version build metadata is not supported");
	const [core, ...prereleaseParts] = value.split("-");
	if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(core))
		throw new Error(`release version is not strict semver: ${value}`);
	if (prereleaseParts.length === 0) return value;
	const prerelease = prereleaseParts.join("-");
	const identifiers = prerelease.split(".");
	if (
		identifiers.some(
			(identifier) =>
				identifier.length === 0 ||
				!/^[0-9A-Za-z-]+$/u.test(identifier) ||
				(/^\d+$/u.test(identifier) &&
					identifier.length > 1 &&
					identifier.startsWith("0")),
		)
	)
		throw new Error(`release version has invalid prerelease: ${value}`);
	return value;
}

if (
	process.argv[1] !== undefined &&
	fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
	try {
		console.log(validateReleaseVersion(process.argv[2]));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
