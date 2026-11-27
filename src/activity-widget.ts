import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { clip, stripAnsi, visibleLength } from "./core/text-width.ts";
import {
	type ActivityRun,
	createSessionActivityLoader,
	currentSessionId,
	formatRunElapsed,
	isActiveStatus,
	isArrowKey,
	isEnterKey,
	isEscapeKey,
	type PanelHostContext,
	panelNowMs,
	type SessionActivityLoader,
	showSubagentPanel,
} from "./panel.ts";
import { onRunLocatorWritten } from "./orchestrate/run-ref.ts";
import { readPreferences, writePreferences } from "./preferences.ts";

export const ACTIVITY_WIDGET_KEY = "subagent-activity";
const POLL_MS = 1_500;
const SPINNER_MS = 120;
/** Finished runs stay in the widget this long after they complete. */
const RECENT_TERMINAL_MS = 30_000;
const MAX_LIST_ROWS = 6;
const MIN_SPLIT_WIDTH = 56;
const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

interface WidgetTheme {
	fg?(color: string, text: string): string;
	bold?(text: string): string;
}

/** The parts of the host TUI the widget needs to find the focused editor. */
interface WidgetTui {
	requestRender?: () => void;
	getFocusedComponent?: () => unknown;
	hasOverlay?: () => boolean;
}

interface EditorLike {
	getText(): string;
	isShowingAutocomplete?(): boolean;
}

type InputResult = { consume: true } | undefined;

export interface ActivityWidgetHost {
	ui: {
		setWidget: PanelHostContext["ui"]["setWidget"];
		onTerminalInput?: (handler: (data: string) => InputResult) => () => void;
	};
}

export interface ActivityWidgetOptions {
	load: () => Promise<ActivityRun[]>;
	openRun: (run: ActivityRun) => Promise<void>;
	now?: () => number;
	/** Tests drive refreshes and rendering by hand. */
	timers?: boolean;
}

function isKeyRelease(data: string): boolean {
	return !data.includes("\u001b[200~") && /:3[u~ABCDHF]/.test(data);
}

function style(theme: WidgetTheme | undefined, color: string, text: string) {
	return theme?.fg?.(color, text) ?? text;
}

function bold(theme: WidgetTheme | undefined, text: string): string {
	return theme?.bold?.(text) ?? text;
}

function pad(text: string, width: number): string {
	const visible = visibleLength(text);
	return visible >= width
		? clip(text, width)
		: text + " ".repeat(width - visible);
}

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function cleanLabel(text: string): string {
	return stripAnsi(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

function runLabel(run: ActivityRun): string {
	return cleanLabel(run.agent ?? run.runId);
}

function runColor(run: ActivityRun): string {
	if (isActiveStatus(run.status) || run.status === "cancelled")
		return "warning";
	return run.failed ? "error" : "success";
}

function runStatusText(run: ActivityRun): string {
	if (isActiveStatus(run.status)) return run.status;
	if (run.failed && run.status === "completed") return "completed (child failures)";
	return run.status;
}

/**
 * Below-editor widget listing the current session's running and just-finished
 * subagent runs. Collapsed it is one summary line; with an empty editor, ↓
 * expands it into a list + detail drawer navigated with ↑↓, where Enter opens
 * the run in the /subagent panel detail pane and Esc returns to the editor.
 */
export class ActivityWidget {
	private runs: ActivityRun[] = [];
	private shown: ActivityRun[] = [];
	private expanded = false;
	private selectedKey: string | undefined;
	private readonly inFlight = new Set<string>();
	private installed = false;
	private tui: WidgetTui | undefined;
	private theme: WidgetTheme | undefined;
	private pollTimer: NodeJS.Timeout | undefined;
	private spinTimer: NodeJS.Timeout | undefined;
	private loading = false;
	private reloadRequested = false;
	private disposed = false;
	private readonly unsubscribeInput: (() => void) | undefined;
	private readonly now: () => number;
	private readonly timers: boolean;

	constructor(
		private readonly host: ActivityWidgetHost,
		private readonly options: ActivityWidgetOptions,
	) {
		this.now = options.now ?? panelNowMs;
		this.timers = options.timers !== false;
		this.unsubscribeInput = host.ui.onTerminalInput?.((data) =>
			this.handleInput(data),
		);
	}

	dispose(): void {
		this.disposed = true;
		this.unsubscribeInput?.();
		this.stopTimers();
		this.uninstall();
	}

	toolStarted(toolCallId: string): void {
		this.inFlight.add(toolCallId);
		void this.refresh();
	}

	toolEnded(toolCallId: string): void {
		this.inFlight.delete(toolCallId);
		void this.refresh();
	}

	isExpanded(): boolean {
		return this.expanded;
	}

	/** Reload the session's runs and update the widget. */
	async refresh(): Promise<void> {
		if (this.disposed) return;
		if (this.loading) {
			this.reloadRequested = true;
			return;
		}
		this.loading = true;
		try {
			do {
				this.reloadRequested = false;
				try {
					this.runs = await this.options.load();
				} catch {
					// Keep the last good list; the next poll retries.
				}
				if (this.disposed) return;
				this.update();
			} while (this.reloadRequested);
		} finally {
			this.loading = false;
		}
		this.schedulePoll();
	}

	handleInput(data: string): InputResult {
		if (this.disposed || !this.installed || this.shown.length === 0)
			return undefined;
		if (isKeyRelease(data)) return undefined;
		const editor = this.focusedEditor();
		if (!this.expanded) {
			if (
				editor !== undefined &&
				isArrowKey(data, "down") &&
				editor.getText().length === 0 &&
				editor.isShowingAutocomplete?.() !== true
			) {
				this.expanded = true;
				this.selectedKey = this.shown[0]?.key;
				this.requestRender();
				return { consume: true };
			}
			return undefined;
		}
		// A dialog or panel took focus: fold away and leave its keys alone.
		if (editor === undefined) {
			this.collapse();
			return undefined;
		}
		const index = Math.max(
			0,
			this.shown.findIndex((run) => run.key === this.selectedKey),
		);
		if (isArrowKey(data, "up")) {
			if (index === 0) this.collapse();
			else this.select(index - 1);
			return { consume: true };
		}
		if (isArrowKey(data, "down")) {
			this.select(Math.min(this.shown.length - 1, index + 1));
			return { consume: true };
		}
		if (isEnterKey(data)) {
			const run = this.shown[index];
			this.collapse();
			if (run !== undefined)
				void this.options
					.openRun(run)
					.catch(() => undefined)
					.finally(() => void this.refresh());
			return { consume: true };
		}
		if (isEscapeKey(data)) {
			this.collapse();
			return { consume: true };
		}
		// Any other key goes back to the editor.
		this.collapse();
		return undefined;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		if (this.shown.length === 0) return [];
		if (!this.expanded) return [clip(this.summaryLine(), safeWidth)];
		return safeWidth >= MIN_SPLIT_WIDTH
			? this.renderDrawer(safeWidth)
			: this.renderNarrow(safeWidth);
	}

	private select(index: number): void {
		this.selectedKey = this.shown[index]?.key ?? this.selectedKey;
		this.requestRender();
	}

	private collapse(): void {
		if (!this.expanded) return;
		this.expanded = false;
		// Runs kept only while browsing may drop out now.
		this.update();
	}

	private focusedEditor(): EditorLike | undefined {
		const tui = this.tui;
		if (tui === undefined || tui.hasOverlay?.() === true) return undefined;
		const focused = tui.getFocusedComponent?.();
		if (
			typeof focused !== "object" ||
			focused === null ||
			typeof (focused as { getText?: unknown }).getText !== "function"
		)
			return undefined;
		return focused as EditorLike;
	}

	private visibleRuns(): ActivityRun[] {
		const now = this.now();
		const previous = new Set(this.shown.map((run) => run.key));
		const active = this.runs
			.filter((run) => isActiveStatus(run.status))
			.sort(
				(a, b) =>
					a.startedAt.localeCompare(b.startedAt) || a.key.localeCompare(b.key),
			);
		const finished = this.runs
			.filter((run) => !isActiveStatus(run.status))
			.filter((run) => {
				// While the drawer is open, keep what the user is looking at.
				if (this.expanded && previous.has(run.key)) return true;
				const ended =
					run.completedAt === null ? Number.NaN : Date.parse(run.completedAt);
				const at = Number.isFinite(ended) ? ended : run.updatedMs;
				return now - at <= RECENT_TERMINAL_MS;
			})
			.sort((a, b) => b.updatedMs - a.updatedMs || a.key.localeCompare(b.key));
		return [...active, ...finished];
	}

	private update(): void {
		this.shown = this.visibleRuns();
		if (this.shown.length === 0) {
			this.expanded = false;
			this.selectedKey = undefined;
			this.uninstall();
			this.stopSpinner();
			return;
		}
		if (
			this.selectedKey === undefined ||
			!this.shown.some((run) => run.key === this.selectedKey)
		)
			this.selectedKey = this.shown[0]?.key;
		this.install();
		if (this.shown.some((run) => isActiveStatus(run.status)))
			this.startSpinner();
		else this.stopSpinner();
		this.requestRender();
	}

	private install(): void {
		if (this.installed) return;
		this.installed = true;
		this.host.ui.setWidget(
			ACTIVITY_WIDGET_KEY,
			(tui, theme) => {
				this.tui = tui;
				this.theme = theme;
				const component: Component & { dispose(): void } = {
					render: (width: number) => this.render(width),
					invalidate: () => undefined,
					dispose: () => undefined,
				};
				return component;
			},
			{ placement: "belowEditor" },
		);
	}

	private uninstall(): void {
		if (!this.installed) return;
		this.installed = false;
		this.tui = undefined;
		try {
			this.host.ui.setWidget(ACTIVITY_WIDGET_KEY, undefined, {
				placement: "belowEditor",
			});
		} catch {
			// The UI may already be gone at shutdown.
		}
	}

	private requestRender(): void {
		this.tui?.requestRender?.();
	}

	private schedulePoll(): void {
		if (!this.timers || this.disposed || this.pollTimer !== undefined) return;
		if (this.inFlight.size === 0 && this.shown.length === 0) return;
		this.pollTimer = setTimeout(() => {
			this.pollTimer = undefined;
			void this.refresh();
		}, POLL_MS);
		this.pollTimer.unref?.();
	}

	private startSpinner(): void {
		if (!this.timers || this.spinTimer !== undefined) return;
		this.spinTimer = setInterval(() => this.requestRender(), SPINNER_MS);
		this.spinTimer.unref?.();
	}

	private stopSpinner(): void {
		if (this.spinTimer !== undefined) clearInterval(this.spinTimer);
		this.spinTimer = undefined;
	}

	private stopTimers(): void {
		if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
		this.pollTimer = undefined;
		this.stopSpinner();
	}

	private icon(run: ActivityRun): string {
		if (isActiveStatus(run.status))
			return style(
				this.theme,
				"accent",
				SPINNER[Math.floor(Date.now() / 100) % SPINNER.length] ?? "•",
			);
		if (run.status === "cancelled") return style(this.theme, "warning", "■");
		return run.failed
			? style(this.theme, "error", "✗")
			: style(this.theme, "success", "✓");
	}

	private summaryLine(): string {
		const active = this.shown.filter((run) => isActiveStatus(run.status));
		const finished = this.shown.filter((run) => !isActiveStatus(run.status));
		const cancelled = finished.filter(
			(run) => run.status === "cancelled",
		).length;
		const failed = finished.filter(
			(run) => run.failed && run.status !== "cancelled",
		).length;
		const done = finished.length - failed - cancelled;
		const head =
			active.length > 0
				? `${this.icon(active[0] as ActivityRun)} ${style(this.theme, "accent", `${plural(active.length, "subagent")} running`)}`
				: `${style(this.theme, "muted", "●")} ${style(this.theme, "muted", `${plural(finished.length, "subagent")} finished`)}`;
		const counts: string[] = [];
		if (done > 0) counts.push(`${done} done`);
		if (failed > 0) counts.push(style(this.theme, "error", `${failed} failed`));
		if (cancelled > 0)
			counts.push(style(this.theme, "warning", `${cancelled} cancelled`));
		const tail = counts.length > 0 ? ` ${style(this.theme, "muted", "·")} ${counts.join(style(this.theme, "muted", " · "))}` : "";
		return ` ${head}${tail}  ${style(this.theme, "dim", "↓")} ${style(this.theme, "muted", "to view")}`;
	}

	private listWindow(): { runs: ActivityRun[]; start: number } {
		const index = Math.max(
			0,
			this.shown.findIndex((run) => run.key === this.selectedKey),
		);
		const start = Math.min(
			Math.max(0, this.shown.length - MAX_LIST_ROWS),
			Math.max(0, index - MAX_LIST_ROWS + 1),
		);
		return { runs: this.shown.slice(start, start + MAX_LIST_ROWS), start };
	}

	private listRow(run: ActivityRun, width: number): string {
		const selected = run.key === this.selectedKey;
		const marker = selected ? style(this.theme, "accent", "▸") : " ";
		const elapsed = formatRunElapsed(run.startedAt, run.completedAt);
		const labelWidth = Math.max(1, width - visibleLength(elapsed) - 6);
		const label = pad(clip(runLabel(run), labelWidth), labelWidth);
		return `${marker} ${this.icon(run)} ${selected ? bold(this.theme, label) : label} ${style(this.theme, "muted", elapsed)}`;
	}

	private detailLines(run: ActivityRun | undefined): string[] {
		if (run === undefined) return [];
		const field = (name: string, value: string, color = "text") =>
			`${style(this.theme, "muted", pad(name, 9))}${style(this.theme, color, value)}`;
		const lines = [
			bold(this.theme, run.runId),
			field("status", runStatusText(run), runColor(run)),
			field("agent", run.agent === null ? "—" : cleanLabel(run.agent)),
			field(
				"backend",
				`${run.backend}${run.model.length > 0 ? ` · ${cleanLabel(run.model)}` : ""}`,
			),
			field(
				"elapsed",
				`${formatRunElapsed(run.startedAt, run.completedAt)}${run.attempts > 1 ? ` · ${run.attempts} attempts` : ""}`,
			),
		];
		if (run.children !== undefined)
			lines.push(
				field(
					"children",
					`${run.children.total} · running ${run.children.running} · failed ${run.children.failed}`,
					run.children.failed > 0 ? "error" : "muted",
				),
			);
		if (run.failureKind !== null)
			lines.push(field("failure", run.failureKind, "error"));
		return lines;
	}

	/**
	 * List + detail without a box: no right edge or column rules, so a
	 * terminal that measures a glyph differently cannot misalign a border.
	 */
	private renderDrawer(width: number): string[] {
		const leftWidth = Math.min(40, Math.max(22, Math.floor(width * 0.4)));
		const gap = "   ";
		const { runs, start } = this.listWindow();
		const left = runs.map((run) => this.listRow(run, leftWidth));
		if (this.shown.length > runs.length)
			left.push(
				style(
					this.theme,
					"muted",
					`  ${start + 1}-${start + runs.length} of ${this.shown.length} · ↑↓ to scroll`,
				),
			);
		const right = this.detailLines(
			this.shown.find((run) => run.key === this.selectedKey),
		);
		const title = " Subagents ";
		const lines = [
			`${style(this.theme, "accent", bold(this.theme, title))}${style(this.theme, "borderMuted", "─".repeat(Math.max(0, width - title.length - 1)))}`,
		];
		const rows = Math.max(left.length, right.length);
		for (let index = 0; index < rows; index += 1)
			lines.push(
				`${pad(left[index] ?? "", leftWidth)}${gap}${right[index] ?? ""}`,
			);
		lines.push(` ${this.helpText()}`);
		return lines.map((line) => clip(line, width));
	}

	private helpText(): string {
		// Same as pi's own key hints: key dim, description muted.
		const key = (text: string) => style(this.theme, "dim", text);
		const label = (text: string) => style(this.theme, "muted", text);
		return [
			`${key("↑↓")} ${label("select")}`,
			`${key("enter")} ${label("details")}`,
			`${key("esc")} ${label("close")}`,
		].join(label(" · "));
	}

	private renderNarrow(width: number): string[] {
		const { runs } = this.listWindow();
		const lines = [
			style(this.theme, "accent", bold(this.theme, clip(" Subagents", width))),
			...runs.map((run) => clip(this.listRow(run, width - 1), width)),
		];
		lines.push(clip(` ${this.helpText()}`, width));
		return lines;
	}
}

function isInteractive(ctx: ExtensionContext): boolean {
	return (
		ctx.mode === "tui" &&
		ctx.hasUI &&
		typeof ctx.ui?.setWidget === "function" &&
		typeof ctx.ui?.onTerminalInput === "function"
	);
}

/** A resumed session finds its runs started this long before it resumed. */
const SEED_LOOKBACK_MS = 24 * 60 * 60_000;

export interface ActivityWidgetControl {
	isEnabled(): boolean;
	/** Turn the widget on or off now and remember the choice. */
	setEnabled(enabled: boolean): void;
}

export function registerActivityWidget(
	pi: ExtensionAPI,
	toolName: string,
): ActivityWidgetControl {
	let enabled = readPreferences().widget !== false;
	if (typeof pi.on !== "function")
		return {
			isEnabled: () => enabled,
			setEnabled(next) {
				enabled = next;
				writePreferences({ widget: next });
			},
		};
	let widget: ActivityWidget | undefined;
	let loader: SessionActivityLoader | undefined;
	let sessionCtx: ExtensionContext | undefined;
	const reset = () => {
		widget?.dispose();
		widget = undefined;
		loader = undefined;
	};
	const start = (ctx: ExtensionContext) => {
		reset();
		if (!enabled || !isInteractive(ctx)) return;
		const sessionId = currentSessionId(ctx);
		if (sessionId === undefined) return;
		const sessionLoader = createSessionActivityLoader(sessionId);
		loader = sessionLoader;
		const current = new ActivityWidget(ctx, {
			load: () => sessionLoader.load(),
			openRun: (run) => showSubagentPanel(ctx, { runKey: run.key }),
		});
		widget = current;
		// A resumed session (or a re-enabled widget) may have runs in flight.
		void sessionLoader
			.seed(Date.now() - SEED_LOOKBACK_MS)
			.catch(() => undefined)
			.then(() => current.refresh());
	};
	// Every run start writes a locator; follow this session's new runs
	// without scanning the global index.
	onRunLocatorWritten((locator) => {
		if (loader === undefined || widget === undefined) return;
		loader.track(locator);
		void widget.refresh();
	});
	pi.on("session_start", (_event, ctx) => {
		sessionCtx = ctx;
		start(ctx);
	});
	pi.on("session_shutdown", () => {
		sessionCtx = undefined;
		reset();
	});
	pi.on("tool_execution_start", (event) => {
		if (event.toolName === toolName) widget?.toolStarted(event.toolCallId);
	});
	pi.on("tool_execution_end", (event) => {
		if (event.toolName === toolName) widget?.toolEnded(event.toolCallId);
	});
	return {
		isEnabled: () => enabled,
		setEnabled(next) {
			enabled = next;
			if (!next) reset();
			else if (sessionCtx !== undefined) start(sessionCtx);
			// Applied for this session even if remembering it fails.
			writePreferences({ widget: next });
		},
	};
}
