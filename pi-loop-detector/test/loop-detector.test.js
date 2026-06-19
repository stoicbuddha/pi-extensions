import test from "node:test";
import assert from "node:assert/strict";

import { LoopDetector } from "../src/index.js";

test("detects same-tool repetition with no progress", async () => {
  const detector = new LoopDetector();

  await detector.handleEvent({ type: "tool_call", toolName: "rollback_status", args: { id: 1 } });
  await detector.handleEvent({
    type: "tool_result",
    toolName: "rollback_status",
    args: { id: 1 },
    ok: false,
    result: "failed",
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

  assert.equal(outcome.trigger.kind, "same_tool_repetition");
  assert.equal(outcome.intervention.type, "steer");
  assert.equal(outcome.intervention.offendingTool, "rollback_status");
});

test("detects repeated intent/action mismatch", async () => {
  const detector = new LoopDetector();

  await detector.handleEvent({
    type: "assistant_message",
    content: "I should call `ralph_done` now.",
  });
  await detector.handleEvent({ type: "tool_call", toolName: "rollback_status", args: {} });
  await detector.handleEvent({
    type: "assistant_message",
    content: "Let me call `ralph_done` next.",
  });
  const outcome = await detector.handleEvent({
    type: "tool_call",
    toolName: "rollback_status",
    args: {},
  });

  assert.equal(outcome.trigger.kind, "intent_action_mismatch");
  assert.deepEqual(outcome.trigger.expectedTools, ["ralph_done"]);
  assert.deepEqual(outcome.trigger.actualToolSequence, ["rollback_status", "rollback_status"]);
});

test("does not trigger on repeated successful tool use", async () => {
  const detector = new LoopDetector();

  await detector.handleEvent({ type: "tool_call", toolName: "search_query", args: { q: "a" } });
  await detector.handleEvent({
    type: "tool_result",
    toolName: "search_query",
    args: { q: "a" },
    ok: true,
    progress: true,
    result: "found a",
  });
  await detector.handleEvent({ type: "tool_call", toolName: "search_query", args: { q: "b" } });
  await detector.handleEvent({
    type: "tool_result",
    toolName: "search_query",
    args: { q: "b" },
    ok: true,
    progress: true,
    result: "found b",
  });
  const outcome = await detector.handleEvent({
    type: "tool_call",
    toolName: "search_query",
    args: { q: "c" },
  });

  assert.equal(outcome, null);
});

test("does not trigger same-tool repetition when arguments materially change", async () => {
  const detector = new LoopDetector();

  await detector.handleEvent({ type: "tool_call", toolName: "search_query", args: { q: "a" } });
  await detector.handleEvent({
    type: "tool_result",
    toolName: "search_query",
    args: { q: "a" },
    ok: true,
    progress: true,
    result: "found a",
  });
  await detector.handleEvent({ type: "tool_call", toolName: "search_query", args: { q: "b" } });
  await detector.handleEvent({
    type: "tool_result",
    toolName: "search_query",
    args: { q: "b" },
    ok: true,
    progress: true,
    result: "found b",
  });
  const outcome = await detector.handleEvent({
    type: "tool_call",
    toolName: "search_query",
    args: { q: "c" },
  });

  assert.equal(outcome, null);
});

test("detects repeated failures with similar inputs", async () => {
  const detector = new LoopDetector({
    sameTool: { minRepeats: 99 },
  });

  await detector.handleEvent({
    type: "tool_result",
    toolName: "apply_patch",
    args: { file: "a.js" },
    ok: false,
    result: "parse error",
  });
  await detector.handleEvent({
    type: "tool_result",
    toolName: "apply_patch",
    args: { file: "a.js" },
    ok: false,
    result: "parse error",
  });
  const outcome = await detector.handleEvent({
    type: "tool_result",
    toolName: "apply_patch",
    args: { file: "a.js" },
    ok: false,
    result: "parse error",
  });

  assert.equal(outcome.trigger.kind, "failure_repetition");
  assert.equal(outcome.intervention.offendingTool, "apply_patch");
});

test("detects self-correction loop", async () => {
  const detector = new LoopDetector({
    sameTool: { minRepeats: 99 },
    failureRepetition: { minFailures: 99 },
  });

  await detector.handleEvent({
    type: "assistant_message",
    content: "I keep doing the wrong thing. Let me correct that.",
  });
  await detector.handleEvent({ type: "tool_call", toolName: "rollback_status", args: {} });
  await detector.handleEvent({
    type: "assistant_message",
    content: "I need to stop calling rollback_status.",
  });
  const outcome = await detector.handleEvent({
    type: "tool_call",
    toolName: "rollback_status",
    args: {},
  });

  assert.equal(outcome.trigger.kind, "self_correction_loop");
});

test("cooldown suppresses repeated interventions until behavior changes", async () => {
  const detector = new LoopDetector();

  await detector.handleEvent({ type: "tool_call", toolName: "rollback_status", args: {} });
  await detector.handleEvent({ type: "tool_result", toolName: "rollback_status", args: {}, ok: false, result: "failed" });
  await detector.handleEvent({ type: "tool_call", toolName: "rollback_status", args: {} });
  await detector.handleEvent({ type: "tool_result", toolName: "rollback_status", args: {}, ok: false, result: "failed" });
  const first = await detector.handleEvent({
    type: "tool_call",
    toolName: "rollback_status",
    args: {},
  });
  assert.equal(first.intervention.type, "steer");

  const suppressed = await detector.handleEvent({
    type: "tool_call",
    toolName: "rollback_status",
    args: {},
  });
  assert.equal(suppressed, null);

  const cleared = await detector.handleEvent({
    type: "tool_call",
    toolName: "search_query",
    args: { q: "new path" },
  });
  assert.equal(cleared, null);
  assert.equal(detector.getState().activeCooldown, 0);
});

test("uses judge output to choose deterministic intervention", async () => {
  const detector = new LoopDetector({
    judge: async () => ({
      is_loop: true,
      confidence: 0.93,
      reason: "clear loop",
      recommended_action: "restrict_tools",
      offendingTool: "rollback_status",
    }),
  });

  await detector.handleEvent({ type: "tool_call", toolName: "rollback_status", args: {} });
  await detector.handleEvent({ type: "tool_result", toolName: "rollback_status", args: {}, ok: false, result: "failed" });
  await detector.handleEvent({ type: "tool_call", toolName: "rollback_status", args: {} });
  await detector.handleEvent({ type: "tool_result", toolName: "rollback_status", args: {}, ok: false, result: "failed" });
  const outcome = await detector.handleEvent({
    type: "tool_call",
    toolName: "rollback_status",
    args: {},
  });

  assert.equal(outcome.intervention.type, "restrict_tools");
  assert.deepEqual(outcome.intervention.blockedTools, ["rollback_status"]);
});
