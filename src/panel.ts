import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Component } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ResultEnvelope } from "./artifacts/index.ts";
import type { Status } from "./core/constants.ts";

const DEFAULT_RUNS_DIR = ".pi/agent/runs";
const LIVE_REFRESH_MS = 1_500;
const LOG_TAIL_LINES = 5;

type Filter = "all" | "failed" | "completed";

interface TaskRow {
  attemptId: string;
  status: Status;
  backend: string;
  failureKind: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  resultPath: string;
  logPath: string | null;
  logTail: string[];
  workspace: string;
  worktreePath: string | null;
  modelLabel: string;
}

interface RunRow {
  runId: string;
  status: Status;
  backend: string;
  updatedMs: number;
  startedAt: string;
  completedAt: string | null;
  dependency: string | null;
  eventTail: string[];
  tasks: TaskRow[];
}

interface PanelSnapshot {
  runs: RunRow[];
  totalRuns: number;
  loadedAt: Date;
}

interface PanelTheme {
  // Method signatures are intentionally used so the host Theme (with a narrower
  // ThemeColor union) remains assignable under bivariant method checks.
  fg?(color: string, text: string): string;
  bg?(color: string, text: string): string;
  bold?(text: string): string;
}

interface PanelTui {
  requestRender?: () => void;
}

function isInsideOrEqual(parent: string, child: string): boolean {
  const childRelative = relative(parent, child);
  return childRelative === "" || (!childRelative.startsWith("..") && !isAbsolute(childRelative));
}

function safeRelative(cwd: string, path: string): string {
  const rel = relative(cwd, path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return path;
  return rel.split(sep).join("/");
}

function style(theme: PanelTheme, color: string, text: string): string {
  return theme.fg?.(color, text) ?? text;
}

function bold(theme: PanelTheme, text: string): string {
  return theme.bold?.(text) ?? text;
}

const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

// Terminal display width of a single Unicode code point, in columns.
// Wide East Asian / fullwidth / emoji code points occupy 2 columns; combining
// marks and control characters occupy 0. This must stay aligned with how the
// host TUI measures lines, otherwise CJK-heavy text under-counts and overflows
// the terminal width (which crashes the renderer).
function charWidth(cp: number): number {
  // C0/C1 control characters render with no horizontal advance here.
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  // Zero-width and combining ranges.
  if (
    cp === 0x200b || // zero width space
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacritical marks
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    (cp >= 0xfe20 && cp <= 0xfe2f)
  ) {
    return 0;
  }
  // Wide (2-column) ranges.
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, Kangxi, punctuation
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana..CJK compatibility
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe10 && cp <= 0xfe19) || // vertical forms
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji & pictographs
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK ext B+
  ) {
    return 2;
  }
  return 1;
}

// Measure the visible terminal width of a string, ignoring ANSI escapes and
// accounting for wide characters.
function visibleLength(text: string): number {
  let width = 0;
  for (let index = 0; index < text.length; ) {
    if (text.charCodeAt(index) === 0x1b) {
      ANSI_PATTERN.lastIndex = index;
      const match = ANSI_PATTERN.exec(text);
      if (match && match.index === index) {
        index = ANSI_PATTERN.lastIndex;
        continue;
      }
    }
    const cp = text.codePointAt(index) ?? 0;
    width += charWidth(cp);
    index += cp > 0xffff ? 2 : 1;
  }
  return width;
}

function clip(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleLength(text) <= width) return text;
  if (width <= 1) return "…";

  let output = "";
  let visible = 0;
  for (let index = 0; index < text.length; ) {
    if (text.charCodeAt(index) === 0x1b) {
      ANSI_PATTERN.lastIndex = index;
      const match = ANSI_PATTERN.exec(text);
      if (match && match.index === index) {
        output += match[0];
        index = ANSI_PATTERN.lastIndex;
        continue;
      }
    }
    const cp = text.codePointAt(index) ?? 0;
    const w = charWidth(cp);
    // Reserve one column for the ellipsis.
    if (visible + w > width - 1) break;
    output += String.fromCodePoint(cp);
    visible += w;
    index += cp > 0xffff ? 2 : 1;
  }
  return `${output}…`;
}

function pad(text: string, width: number): string {
  const visible = visibleLength(text);
  return visible >= width ? clip(text, width) : text + " ".repeat(width - visible);
}

function fmtAge(ms: number, now = Date.now()): string {
  const delta = Math.max(0, now - ms);
  if (delta < 1_000) return "now";
  if (delta < 60_000) return `${Math.floor(delta / 1_000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return `${Math.floor(delta / 3_600_000)}h ago`;
}

function fmtElapsed(startedAt: string, completedAt: string | null): string {
  const start = Date.parse(startedAt);
  const end = completedAt === null ? Date.now() : Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "—";
  const seconds = Math.max(0, Math.floor((end - start) / 1_000));
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function statusPriority(status: Status): number {
  if (status === "running") return 0;
  if (status === "pending") return 1;
  if (status === "failed") return 2;
  if (status === "cancelled") return 3;
  return 4;
}

function aggregateRunStatus(attempts: TaskRow[]): Status {
  if (attempts.some((attempt) => attempt.status === "running")) return "running";
  if (attempts.some((attempt) => attempt.status === "pending")) return "pending";
  if (attempts.some((attempt) => attempt.status === "failed")) return "failed";
  if (attempts.some((attempt) => attempt.status === "cancelled")) return "cancelled";
  return "completed";
}

function isEscapeKey(data: string): boolean {
  return (
    data === "\u001b" ||
    data === "escape" ||
    data === "esc" ||
    data === "Esc" ||
    data === "ctrl+[" ||
    data.startsWith("escape") ||
    data.startsWith("esc") ||
    /^\u001b\[27(?:;\d+)?(?::\d+)?u$/.test(data)
  );
}

function isEnterKey(data: string): boolean {
  return data === "\r" || data === "\n" || data === "enter" || data === "return" || data === "\u001b[13u";
}

function isTabKey(data: string): boolean {
  return data === "\t" || data === "tab" || data === "\u001b[9u";
}

function isArrowKey(data: string, direction: "up" | "down" | "left" | "right"): boolean {
  if (data === direction) return true;
  const legacy: Record<typeof direction, string[]> = {
    up: ["\u001b[A", "\u001bOA", "\u001b[a"],
    down: ["\u001b[B", "\u001bOB", "\u001b[b"],
    left: ["\u001b[D", "\u001bOD", "\u001b[d"],
    right: ["\u001b[C", "\u001bOC", "\u001b[c"],
  };
  if (legacy[direction].includes(data)) return true;
  const suffix: Record<typeof direction, string> = { up: "A", down: "B", right: "C", left: "D" };
  return new RegExp(`^\\u001b\\[1;\\d+(?::\\d+)?${suffix[direction]}$`).test(data);
}

function statusColor(status: Status): string {
  if (status === "completed") return "success";
  if (status === "running" || status === "pending") return "warning";
  if (status === "failed" || status === "cancelled") return "error";
  return "accent";
}

function statusLabel(status: Status): string {
  if (status === "completed") return "done";
  return status;
}

function isActive(status: Status): boolean {
  return status === "pending" || status === "running";
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function isResultEnvelope(value: unknown): value is ResultEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { runId?: unknown }).runId === "string" &&
    (typeof (value as { attemptId?: unknown }).attemptId === "string" || typeof (value as { taskId?: unknown }).taskId === "string")
  );
}

interface RegistryTaskRecord {
  attemptId?: string;
  taskId?: string;
  status: Status;
  backend?: string;
  failureKind?: string | null;
  startedAt?: string;
  completedAt?: string | null;
  updatedAt?: string;
  artifactCwd?: string;
  resultPath?: string;
  outputPath?: string;
  stdoutPath?: string;
  stderrPath?: string;
  workspace?: { cwd?: string; worktreePath?: string | null };
}

interface RegistryRunRecord {
  runId: string;
  mode?: string;
  status: Status;
  backend?: string;
  dependency?: string | null;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  attempts?: RegistryTaskRecord[];
  tasks?: RegistryTaskRecord[];
}

function isRegistryRunRecord(value: unknown): value is RegistryRunRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { runId?: unknown }).runId === "string" &&
    (Array.isArray((value as { attempts?: unknown }).attempts) || Array.isArray((value as { tasks?: unknown }).tasks))
  );
}

async function readLogTail(cwd: string, result: ResultEnvelope): Promise<{ path: string | null; tail: string[] }> {
  const artifact = result.artifacts.find((candidate) => candidate.type === "output") ?? result.artifacts.find((candidate) => candidate.type === "stdout") ?? result.artifacts.find((candidate) => candidate.type === "stderr");
  if (artifact === undefined) return { path: null, tail: [] };
  if (isAbsolute(artifact.path) || artifact.path.split("/").includes("..")) return { path: artifact.path, tail: [] };
  const path = resolve(cwd, artifact.path.split("/").join(sep));
  if (!isInsideOrEqual(cwd, path)) return { path: artifact.path, tail: [] };
  const text = await readFile(path, "utf8").catch(() => "");
  return { path: artifact.path, tail: text.split(/\r?\n/).filter(Boolean).slice(-LOG_TAIL_LINES) };
}

function modelLabel(result: ResultEnvelope): string {
  const pieces: string[] = [];
  const maybeResult = result as ResultEnvelope & { model?: string; thinking?: string };
  if (typeof maybeResult.model === "string") pieces.push(maybeResult.model);
  if (typeof maybeResult.thinking === "string") pieces.push(maybeResult.thinking);
  return pieces.join(" · ");
}

async function readTask(cwd: string, resultPath: string, _mtimeMs: number): Promise<TaskRow | null> {
  const parsed = await readJson(resultPath);
  if (!isResultEnvelope(parsed)) return null;
  const log = await readLogTail(cwd, parsed);
  return {
    attemptId: parsed.attemptId ?? parsed.taskId ?? "unknown",
    status: parsed.status,
    backend: parsed.backend,
    failureKind: parsed.failureKind,
    startedAt: parsed.startedAt,
    completedAt: parsed.completedAt,
    durationMs: parsed.durationMs,
    resultPath: safeRelative(cwd, resultPath),
    logPath: log.path,
    logTail: log.tail,
    workspace: parsed.workspace.cwd,
    worktreePath: parsed.workspace.worktreePath,
    modelLabel: modelLabel(parsed),
  };
}

async function readTailFromRegistryPath(task: RegistryTaskRecord): Promise<{ path: string | null; tail: string[] }> {
  const artifactCwd = task.artifactCwd;
  const path = task.outputPath ?? task.stdoutPath ?? task.stderrPath;
  if (artifactCwd === undefined || path === undefined || isAbsolute(path) || path.split("/").includes("..")) return { path: path ?? null, tail: [] };
  const absolute = resolve(artifactCwd, path.split("/").join(sep));
  if (!isInsideOrEqual(resolve(artifactCwd), absolute)) return { path, tail: [] };
  const text = await readFile(absolute, "utf8").catch(() => "");
  return { path, tail: text.split(/\r?\n/).filter(Boolean).slice(-LOG_TAIL_LINES) };
}

async function readTaskFromRegistry(cwd: string, task: RegistryTaskRecord): Promise<TaskRow> {
  if (task.artifactCwd !== undefined && task.resultPath !== undefined && !isAbsolute(task.resultPath) && !task.resultPath.split("/").includes("..")) {
    const absolute = resolve(task.artifactCwd, task.resultPath.split("/").join(sep));
    if (isInsideOrEqual(resolve(task.artifactCwd), absolute)) {
      const statInfo = await stat(absolute).catch(() => null);
      if (statInfo !== null) {
        const parsed = await readTask(task.artifactCwd, absolute, statInfo.mtimeMs);
        if (parsed !== null) return parsed;
      }
    }
  }
  const log = await readTailFromRegistryPath(task);
  return {
    attemptId: task.attemptId ?? task.taskId ?? "unknown",
    status: task.status,
    backend: task.backend ?? "unknown",
    failureKind: task.failureKind ?? null,
    startedAt: task.startedAt ?? task.updatedAt ?? new Date().toISOString(),
    completedAt: task.completedAt ?? null,
    durationMs: null,
    resultPath: task.resultPath ?? "—",
    logPath: log.path,
    logTail: log.tail,
    workspace: task.workspace?.cwd ?? cwd,
    worktreePath: task.workspace?.worktreePath ?? null,
    modelLabel: "",
  };
}

async function loadRuns(cwd: string, filter: Filter): Promise<PanelSnapshot> {
  const runsDir = resolve(cwd, DEFAULT_RUNS_DIR);
  if (!isInsideOrEqual(cwd, runsDir)) return { runs: [], totalRuns: 0, loadedAt: new Date() };
  const runEntries = await readdir(runsDir, { withFileTypes: true }).catch(() => []);
  const runs: RunRow[] = [];

  for (const runEntry of runEntries) {
    if (!runEntry.isDirectory()) continue;
    const runDir = join(runsDir, runEntry.name);
    const registry = await readJson(join(runDir, "run.json"));
    if (isRegistryRunRecord(registry)) {
      const eventsText = await readFile(join(runDir, "events.jsonl"), "utf8").catch(() => "");
      const eventTail = eventsText.split(/\r?\n/).filter(Boolean).slice(-LOG_TAIL_LINES);
      const records = registry.attempts ?? registry.tasks ?? [];
      const tasks = await Promise.all(records.map((task) => readTaskFromRegistry(cwd, task)));
      if (tasks.length === 0) continue;
      tasks.sort((a, b) => a.attemptId.localeCompare(b.attemptId, undefined, { numeric: true }));
      runs.push({
        runId: registry.runId,
        status: registry.status,
        backend: registry.backend ?? tasks[0]?.backend ?? "unknown",
        updatedMs: Number.isFinite(Date.parse(registry.updatedAt)) ? Date.parse(registry.updatedAt) : Date.now(),
        startedAt: registry.startedAt,
        completedAt: registry.completedAt,
        dependency: registry.dependency ?? null,
        eventTail,
        tasks,
      });
      continue;
    }

    const taskEntries = await readdir(runDir, { withFileTypes: true }).catch(() => []);
    const attemptEntries = await readdir(join(runDir, "attempts"), { withFileTypes: true }).catch(() => []);
    const candidates = [
      ...attemptEntries.filter((entry) => entry.isDirectory()).map((entry) => join(runDir, "attempts", entry.name, "result.json")),
      ...taskEntries.filter((entry) => entry.isDirectory() && entry.name !== "attempts").map((entry) => join(runDir, entry.name, "result.json")),
    ];
    const tasks: TaskRow[] = [];
    let updatedMs = 0;
    for (const resultPath of candidates) {
      const resultStat = await stat(resultPath).catch(() => null);
      if (resultStat === null) continue;
      updatedMs = Math.max(updatedMs, resultStat.mtimeMs);
      const task = await readTask(cwd, resultPath, resultStat.mtimeMs);
      if (task !== null) tasks.push(task);
    }
    if (tasks.length === 0) continue;
    tasks.sort((a, b) => a.attemptId.localeCompare(b.attemptId, undefined, { numeric: true }));
    const status = aggregateRunStatus(tasks);
    runs.push({
      runId: runEntry.name,
      status,
      backend: tasks[0]?.backend ?? "unknown",
      updatedMs,
      startedAt: tasks.map((task) => task.startedAt).sort()[0] ?? new Date(updatedMs).toISOString(),
      completedAt: tasks.every((task) => task.completedAt !== null) ? tasks.map((task) => task.completedAt).sort().at(-1) ?? null : null,
      dependency: null,
      eventTail: [],
      tasks,
    });
  }

  const totalRuns = runs.length;
  runs.sort((a, b) => statusPriority(a.status) - statusPriority(b.status) || b.updatedMs - a.updatedMs);
  const filtered = runs.filter((run) => {
    if (filter === "failed") return run.status === "failed" || run.status === "cancelled";
    if (filter === "completed") return run.status === "completed";
    return true;
  });
  return { runs: filtered, totalRuns, loadedAt: new Date() };
}

function splitLine(left: string, right: string, width: number): string {
  const gap = width - left.length - right.length;
  if (gap <= 1) return clip(`${left} ${right}`, width);
  return `${left}${" ".repeat(gap)}${right}`;
}

function border(width: number): string {
  return "─".repeat(Math.max(1, width));
}

export class SubagentPanel implements Component {
  private snapshot: PanelSnapshot = { runs: [], totalRuns: 0, loadedAt: new Date() };
  private selectedRun = 0;
  private filter: Filter = "all";
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;
  private loading = false;

  constructor(
    private readonly cwd: string,
    private readonly theme: PanelTheme,
    private readonly tui: PanelTui,
    private readonly done: () => void,
  ) {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), LIVE_REFRESH_MS);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  invalidate(): void {
    // Stateless render; refresh loop owns data invalidation.
  }

  handleInput(data: string): void {
    if (data === "q" || isEscapeKey(data)) {
      this.dispose();
      this.done();
      return;
    }
    if (data === "r") {
      void this.refresh();
      return;
    }
    if (isTabKey(data) || isArrowKey(data, "right") || data === "l") {
      void this.cycleFilter(1);
      return;
    }
    if (data === "shift+tab" || data === "\u001b[Z" || isArrowKey(data, "left") || data === "h") {
      void this.cycleFilter(-1);
      return;
    }
    if (isEnterKey(data)) return;
    if (isArrowKey(data, "up") || data === "k") this.moveRun(-1);
    if (isArrowKey(data, "down") || data === "j") this.moveRun(1);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(48, width);
    const lines: string[] = [];
    const active = this.snapshot.runs.filter((run) => isActive(run.status)).length;
    const failed = this.snapshot.runs.filter((run) => run.status === "failed" || run.status === "cancelled").length;
    const title = `${style(this.theme, "accent", "●")} ${bold(this.theme, "Subagents")}`;
    const status = `live · ${active} active · ${failed} failed · ${this.snapshot.runs.length}/${this.snapshot.totalRuns} shown · updated ${fmtAge(this.snapshot.loadedAt.getTime())}`;
    lines.push(splitLine(title, style(this.theme, "muted", status), safeWidth));
    lines.push(style(this.theme, "border", border(safeWidth)));
    lines.push(this.renderTabs(safeWidth));
    lines.push(style(this.theme, "border", border(safeWidth)));

    if (this.snapshot.runs.length === 0) {
      lines.push(style(this.theme, "muted", clip(`No subagent runs found under ${DEFAULT_RUNS_DIR}`, safeWidth)));
      lines.push(style(this.theme, "border", border(safeWidth)));
      lines.push(style(this.theme, "dim", "↑↓/j/k select run · tab/←→ filter · r refresh · q/esc close"));
      return lines.map((line) => clip(line, safeWidth));
    }

    let leftWidth = Math.max(30, Math.min(56, Math.floor(safeWidth * 0.34)));
    if (safeWidth - leftWidth - 3 < 30) leftWidth = Math.max(18, safeWidth - 33);
    const rightWidth = safeWidth - leftWidth - 3;
    const selectedRun = this.snapshot.runs[Math.min(this.selectedRun, this.snapshot.runs.length - 1)];
    const selectedTask = selectedRun.tasks[0];
    const runLines = this.renderRuns(leftWidth);
    const detailLines = this.renderDetail(selectedRun, selectedTask, rightWidth);
    const bodyLines = Math.max(runLines.length, detailLines.length);
    for (let index = 0; index < bodyLines; index += 1) {
      lines.push(`${pad(runLines[index] ?? "", leftWidth)} ${style(this.theme, "border", "│")} ${pad(detailLines[index] ?? "", rightWidth)}`);
    }
    lines.push(style(this.theme, "border", border(safeWidth)));
    lines.push(style(this.theme, "dim", "↑↓/j/k select run · tab/←→ filter · r refresh · q/esc close"));
    return lines.map((line) => clip(line, safeWidth));
  }

  private async refresh(): Promise<void> {
    if (this.loading || this.disposed) return;
    this.loading = true;
    try {
      const snapshot = await loadRuns(this.cwd, this.filter);
      this.snapshot = snapshot;
      this.selectedRun = Math.min(this.selectedRun, Math.max(0, snapshot.runs.length - 1));
      this.tui.requestRender?.();
    } finally {
      this.loading = false;
    }
  }

  private async cycleFilter(delta: number): Promise<void> {
    const filters: Filter[] = ["all", "completed", "failed"];
    const current = filters.indexOf(this.filter);
    this.filter = filters[(current + delta + filters.length) % filters.length] ?? "all";
    this.selectedRun = 0;
    await this.refresh();
  }

  private moveRun(delta: number): void {
    this.selectedRun = Math.max(0, Math.min(this.snapshot.runs.length - 1, this.selectedRun + delta));
    this.tui.requestRender?.();
  }


  private renderTabs(width: number): string {
    const tabs: Array<[Filter, string]> = [
      ["all", "all"],
      ["completed", "completed"],
      ["failed", "failed"],
    ];
    return clip(
      tabs
        .map(([filter, label]) => (filter === this.filter ? style(this.theme, "accent", `[${label}]`) : style(this.theme, "dim", label)))
        .join("  "),
      width,
    );
  }

  private renderRuns(width: number): string[] {
    const maxVisible = 18;
    const maxStart = Math.max(0, this.snapshot.runs.length - maxVisible);
    const windowStart = Math.min(maxStart, Math.max(0, this.selectedRun - maxVisible + 1));
    return this.snapshot.runs.slice(windowStart, windowStart + maxVisible).map((run, index) => {
      const runIndex = windowStart + index;
      const marker = runIndex === this.selectedRun ? style(this.theme, "accent", "▸") : " ";
      const status = statusLabel(run.status);
      const elapsed = fmtElapsed(run.startedAt, run.completedAt);
      const age = fmtAge(run.updatedMs);
      const meta = `${elapsed} · ${age}`;
      const statusWidth = Math.max(4, Math.min(9, status.length));
      const idWidth = Math.max(6, width - 2 - statusWidth - 1 - meta.length - 1);
      const line = `${marker} ${pad(clip(run.runId, idWidth), idWidth)} ${style(this.theme, statusColor(run.status), pad(status, statusWidth))} ${style(this.theme, "muted", meta)}`;
      return clip(line, width);
    });
  }

  private renderDetail(run: RunRow, task: TaskRow, width: number): string[] {
    const lines: string[] = [];
    const labelWidth = Math.max(8, Math.min(12, Math.floor(width * 0.18)));
    const divider = (): void => {
      lines.push(style(this.theme, "border", "─".repeat(Math.max(1, width))));
    };
    const section = (title: string): void => {
      if (lines.length > 0) divider();
      lines.push(style(this.theme, "accent", title));
    };
    const field = (name: string, value: string | null | undefined, color = "muted"): void => {
      const rendered = value && value.length > 0 ? value : "—";
      const label = style(this.theme, "dim", pad(clip(name, labelWidth), labelWidth));
      lines.push(`${label} ${style(this.theme, color, clip(rendered, Math.max(1, width - labelWidth - 1)))}`);
    };

    section("RUN");
    field("Run ID", run.runId, "text");
    field("Status", statusLabel(run.status), statusColor(run.status));
    field("Dependency", run.dependency ?? "—");
    field("Elapsed", fmtElapsed(run.startedAt, run.completedAt));
    field("Updated", fmtAge(run.updatedMs));

    section("WORKSPACE");
    field("Path", safeRelative(this.cwd, task.workspace));
    field("Worktree", task.worktreePath === null ? "—" : safeRelative(this.cwd, task.worktreePath));

    section("ATTEMPTS");
    for (const candidate of run.tasks) {
      field("Attempt", `${candidate.attemptId} · ${statusLabel(candidate.status)} · ${fmtElapsed(candidate.startedAt, candidate.completedAt)}${candidate.modelLabel ? ` · ${candidate.modelLabel}` : ""}`, statusColor(candidate.status));
      field("Result", candidate.resultPath);
      field("Log", candidate.logPath ?? "—");
      field("Started", candidate.startedAt);
      field("Completed", candidate.completedAt ?? "running");
      if (candidate.failureKind !== null) field("Failure", candidate.failureKind, "error");
    }

    section(`LOG TAIL (${task.attemptId})`);
    field("Source", task.logPath ?? task.resultPath);
    const tail = task.logTail.length > 0 ? task.logTail : ["No log output yet."];
    for (const logLine of tail) lines.push(`${style(this.theme, "dim", "›")} ${clip(logLine, Math.max(1, width - 2))}`);

    if (run.eventTail.length > 0) {
      section("EVENTS");
      for (const eventLine of run.eventTail) lines.push(`${style(this.theme, "dim", "›")} ${clip(eventLine, Math.max(1, width - 2))}`);
    }
    return lines;
  }
}

export async function showSubagentPanel(ctx: ExtensionCommandContext): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify?.("/subagent panel is available only in the interactive TUI.", "warning");
    return;
  }
  await ctx.ui.custom<void>((tui: PanelTui, theme: PanelTheme, _keybindings: unknown, done: () => void) => new SubagentPanel(ctx.cwd, theme, tui, done));
}
