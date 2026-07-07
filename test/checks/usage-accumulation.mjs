#!/usr/bin/env node
import assert from "node:assert/strict";
import { parsePiJsonLines } from "../../src/runners/headless-model.ts";

function assistantEvent(type, usage, text = "chunk") {
	return JSON.stringify({
		type,
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			provider: "fake",
			model: "fake/model",
			usage,
			stopReason: "end",
		},
	});
}

// Multi-turn run: usage must be summed across assistant message_end events,
// not overwritten by the last one.
{
	const parsed = parsePiJsonLines(
		[
			assistantEvent("message_end", {
				input: 1000,
				output: 50,
				cacheRead: 0,
				cacheWrite: 900,
				cost: { input: 0.01, output: 0.002, cacheRead: 0, cacheWrite: 0.005, total: 0.017 },
			}),
			assistantEvent("message_end", {
				input: 2,
				output: 300,
				cacheRead: 950,
				cacheWrite: 40,
				cost: { input: 0.0001, output: 0.012, cacheRead: 0.001, cacheWrite: 0.0002, total: 0.0133 },
			}, "final answer"),
		].join("\n"),
	);
	assert.deepEqual(parsed.metadata.usage, {
		input: 1002,
		output: 350,
		cacheRead: 950,
		cacheWrite: 940,
		cost: {
			input: 0.0101,
			output: 0.014,
			cacheRead: 0.001,
			cacheWrite: 0.0052,
			total: 0.0303,
		},
	});
	assert.equal(parsed.finalAssistantText, "final answer");
}

// Pi emits both message_end and turn_end for the same assistant message.
// turn_end must not double-count when message_end usage was seen.
{
	const usage = { input: 10, output: 20, cost: { total: 0.5 } };
	const parsed = parsePiJsonLines(
		[
			assistantEvent("message_end", usage),
			assistantEvent("turn_end", usage),
			assistantEvent("message_end", usage),
			assistantEvent("turn_end", usage),
		].join("\n"),
	);
	assert.deepEqual(parsed.metadata.usage, {
		input: 20,
		output: 40,
		cost: { total: 1 },
	});
	assert.equal(parsed.usageAccumulation.messageEnd.count, 2);
	assert.equal(parsed.usageAccumulation.turnEnd.count, 2);
}

// turn_end usage is the fallback when the stream never surfaced message_end.
{
	const parsed = parsePiJsonLines(
		[
			assistantEvent("turn_end", { input: 5, output: 7 }),
			assistantEvent("turn_end", { input: 3, output: 4 }),
		].join("\n"),
	);
	assert.deepEqual(parsed.metadata.usage, { input: 8, output: 11 });
}

// Messages with partial usage fields still sum what they report.
{
	const parsed = parsePiJsonLines(
		[
			assistantEvent("message_end", { input: 5, output: 7, reasoning: 11 }),
			assistantEvent("message_end", { input: 3, output: 4 }),
		].join("\n"),
	);
	assert.deepEqual(parsed.metadata.usage, { input: 8, output: 11, reasoning: 11 });
}

// No usage anywhere leaves metadata.usage absent.
{
	const parsed = parsePiJsonLines(
		JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "no usage" }],
				stopReason: "end",
			},
		}),
	);
	assert.equal("usage" in parsed.metadata, false);
}

// Non-finite and non-numeric values never corrupt the totals.
{
	const parsed = parsePiJsonLines(
		[
			assistantEvent("message_end", { input: 5, output: Infinity, note: "a" }),
			assistantEvent("message_end", { input: 3, output: 4, note: "b" }),
		].join("\n"),
	);
	assert.deepEqual(parsed.metadata.usage, { input: 8, output: 4, note: "b" });
}

console.log("usage-accumulation checks passed");
