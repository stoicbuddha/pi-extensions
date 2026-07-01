import test from "node:test";
import assert from "node:assert/strict";

import { LoopDetector } from "../src/index.js";

test("emits debug trace for heuristic and judge evaluation", async () => {
  const debugEvents = [];
  const detector = new LoopDetector({
    sameTool: { minRepeats: 3 },
    tools: {
      rollback_status: {
        sameToolRepeats: 2,
        successCountsAsProgress: false,
      },
    },
    debug: (entry) => {
      debugEvents.push(entry);
    },
    judge: async () => ({
      is_loop: true,
      confidence: 1,
      reason: "repeat",
      action: "stop",
      offendingTool: "rollback_status",
    }),
  });

  await detector.handleEvent({ type: "tool_call", toolName: "rollback_status", args: { id: 1 } });
  await detector.handleEvent({
    type: "tool_result",
    toolName: "rollback_status",
    args: { id: 1 },
    ok: false,
    result: "failed",
  });
  const outcome = await detector.handleEvent({
    type: "tool_call",
    toolName: "rollback_status",
    args: { id: 1 },
  });

  assert.equal(outcome.intervention.type, "stop");
  assert.ok(debugEvents.some((entry) => entry.stage === "heuristic.check" && entry.payload.heuristic === "sameTool"));
  assert.ok(debugEvents.some((entry) => entry.stage === "judge.request"));
  assert.ok(debugEvents.some((entry) => entry.stage === "judge.result"));
});

test("detects exact repeated calls on the third identical invocation", async () => {
  const detector = new LoopDetector({
    sameTool: { minRepeats: 3 },
    tools: {
      ToolKitMCP_read_file: {
        sameToolRepeats: 3,
        successCountsAsProgress: false,
      },
    },
  });

  await detector.handleEvent({
    type: "tool_call",
    toolName: "ToolKitMCP_read_file",
    args: { path: "src/session.rs", start_line: 1, end_line: 30 },
  });
  await detector.handleEvent({
    type: "tool_result",
    toolName: "ToolKitMCP_read_file",
    args: { path: "src/session.rs", start_line: 1, end_line: 30 },
    ok: true,
    result: { lines: 30 },
  });
  await detector.handleEvent({
    type: "tool_call",
    toolName: "ToolKitMCP_read_file",
    args: { path: "src/session.rs", start_line: 1, end_line: 30 },
  });
  await detector.handleEvent({
    type: "tool_result",
    toolName: "ToolKitMCP_read_file",
    args: { path: "src/session.rs", start_line: 1, end_line: 30 },
    ok: true,
    result: { lines: 30 },
  });
  const outcome = await detector.handleEvent({
    type: "tool_call",
    toolName: "ToolKitMCP_read_file",
    args: { path: "src/session.rs", start_line: 1, end_line: 30 },
  });

  assert.equal(outcome.trigger.kind, "same_call_repetition");
  assert.equal(outcome.trigger.repeatCount, 3);
});

test("detects exact repeated calls even when the tool result is an error payload", async () => {
  const detector = new LoopDetector({
    sameTool: { minRepeats: 3 },
    tools: {
      ToolKitMCP_read_file: {
        sameToolRepeats: 3,
        successCountsAsProgress: false,
      },
    },
  });

  const args = { path: "src/app.rs", start_line: 51, end_line: 213 };

  await detector.handleEvent({
    type: "tool_call",
    toolName: "ToolKitMCP_read_file",
    args,
  });
  await detector.handleEvent({
    type: "tool_result",
    toolName: "ToolKitMCP_read_file",
    args,
    ok: false,
    result: {
      ok: false,
      error: {
        code: "missing_cwd",
        message: "DO THIS FIRST: call set_project_cwd with the project root path before using this tool",
      },
    },
  });
  await detector.handleEvent({
    type: "tool_call",
    toolName: "ToolKitMCP_read_file",
    args,
  });
  await detector.handleEvent({
    type: "tool_result",
    toolName: "ToolKitMCP_read_file",
    args,
    ok: false,
    result: {
      ok: false,
      error: {
        code: "missing_cwd",
        message: "DO THIS FIRST: call set_project_cwd with the project root path before using this tool",
      },
    },
  });
  const outcome = await detector.handleEvent({
    type: "tool_call",
    toolName: "ToolKitMCP_read_file",
    args,
  });

  assert.equal(outcome.trigger.kind, "same_call_repetition");
  assert.equal(outcome.trigger.offendingTool, "ToolKitMCP_read_file");
});

test("builds repeated cycles even when assistant text arrives after the tool result", async () => {
  const detector = new LoopDetector({
    sameTool: { enabled: false },
    failureRepetition: { minFailures: 99 },
    selfCorrection: { minCorrections: 99 },
    cycleRepetition: { minRepeats: 2 },
    tools: {
      ToolKitMCP_set_project_cwd: {
        sameCycleRepeats: 2,
        successCountsAsProgress: false,
      },
    },
  });

  const assistant = "I should restore the working directory and then continue with the same exact plan because nothing else changed.";

  await detector.handleEvent({
    type: "tool_call",
    toolName: "ToolKitMCP_set_project_cwd",
    args: { path: "/home/matt/Sites/zentra" },
  });
  await detector.handleEvent({
    type: "tool_result",
    toolName: "ToolKitMCP_set_project_cwd",
    args: { path: "/home/matt/Sites/zentra" },
    ok: true,
    result: { active_cwd: "/home/matt/Sites/zentra" },
  });
  await detector.handleEvent({
    type: "assistant_message",
    content: assistant,
  });

  await detector.handleEvent({
    type: "tool_call",
    toolName: "ToolKitMCP_set_project_cwd",
    args: { path: "/home/matt/Sites/zentra" },
  });
  const outcome = await detector.handleEvent({
    type: "tool_result",
    toolName: "ToolKitMCP_set_project_cwd",
    args: { path: "/home/matt/Sites/zentra" },
    ok: true,
    result: { active_cwd: "/home/matt/Sites/zentra" },
  });

  assert.equal(outcome.trigger.kind, "cycle_repetition");
  assert.equal(outcome.trigger.offendingTool, "ToolKitMCP_set_project_cwd");
});
