#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflow = await readFile(".github/workflows/publish.yml", "utf8");
for (const required of [
	"darwin-helper-build:",
	"runs-on: macos-15",
	"darwin-helper-intel:",
	"runs-on: macos-15-intel",
	"name: darwin-process-identity",
	"node scripts/build-darwin-process-identity.mjs",
	"node test/checks/darwin-process-identity-helper.mjs",
	"git add \\",
	'git commit -m "chore(release): $target"',
	'git tag "v$target"',
	"Verify remote release identity",
	"Verify release source is current main",
	'RELEASE_VERSION: ${{ inputs.version }}',
	'node scripts/validate-release-version.mjs "$RELEASE_VERSION"',
	"git push --atomic origin",
	"npm publish --access public",
])
	assert.ok(workflow.includes(required), `publish workflow missing ${required}`);

const npmJob = workflow.indexOf("  npm:");
const artifactInstall = workflow.indexOf(
	"      - name: Install verified Darwin helper artifact",
	npmJob,
);
const releasePrepare = workflow.indexOf(
	"      - name: Prepare release version",
	npmJob,
);
const publish = workflow.indexOf("      - name: Publish to npm", npmJob);
const sourceGuard = workflow.indexOf(
	"      - name: Verify release source is current main",
	npmJob,
);
const versionValidation = workflow.indexOf(
	"      - name: Validate release version",
	npmJob,
);
const push = workflow.indexOf(
	"      - name: Push release commit and tag",
	npmJob,
);
const verifyRemote = workflow.indexOf(
	"      - name: Verify remote release identity",
	npmJob,
);
const releaseCheck = workflow.indexOf("      - name: Release check", npmJob);
assert.ok(npmJob >= 0);
assert.ok(sourceGuard > npmJob);
assert.ok(versionValidation > sourceGuard);
assert.ok(versionValidation < artifactInstall);
assert.ok(sourceGuard < artifactInstall);
assert.ok(artifactInstall > npmJob);
assert.ok(releasePrepare > artifactInstall);
assert.ok(releaseCheck > releasePrepare);
assert.ok(push > releaseCheck);
assert.ok(push > releasePrepare);
assert.ok(verifyRemote > push);
assert.ok(publish > verifyRemote);
assert.ok(publish > releasePrepare);
assert.match(
	workflow.slice(npmJob, releasePrepare),
	/needs:\s*\n\s*- darwin-helper-build\s*\n\s*- darwin-helper-intel/u,
);
assert.match(
	workflow.slice(releasePrepare, publish),
	/git add[\s\S]*darwin-process-identity[\s\S]*git commit[\s\S]*git tag/u,
);
assert.match(
	workflow.slice(sourceGuard, artifactInstall),
	/test "\$GITHUB_REF" = "refs\/heads\/main"[\s\S]*git fetch origin main[\s\S]*git rev-parse origin\/main/u,
);
assert.equal(
	workflow.match(/\$\{\{\s*inputs\.version\s*\}\}/gu)?.length,
	1,
);
assert.match(
	workflow,
	/env:\s*\n\s+RELEASE_VERSION: \$\{\{\s*inputs\.version\s*\}\}/u,
);
const workflowLines = workflow.split("\n");
for (let index = 0; index < workflowLines.length; index += 1) {
	const runMatch = /^(\s+)run:\s*\|?\s*$/u.exec(workflowLines[index]);
	if (runMatch === null) continue;
	const runIndent = runMatch[1].length;
	const body = [];
	for (index += 1; index < workflowLines.length; index += 1) {
		const line = workflowLines[index];
		if (line.trim().length === 0) {
			body.push(line);
			continue;
		}
		const indentation = /^\s*/u.exec(line)[0].length;
		if (indentation <= runIndent) {
			index -= 1;
			break;
		}
		body.push(line);
	}
	assert.doesNotMatch(body.join("\n"), /\$\{\{\s*inputs\.version\s*\}\}/u);
}
assert.match(
	workflow.slice(push, verifyRemote),
	/git push --atomic origin[\s\S]*HEAD:main[\s\S]*refs\/tags\/v/u,
);
assert.match(
	workflow,
	/^permissions:\s*\n\s+contents: read$/mu,
);
assert.doesNotMatch(workflow.slice(0, npmJob), /id-token:\s*write/u);
assert.doesNotMatch(workflow.slice(0, npmJob), /contents:\s*write/u);
assert.match(
	workflow.slice(npmJob, artifactInstall),
	/permissions:\s*\n\s+contents: write\s*\n\s+id-token: write/u,
);

console.log(
	JSON.stringify(
		{ name: "check-release-workflow", status: "completed" },
		null,
		2,
	),
);
