#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

function run(command, args, options = {}) {
	console.log(`\n$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(command, args, {
		stdio: "inherit",
		shell: false,
		...options,
	});
	if (result.status !== 0) process.exit(result.status ?? 1);
}

function capture(command, args) {
	return spawnSync(command, args, { encoding: "utf8", shell: false });
}

const pkg = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
if (pkg.private === true) {
	console.error("package.json has private:true; refusing release check.");
	process.exit(1);
}
if (!pkg.keywords?.includes("pi-package")) {
	console.error(
		'package.json keywords must include "pi-package" for pi.dev package gallery discovery.',
	);
	process.exit(1);
}
if (!pkg.pi?.extensions?.length) {
	console.error("package.json must declare pi.extensions.");
	process.exit(1);
}

if (process.env.GITHUB_ACTIONS === "true") {
	console.log(
		"Skipping npm whoami in GitHub Actions; publish authentication is handled by trusted publishing/OIDC.",
	);
} else {
	const npmWhoami = capture("npm", ["whoami"]);
	if (npmWhoami.status !== 0) {
		console.error("npm whoami failed. Run npm login first.");
		process.exit(npmWhoami.status ?? 1);
	}
	console.log(`npm user: ${npmWhoami.stdout.trim()}`);
}

const versionView = capture("npm", [
	"view",
	`${pkg.name}@${pkg.version}`,
	"version",
]);
if (versionView.status === 0 && versionView.stdout.trim() === pkg.version) {
	console.error(
		`${pkg.name}@${pkg.version} already exists on npm. Bump version before publishing.`,
	);
	process.exit(1);
}
if (versionView.status !== 0) {
	const versionViewOutput = `${versionView.stdout ?? ""}\n${versionView.stderr ?? ""}`;
	if (
		!/\bE404\b|404\s+Not\s+Found|is not in this registry/i.test(
			versionViewOutput,
		)
	) {
		console.error(
			`Could not verify whether ${pkg.name}@${pkg.version} already exists on npm.`,
		);
		process.exit(versionView.status ?? 1);
	}
	console.log(`${pkg.name}@${pkg.version} is not present on npm yet.`);
}

if (existsSync(new URL("../test", import.meta.url))) {
	run("npm", ["run", "check:scripts"]);
	run("npm", ["run", "check:static"]);
} else {
	console.log(
		"\nSkipping validation checks: test/ is not present in this checkout.",
	);
}

console.log("\n$ npm pack --dry-run --json");
const pack = execFileSync("npm", ["pack", "--dry-run", "--json"], {
	encoding: "utf8",
});
const [summary] = JSON.parse(pack);
const files = summary.files.map((file) => file.path);
const required = [
	"LICENSE",
	"README.md",
	"docs/usage.md",
	"assets/subagent-panel.png",
	"api.mjs",
	"src/api.ts",
	"src/index.ts",
	"src/native/darwin-process-identity",
	"src/native/darwin-process-identity.c",
	"src/native/darwin-process-identity.manifest.json",
	"src/process-identity.ts",
	"src/shell-environment.ts",
	"src/workers/durable-worker.mjs",
	"src/workers/process-gate.mjs",
	"src/workers/terminal-finalizer.mjs",
	"package.json",
];
const missing = required.filter((path) => !files.includes(path));
if (missing.length > 0) {
	console.error(`Package is missing required files: ${missing.join(", ")}`);
	process.exit(1);
}
const darwinHelper = summary.files.find(
	(file) => file.path === "src/native/darwin-process-identity",
);
if (darwinHelper === undefined || (darwinHelper.mode & 0o111) === 0) {
	console.error(
		"Package Darwin process identity helper is missing executable mode.",
	);
	process.exit(1);
}
const allowedPublicPaths = new Set([
	"LICENSE",
	"README.md",
	"api.mjs",
	"package.json",
]);
const allowedPublicRoots = ["assets/", "docs/", "src/"];
const unexpected = files.filter(
	(path) =>
		!allowedPublicPaths.has(path) &&
		!allowedPublicRoots.some((root) => path.startsWith(root)),
);
if (unexpected.length > 0) {
	console.error(
		`Package includes files outside the public allowlist: ${unexpected.join(", ")}`,
	);
	process.exit(1);
}
console.log(
	JSON.stringify(
		{
			name: summary.name,
			version: summary.version,
			filename: summary.filename,
			entryCount: summary.entryCount,
			packageSize: summary.size,
			unpackedSize: summary.unpackedSize,
		},
		null,
		2,
	),
);

run("npm", ["publish", "--dry-run"]);
console.log("\nRelease check passed. To publish manually, run: npm publish");
