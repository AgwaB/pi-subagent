#!/usr/bin/env node
import assert from "node:assert/strict";
import { validateReleaseVersion } from "../../scripts/validate-release-version.mjs";

for (const valid of [
	"0.5.1",
	"1.0.0",
	"10.20.30",
	"1.2.3-alpha",
	"1.2.3-alpha.1",
	"1.2.3-0",
])
	assert.equal(validateReleaseVersion(valid), valid);

for (const invalid of [
	"",
	"v1.2.3",
	"1.2",
	"01.2.3",
	"1.02.3",
	"1.2.03",
	"1.2.3+build",
	"1.2.3-",
	"1.2.3-01",
	"1.2.3-alpha..1",
	'0.5.1"; touch /tmp/RELEASE_INPUT_CODE_EXECUTED; echo "',
	"$(touch /tmp/RELEASE_INPUT_CODE_EXECUTED)",
	"`touch /tmp/RELEASE_INPUT_CODE_EXECUTED`",
	"1.2.3\nmalicious",
])
	assert.throws(() => validateReleaseVersion(invalid));

console.log(
	JSON.stringify(
		{ name: "check-release-version", status: "completed" },
		null,
		2,
	),
);
