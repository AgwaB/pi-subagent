#!/usr/bin/env node
// Below-editor activity widget: summary line, ↓ drawer navigation from an
// empty editor, Enter opening the run in the panel detail pane, and the
// run.json agent name the widget labels runs with.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	moduleCache: false,
});
const widgetModule = await jiti.import(resolve("src/activity-widget.ts"));
const panelModule = await jiti.import(resolve("src/panel.ts"));
const artifacts = await jiti.import(resolve("src/artifacts/index.ts"));
const runRef = await jiti.import(resolve("src/orchestrate/run-ref.ts"));
const extension = await jiti.import(resolve("src/index.ts"));

const DOWN = "\u001b[B";
const UP = "\u001b[A";
const ENTER = "\r";
const ESC = "\u001b";

function stripAnsi(text) {
	return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

const plainTheme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
};

function makeRun(overrides) {
	return {
		key: overrides.runId,
		agent: null,
		status: "running",
		failed: false,
		backend: "headless",
		model: "",
		startedAt: new Date(NOW - 65_000).toISOString(),
		completedAt: null,
		updatedMs: NOW - 1_000,
		attempts: 1,
		failureKind: null,
		...overrides,
	};
}

const NOW = Date.parse("2026-01-01T00:10:00.000Z");

async function widgetUnitChecks() {
	let runs = [
		makeRun({ runId: "run_active", agent: "reviewer", model: "opus" }),
		makeRun({
			runId: "run_done",
			agent: "scout",
			status: "completed",
			completedAt: new Date(NOW - 5_000).toISOString(),
			updatedMs: NOW - 5_000,
		}),
		makeRun({
			runId: "run_old",
			status: "completed",
			completedAt: new Date(NOW - 600_000).toISOString(),
			updatedMs: NOW - 600_000,
		}),
	];
	const widgetCalls = [];
	let inputHandler;
	let factory;
	const host = {
		ui: {
			setWidget(key, content, options) {
				widgetCalls.push({ key, content, options });
				factory = content;
			},
			onTerminalInput(handler) {
				inputHandler = handler;
				return () => {
					inputHandler = undefined;
				};
			},
		},
	};
	const opened = [];
	const widget = new widgetModule.ActivityWidget(host, {
		load: async () => runs,
		openRun: async (run) => {
			opened.push(run.runId);
		},
		now: () => NOW,
		timers: false,
	});
	assert.equal(typeof inputHandler, "function", "widget listens to terminal input");

	await widget.refresh();
	assert.equal(widgetCalls.at(-1).key, widgetModule.ACTIVITY_WIDGET_KEY);
	assert.equal(widgetCalls.at(-1).options.placement, "belowEditor");
	const editor = { text: "", getText() { return this.text; }, isShowingAutocomplete: () => false };
	let overlay = false;
	const tui = {
		requestRender() {},
		getFocusedComponent: () => editor,
		hasOverlay: () => overlay,
	};
	const component = factory(tui, plainTheme);
	const view = (width = 100) => stripAnsi(component.render(width).join("\n"));

	const collapsed = view();
	assert.equal(component.render(100).length, 1, "collapsed widget is one line");
	assert.match(collapsed, /1 subagent running/);
	assert.match(collapsed, /1 done/);
	assert.match(collapsed, /↓ to view/);

	editor.text = "draft";
	assert.equal(inputHandler(DOWN), undefined, "↓ with editor text stays in the editor");
	assert.equal(widget.isExpanded(), false);
	editor.text = "";
	overlay = true;
	assert.equal(inputHandler(DOWN), undefined, "↓ under an overlay is not taken");
	overlay = false;
	assert.equal(inputHandler("\u001b[1;1:3B"), undefined, "key release is ignored");
	assert.equal(widget.isExpanded(), false);

	assert.deepEqual(inputHandler(DOWN), { consume: true }, "↓ from empty editor opens the drawer");
	assert.equal(widget.isExpanded(), true);
	let drawer = view();
	assert.match(drawer, /Subagents/);
	assert.match(drawer, /▸ \S+ reviewer/);
	assert.match(drawer, /run_active/);
	assert.match(drawer, /backend  headless · opus/);
	assert.doesNotMatch(drawer, /run_old/, "long-finished runs are not shown");
	for (const line of component.render(100))
		assert.ok(stripAnsi(line).length <= 100, "drawer fits the width");
	for (const line of component.render(40))
		assert.ok(stripAnsi(line).length <= 40, "narrow drawer fits the width");

	assert.deepEqual(inputHandler(DOWN), { consume: true });
	drawer = view();
	assert.match(drawer, /▸ \S+ scout/);
	assert.match(drawer, /run_done/);
	assert.deepEqual(inputHandler(DOWN), { consume: true }, "↓ at the bottom stays put");
	assert.match(view(), /▸ \S+ scout/);

	assert.deepEqual(inputHandler(ENTER), { consume: true });
	assert.equal(widget.isExpanded(), false, "Enter folds the drawer");
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(opened, ["run_done"], "Enter opens the selected run");

	inputHandler(DOWN);
	assert.deepEqual(inputHandler(UP), { consume: true }, "↑ at the top returns to the editor");
	assert.equal(widget.isExpanded(), false);

	inputHandler(DOWN);
	assert.deepEqual(inputHandler(ESC), { consume: true });
	assert.equal(widget.isExpanded(), false, "Esc returns to the editor");

	inputHandler(DOWN);
	assert.equal(inputHandler("a"), undefined, "typing goes to the editor");
	assert.equal(widget.isExpanded(), false);

	inputHandler(DOWN);
	const dialog = {};
	tui.getFocusedComponent = () => dialog;
	assert.equal(inputHandler(DOWN), undefined, "keys pass through once focus leaves the editor");
	assert.equal(widget.isExpanded(), false);
	tui.getFocusedComponent = () => editor;

	runs = [];
	await widget.refresh();
	assert.equal(widgetCalls.at(-1).content, undefined, "no runs clears the widget");
	assert.equal(inputHandler(DOWN), undefined, "↓ is untouched without a widget");

	widget.dispose();
	assert.equal(inputHandler, undefined, "dispose unsubscribes input");
}

async function manyRunsAndKeyVariantChecks() {
	const runs = [];
	for (let index = 0; index < 9; index += 1)
		runs.push(
			makeRun({
				runId: `run_many_${index}`,
				agent: `worker-${index}`,
				// Same start second: order must still be stable.
				startedAt: new Date(NOW - 10_000).toISOString(),
			}),
		);
	runs.push(
		makeRun({
			runId: "run_cancelled",
			status: "cancelled",
			failed: true,
			failureKind: "user_cancelled",
			completedAt: new Date(NOW - 2_000).toISOString(),
			updatedMs: NOW - 2_000,
		}),
		makeRun({
			runId: "run_failed",
			status: "failed",
			failed: true,
			completedAt: new Date(NOW - 3_000).toISOString(),
			updatedMs: NOW - 3_000,
		}),
	);
	let factory;
	let inputHandler;
	const widget = new widgetModule.ActivityWidget(
		{
			ui: {
				setWidget(_key, content) {
					factory = content;
				},
				onTerminalInput(handler) {
					inputHandler = handler;
					return () => {};
				},
			},
		},
		{
			load: async () => [...runs].reverse(),
			openRun: async () => {},
			now: () => NOW,
			timers: false,
		},
	);
	await widget.refresh();
	const editor = { getText: () => "", isShowingAutocomplete: () => false };
	const component = factory(
		{ requestRender() {}, getFocusedComponent: () => editor, hasOverlay: () => false },
		plainTheme,
	);
	const view = () => stripAnsi(component.render(110).join("\n"));
	assert.match(view(), /9 subagents running · 1 failed · 1 cancelled/, "cancelled is counted apart from failed");

	// Kitty keyboard protocol forms of ↓ / Enter / Esc.
	assert.deepEqual(inputHandler("\u001b[1;1B"), { consume: true }, "kitty ↓ opens the drawer");
	let drawer = view();
	assert.match(drawer, /▸ \S+ worker-0/, "same-start runs keep a stable order");
	assert.match(drawer, /1-6 of 11 · ↑↓ to scroll/);
	for (let index = 0; index < 10; index += 1) inputHandler("\u001b[B");
	drawer = view();
	assert.match(drawer, /6-11 of 11 · ↑↓ to scroll/, "list window follows the selection");
	assert.match(drawer, /▸ ■ run_cancelled|▸ ✗ run_failed/);
	assert.match(drawer, /run_failed/);
	assert.deepEqual(inputHandler("\u001b[27u"), { consume: true }, "kitty Esc folds the drawer");
	assert.equal(widget.isExpanded(), false);
	inputHandler("\u001b[B");
	assert.deepEqual(inputHandler("\u001b[13u"), { consume: true }, "kitty Enter opens the run");
	assert.equal(widget.isExpanded(), false);
	widget.dispose();
}

async function registryAndPanelChecks() {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-subagent-activity-"));
	const oldIndexDir = process.env.PI_SUBAGENT_RUN_INDEX_DIR;
	try {
		const cwd = join(tempRoot, "workspace");
		await mkdir(cwd, { recursive: true });
		process.env.PI_SUBAGENT_RUN_INDEX_DIR = join(tempRoot, "index");
		const sessionId = "session_widget";
		const writeSessionRun = async (runId, agent, parentSessionId = sessionId) => {
			await artifacts.beginRunRecord({
				cwd,
				runId,
				mode: "single",
				backend: "headless",
				parentSessionId,
				...(agent === undefined ? {} : { agent }),
				activeAttemptId: "attempt-1",
				attempts: [
					{
						attemptId: "attempt-1",
						status: "running",
						backend: "headless",
						startedAt: new Date().toISOString(),
					},
				],
			});
			await runRef.writeRunLocator({ cwd, runId, parentSessionId });
		};
		const firstId = artifacts.createRunId(new Date(Date.now() - 2_000));
		const secondId = artifacts.createRunId(new Date(Date.now() - 1_000));
		await writeSessionRun(firstId, "reviewer");
		await writeSessionRun(secondId, "scout");
		await writeSessionRun(artifacts.createRunId(), undefined, "someone_else");
		await writeSessionRun(
			artifacts.createRunId(new Date(Date.now() - 3 * 86_400_000)),
			"ancient",
		);

		// A resumed session finds its recent runs in the index.
		const seeded = panelModule.createSessionActivityLoader(sessionId);
		await seeded.seed(Date.now() - 86_400_000);
		const loaded = await seeded.load();
		assert.deepEqual(
			loaded.map((run) => [run.runId, run.agent]).sort(),
			[
				[firstId, "reviewer"],
				[secondId, "scout"],
			].sort(),
			"seed finds this session's recent runs with their agent names",
		);

		// New runs are followed from the locator write, not an index scan.
		const live = panelModule.createSessionActivityLoader(sessionId);
		assert.deepEqual(await live.load(), [], "nothing tracked yet");
		const unsubscribe = runRef.onRunLocatorWritten((locator) => live.track(locator));
		await writeSessionRun("run_custom_id", "tracked");
		await writeSessionRun("run_foreign", "foreign", "someone_else");
		unsubscribe();
		assert.deepEqual(
			(await live.load()).map((run) => [run.runId, run.agent]),
			[["run_custom_id", "tracked"]],
			"locator writes for this session are tracked",
		);

		const second = loaded.find((run) => run.runId === secondId);
		let component;
		await panelModule.showSubagentPanel(
			{
				cwd,
				mode: "tui",
				hasUI: true,
				sessionManager: { getSessionId: () => sessionId },
				ui: {
					notify() {},
					async custom(factory) {
						component = await factory({ requestRender() {} }, plainTheme, {}, () => {});
					},
				},
			},
			{ runKey: second.key },
		);
		const deadline = Date.now() + 2_000;
		let text = "";
		while (Date.now() < deadline) {
			text = stripAnsi(component.render(140).join("\n"));
			if (text.includes(`▸ ${secondId}`)) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		component.dispose();
		assert.ok(text.includes(`▸ ${secondId}`), "panel opens with the chosen run selected");
		assert.match(text, new RegExp(`Run ID\\s+${secondId}`), "panel shows the chosen run's detail");
	} finally {
		if (oldIndexDir === undefined) delete process.env.PI_SUBAGENT_RUN_INDEX_DIR;
		else process.env.PI_SUBAGENT_RUN_INDEX_DIR = oldIndexDir;
		await rm(tempRoot, { recursive: true, force: true });
	}
}

async function toggleChecks() {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-subagent-toggle-"));
	const oldPrefs = process.env.PI_SUBAGENT_PREFERENCES_PATH;
	const prefsPath = join(tempRoot, "prefs", "pi-subagent.json");
	process.env.PI_SUBAGENT_PREFERENCES_PATH = prefsPath;
	try {
		const cwd = join(tempRoot, "workspace");
		await mkdir(cwd, { recursive: true });
		const sessionId = "session_toggle";
		const runId = artifacts.createRunId();
		await artifacts.beginRunRecord({
			cwd,
			runId,
			mode: "single",
			backend: "headless",
			parentSessionId: sessionId,
			agent: "toggled",
			activeAttemptId: "attempt-1",
			attempts: [
				{
					attemptId: "attempt-1",
					status: "running",
					backend: "headless",
					startedAt: new Date().toISOString(),
				},
			],
		});
		await runRef.writeRunLocator({ cwd, runId, parentSessionId: sessionId });

		const boot = () => {
			const events = new Map();
			let command;
			const register = extension.default ?? extension;
			register({
				registerTool() {},
				registerCommand(_name, definition) {
					command = definition;
				},
				on(name, handler) {
					events.set(name, handler);
				},
			});
			const widgetCalls = [];
			const notes = [];
			let listening = 0;
			const ctx = {
				cwd,
				mode: "tui",
				hasUI: true,
				sessionManager: { getSessionId: () => sessionId },
				ui: {
					setWidget(key, content) {
						widgetCalls.push(content === undefined ? "clear" : "set");
					},
					onTerminalInput() {
						listening += 1;
						return () => {
							listening -= 1;
						};
					},
					notify(message, level) {
						notes.push({ message, level });
					},
				},
			};
			events.get("session_start")({}, ctx);
			return { command, ctx, widgetCalls, notes, listening: () => listening, events };
		};
		const waitFor = async (predicate, label) => {
			const deadline = Date.now() + 3_000;
			while (Date.now() < deadline) {
				if (predicate()) return;
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			throw new Error(`Timed out waiting for ${label}`);
		};

		const first = boot();
		await waitFor(() => first.widgetCalls.includes("set"), "widget shown by default");
		assert.equal(first.listening(), 1);
		assert.ok(
			first.command.getArgumentCompletions("wi")?.some((item) => item.value === "widget"),
			"widget subcommand completes",
		);

		await first.command.handler("widget off", first.ctx);
		assert.equal(first.widgetCalls.at(-1), "clear", "off clears the widget now");
		assert.equal(first.listening(), 0, "off stops listening to keys");
		assert.deepEqual(JSON.parse(await readFile(prefsPath, "utf8")), { widget: false });
		assert.match(first.notes.at(-1).message, /widget off/);

		await first.command.handler("widget on", first.ctx);
		await waitFor(() => first.widgetCalls.at(-1) === "set", "on shows the widget again");
		assert.equal(first.listening(), 1);

		await first.command.handler("widget", first.ctx);
		assert.equal(first.widgetCalls.at(-1), "clear", "bare widget toggles");
		await first.command.handler("widget maybe", first.ctx);
		assert.match(first.notes.at(-1).message, /Usage: \/subagent widget/);
		first.events.get("session_shutdown")();

		// The choice survives a restart.
		const second = boot();
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.deepEqual(second.widgetCalls, [], "a remembered off shows nothing");
		assert.equal(second.listening(), 0);
		await second.command.handler("widget on", second.ctx);
		await waitFor(() => second.widgetCalls.includes("set"), "on after restart");
		second.events.get("session_shutdown")();
	} finally {
		if (oldPrefs === undefined) delete process.env.PI_SUBAGENT_PREFERENCES_PATH;
		else process.env.PI_SUBAGENT_PREFERENCES_PATH = oldPrefs;
		await rm(tempRoot, { recursive: true, force: true });
	}
}

function registrationChecks() {
	const register = extension.default ?? extension;
	const events = new Map();
	register({
		registerTool() {},
		registerCommand() {},
		on(name, handler) {
			events.set(name, handler);
		},
	});
	for (const name of [
		"session_start",
		"session_shutdown",
		"tool_execution_start",
		"tool_execution_end",
	])
		assert.equal(typeof events.get(name), "function", `${name} handler registered`);
	// Non-interactive sessions never install a widget or input listener.
	let touched = false;
	events.get("session_start")(
		{},
		{
			mode: "json",
			hasUI: false,
			cwd: process.cwd(),
			ui: {
				setWidget() {
					touched = true;
				},
				onTerminalInput() {
					touched = true;
					return () => {};
				},
			},
		},
	);
	assert.equal(touched, false, "no widget outside the TUI");
	events.get("session_shutdown")();
}

await widgetUnitChecks();
await manyRunsAndKeyVariantChecks();
await registryAndPanelChecks();
registrationChecks();
await toggleChecks();
console.log(
	JSON.stringify(
		{
			name: "check-activity-widget",
			status: "passed",
			covered: [
				"collapsed summary line",
				"↓ only from an empty focused editor",
				"drawer ↑↓ / Enter / Esc / type-through",
				"many runs: stable order and scroll window",
				"cancelled counted apart from failed",
				"kitty keyboard ↓ / Enter / Esc",
				"Enter opens the run in the panel detail pane",
				"run.json agent name in the session loader",
				"non-TUI sessions install nothing",
				"/subagent widget on/off/toggle, remembered across restarts",
			],
		},
		null,
		2,
	),
);
