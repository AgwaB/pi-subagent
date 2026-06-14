#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";

async function loadExtension() {
  const jiti = createJiti(import.meta.url, {
    interopDefault: true,
    moduleCache: false,
  });
  const mod = await jiti.import(resolve("src/index.ts"));
  return mod.default ?? mod;
}

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function renderText(component, width = 120) {
  return stripAnsi(component.render(width).join("\n"));
}

// Independent display-width oracle: wide East Asian / fullwidth / emoji code
// points occupy 2 terminal columns. Mirrors how the host TUI validates lines.
function displayWidth(text) {
  let width = 0;
  for (const ch of stripAnsi(text)) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0x303e) ||
      (cp >= 0x3041 && cp <= 0x33ff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 2_000;
  let last;
  while (Date.now() < deadline) {
    last = predicate();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function writeRun(cwd, runId, attemptId, options) {
  const attemptDir = join(cwd, ".pi/agent/runs", runId, "attempts", attemptId);
  await mkdir(attemptDir, { recursive: true });
  const outputRel = `.pi/agent/runs/${runId}/attempts/${attemptId}/output.log`;
  const resultRel = `.pi/agent/runs/${runId}/attempts/${attemptId}/result.json`;
  await writeFile(join(cwd, outputRel), `${options.log}\n`);
  const result = {
    schemaVersion: 2,
    runId,
    attemptId,
    taskId: attemptId,
    backend: options.backend ?? "headless",
    status: options.status,
    failureKind: options.failureKind ?? null,
    cwd,
    startedAt: options.startedAt ?? new Date(Date.now() - 90_000).toISOString(),
    completedAt: options.completedAt ?? (options.status === "completed" || options.status === "failed" ? new Date().toISOString() : null),
    durationMs: options.status === "running" || options.status === "pending" ? null : 1000,
    workspace: { mode: "shared", cwd, worktreePath: options.worktreePath ?? null },
    sandbox: { enabled: false },
    exitCode: options.status === "failed" ? 1 : 0,
    signal: null,
    metadata: { contextLengthExceeded: false },
    artifacts: [
      { type: "output", path: outputRel },
      { type: "result", path: resultRel },
    ],
  };
  await writeFile(join(cwd, resultRel), `${JSON.stringify(result, null, 2)}\n`);
}

async function main() {
  const register = await loadExtension();
  let registeredTool;
  let registeredCommand;
  register({
    registerTool(tool) {
      registeredTool = tool;
    },
    registerCommand(name, command) {
      registeredCommand = { name, ...command };
    },
  });

  assert.ok(registeredTool, "subagent tool should still register");
  assert.equal(typeof registeredTool.renderCall, "function", "subagent tool should render an informative active call row");
  const callTheme = {
    fg(_color, text) {
      return text;
    },
    bold(text) {
      return text;
    },
  };
  const singleCallText = renderText(registeredTool.renderCall({ agent: "reviewer", task: "Review clipboard image paste behavior", async: true }, callTheme), 120);
  assert.match(singleCallText, /subagent run · single · reviewer · Review clipboard image paste behavior · async/);
  const parallelCallText = renderText(registeredTool.renderCall({ mode: "parallel", tasks: [{ task: "a" }, { task: "b" }], onComplete: "notify" }, callTheme), 120);
  assert.match(parallelCallText, /subagent run · parallel · 2 runs · notify/);
  const statusCallText = renderText(registeredTool.renderCall({ action: "status", runId: "run_example", attemptId: "attempt-1" }, callTheme), 120);
  assert.match(statusCallText, /subagent status · run_example · attempt-1/);
  const narrowCallText = renderText(registeredTool.renderCall({ task: "Review-only task. Do not edit files. Do not exceed the available TUI width.", async: true }, callTheme), 30);
  assert.ok(narrowCallText.length <= 30, "renderCall should truncate to the available render width");
  assert.ok(registeredCommand, "subagent command should register");
  assert.equal(registeredCommand.name, "subagent");
  assert.equal(typeof registeredCommand.handler, "function");
  assert.equal(registeredCommand.getArgumentCompletions("pa")?.[0]?.value, "panel");
  assert.equal(registeredCommand.getArgumentCompletions("zzz"), null);

  const tempRoot = await mkdtemp(join(tmpdir(), "pi-subagent-panel-"));
  try {
    const cwd = join(tempRoot, "workspace");
    await mkdir(cwd, { recursive: true });

    const notifications = [];
    let customCalls = 0;
    async function runCommand(args, overrides = {}) {
      let component;
      let closeCount = 0;
      const ctx = {
        cwd,
        mode: "tui",
        hasUI: true,
        ui: {
          notify(message, level) {
            notifications.push({ message, level });
          },
          async custom(factory) {
            customCalls += 1;
            component = await factory(
              { requestRender() {} },
              {
                fg(_color, text) {
                  return text;
                },
                bg(_color, text) {
                  return text;
                },
                bold(text) {
                  return text;
                },
              },
              {},
              () => {
                closeCount += 1;
              },
            );
          },
        },
        ...overrides,
      };
      await registeredCommand.handler(args, ctx);
      return { component, closeCount: () => closeCount };
    }

    await registeredCommand.handler("", { cwd, mode: "tui", hasUI: true, ui: { notify: (message, level) => notifications.push({ message, level }) } });
    assert.ok(notifications.some((item) => item.message.includes("/subagent panel")), "wrong args should show usage");

    const beforeNonTuiCustomCalls = customCalls;
    await runCommand("panel", { mode: "json", hasUI: false });
    assert.equal(customCalls, beforeNonTuiCustomCalls, "non-TUI should not open custom panel");
    assert.ok(notifications.some((item) => item.message.includes("interactive TUI")), "non-TUI should warn");

    const empty = await runCommand("panel");
    assert.ok(empty.component, "empty panel should open");
    await waitFor(() => renderText(empty.component).includes("No subagent runs found"), "empty render");
    empty.component.handleInput("q");
    assert.equal(empty.closeCount(), 1, "q should close empty panel");

    await writeRun(cwd, "run_active", "attempt-1", { status: "running", backend: "headless", log: "active attempt one latest" });
    await writeRun(cwd, "run_active", "attempt-2", { status: "completed", backend: "headless", log: "active attempt two result" });
    await writeRun(cwd, "run_queued", "attempt-1", { status: "pending", backend: "headless", log: "queued waiting slot", completedAt: null });
    await writeRun(cwd, "run_done", "attempt-1", { status: "completed", backend: "tmux", log: "done result ready" });
    await writeRun(cwd, "run_failed", "attempt-1", { status: "failed", backend: "inline", failureKind: "timeout", log: "failed timeout tail" });
    for (let index = 0; index < 24; index += 1) {
      await writeRun(cwd, `run_scroll_${String(index).padStart(2, "0")}`, "attempt-1", { status: "completed", backend: "headless", log: `scroll run ${index}` });
    }

    const panel = await runCommand("panel");
    const component = panel.component;
    assert.ok(component, "panel should open with runs");
    await waitFor(() => renderText(component).includes("run_active"), "runs render");
    let text = renderText(component);
    assert.match(text, /Subagents/);
    assert.match(text, /live/);
    assert.match(text, /run_active/);
    assert.match(text, /running/);
    assert.match(text, /RUN/);
    assert.match(text, /Run ID/);
    assert.match(text, /WORKSPACE/);
    assert.match(text, /ATTEMPTS/);
    assert.match(text, /Result/);
    assert.match(text, /Started/);
    assert.match(text, /Completed/);
    assert.match(text, /LOG TAIL/);
    assert.match(text, /attempt-1/);
    assert.match(text, /attempt-2/);
    assert.match(text, /active attempt one latest/);
    assert.match(text, /\[all\]/, "all should be the default filter");
    assert.doesNotMatch(text, /active \+ recent 20/, "recent20 tab should be removed");
    assert.doesNotMatch(text, /\binline\b|\bheadless\b|\btmux\b/, "backend labels should stay hidden in the panel");
    assert.doesNotMatch(text, /follow/, "follow toggle should not appear");

    // Regression: CJK / wide-character content must not overflow the terminal
    // width. Code-unit length under-counts wide chars, so a narrow terminal
    // would otherwise emit a line wider than `width` and crash the host TUI.
    const cjkLog = "지금 터미널 current folder에는 기존 큰 세션 하나만 보이고, Telegram의 최근 세션들은 root-level에만 있어서 안 보이는 상황입니다. 复制不是硬链接 🚀🚀🚀";
    await writeRun(cwd, "run_cjk", "attempt-1", { status: "running", backend: "headless", log: cjkLog, completedAt: null });
    component.handleInput("r");
    await waitFor(() => renderText(component).includes("run_cjk"), "cjk run appears");
    // The panel enforces a hard minimum render width of 48 columns, so only
    // widths at/above that floor are exercised here.
    for (const renderWidth of [48, 72, 120, 200, 272]) {
      const rawLines = component.render(renderWidth);
      for (const rawLine of rawLines) {
        assert.ok(
          displayWidth(rawLine) <= renderWidth,
          `rendered line exceeds width ${renderWidth}: ${displayWidth(rawLine)} cols`,
        );
      }
    }

    const beforeEnter = renderText(component);
    component.handleInput("\r");
    assert.equal(renderText(component), beforeEnter, "enter should be a no-op");

    component.handleInput("\u001b[B");
    text = renderText(component);
    assert.match(text, /run_queued/, "down should move run selection");
    component.handleInput("up");
    assert.match(renderText(component), /run_active/, "named up key should move run selection");
    component.handleInput("\u001b[1;2B");
    assert.match(renderText(component), /run_queued/, "modified down sequence should move run selection");
    for (let index = 0; index < 20; index += 1) component.handleInput("down");
    assert.match(renderText(component), /^▸ run_scroll_/m, "run list should scroll with selection");

    component.handleInput("\t");
    await waitFor(() => {
      const current = renderText(component);
      return current.includes("[completed]") && current.includes("run_scroll_") && !current.includes("run_failed");
    }, "completed filter");
    text = renderText(component);
    assert.doesNotMatch(text, /run_failed/, "completed filter should hide failed runs");

    component.handleInput("\u001b[C");
    await waitFor(() => {
      const current = renderText(component);
      return current.includes("[failed]") && current.includes("run_failed") && !current.includes("run_done");
    }, "failed filter");
    text = renderText(component);
    assert.doesNotMatch(text, /run_done/, "failed filter should hide completed runs");

    component.handleInput("\u001b[D");
    await waitFor(() => renderText(component).includes("[completed]") && renderText(component).includes("run_scroll_"), "left/completed filter");

    const completedRunIds = ["run_done", ...Array.from({ length: 24 }, (_, index) => `run_scroll_${String(index).padStart(2, "0")}`)];
    await Promise.all(completedRunIds.map((runId) => writeFile(join(cwd, ".pi/agent/runs", runId, "attempts", "attempt-1", "output.log"), `${runId}\nnew live tail\n`)));
    component.handleInput("r");
    await waitFor(() => renderText(component).includes("new live tail"), "manual refresh updates log tail");

    component.handleInput("\r");
    assert.ok(renderText(component).includes("new live tail"), "enter no-op should keep detail visible");
    component.handleInput("ctrl+[");
    assert.equal(panel.closeCount(), 1, "escape/ctrl+[ should close panel");

    console.log(
      JSON.stringify(
        {
          name: "check-panel",
          status: "completed",
          scenarios: [
            "command completion",
            "usage warning",
            "non-tui guard",
            "empty state",
            "full panel render",
            "wide-character lines never exceed terminal width",
            "structured detail sections and always-visible logs",
            "run selection",
            "run-list scrolling",
            "all/failed/completed filters",
            "manual refresh/live data reload",
            "enter no-op",
            "q/escape close",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await main();
