#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin")
	throw new Error("Darwin process identity helper must be built on macOS");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "src/native/darwin-process-identity.c");
const binary = resolve(root, "src/native/darwin-process-identity");
const manifest = resolve(root, "src/native/darwin-process-identity.manifest.json");
const compiler = "/usr/bin/clang";

execFileSync(compiler, [
	"-Os",
	"-Wall",
	"-Wextra",
	"-Werror",
	"-arch",
	"arm64",
	"-arch",
	"x86_64",
	"-mmacosx-version-min=11.0",
	"-Wl,-dead_strip",
	source,
	"-o",
	binary,
]);
await chmod(binary, 0o755);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const compilerVersion = execFileSync(compiler, ["--version"], {
	encoding: "utf8",
})
	.split(/\r?\n/u)[0]
	.trim();
const sdkVersion = execFileSync(
	"/usr/bin/xcrun",
	["--sdk", "macosx", "--show-sdk-version"],
	{ encoding: "utf8" },
).trim();
const record = {
	schema: "pi-subagent-darwin-process-identity-helper-v1",
	sourceSha256: sha256(await readFile(source)),
	binarySha256: sha256(await readFile(binary)),
	architectures: ["arm64", "x86_64"],
	minimumMacOS: "11.0",
	compilerVersion,
	sdkVersion,
};
await writeFile(manifest, `${JSON.stringify(record, null, 2)}\n`, "utf8");
console.log(JSON.stringify(record, null, 2));
