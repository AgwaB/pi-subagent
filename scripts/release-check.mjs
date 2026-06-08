#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

function run(command, args, options = {}) {
  console.log(`\n$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit", shell: false, ...options });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function capture(command, args) {
  return spawnSync(command, args, { encoding: "utf8", shell: false });
}

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (pkg.private === true) {
  console.error("package.json has private:true; refusing release check.");
  process.exit(1);
}
if (!pkg.keywords?.includes("pi-package")) {
  console.error('package.json keywords must include "pi-package" for pi.dev package gallery discovery.');
  process.exit(1);
}
if (!pkg.pi?.extensions?.length) {
  console.error("package.json must declare pi.extensions.");
  process.exit(1);
}

const npmWhoami = capture("npm", ["whoami"]);
if (npmWhoami.status !== 0) {
  console.error("npm whoami failed. Run npm login first.");
  process.exit(npmWhoami.status ?? 1);
}
console.log(`npm user: ${npmWhoami.stdout.trim()}`);

const versionView = capture("npm", ["view", `${pkg.name}@${pkg.version}`, "version"]);
if (versionView.status === 0 && versionView.stdout.trim() === pkg.version) {
  console.error(`${pkg.name}@${pkg.version} already exists on npm. Bump version before publishing.`);
  process.exit(1);
}

if (existsSync(new URL("../internal/scripts", import.meta.url))) {
  run("npm", ["run", "validate"]);
  run("npm", ["run", "validate:stress"]);
} else {
  console.log("\nSkipping internal validation scripts: internal/scripts is not present in this checkout.");
}

console.log("\n$ npm pack --dry-run --json");
const pack = execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" });
const [summary] = JSON.parse(pack);
const files = summary.files.map((file) => file.path);
const required = ["README.md", "docs/usage.md", "assets/subagent-panel.png", "src/index.ts", "package.json"];
const missing = required.filter((path) => !files.includes(path));
if (missing.length > 0) {
  console.error(`Package is missing required files: ${missing.join(", ")}`);
  process.exit(1);
}
if (files.some((path) => path.startsWith("internal/") || path.startsWith("node_modules/") || path.startsWith(".pi/") || path.startsWith(".harness/"))) {
  console.error("Package includes local/internal files that should not be published.");
  process.exit(1);
}
console.log(JSON.stringify({
  name: summary.name,
  version: summary.version,
  filename: summary.filename,
  entryCount: summary.entryCount,
  packageSize: summary.size,
  unpackedSize: summary.unpackedSize,
}, null, 2));

run("npm", ["publish", "--dry-run"]);
console.log("\nRelease check passed. To publish manually, run: npm publish");
