#!/usr/bin/env node
import assert from "node:assert/strict";
import { validateResolveInput } from "../../src/core/validation.ts";

const modeRejected = validateResolveInput({ mode: "chain" });
assert.equal(modeRejected.ok, false);
assert.match(modeRejected.failure.error, /unsupported mode/);

const fieldRejected = validateResolveInput({ chain: [{ task: "do not run" }] });
assert.equal(fieldRejected.ok, false);
assert.match(fieldRejected.failure.error, /chain mode is not supported/);

console.log(JSON.stringify({ name: "check-no-chain", status: "completed" }, null, 2));
