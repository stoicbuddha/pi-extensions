import test from "node:test";
import assert from "node:assert/strict";

import { LoopDetector } from "../src/index.js";

test("emits debug trace for heuristic and judge evaluation", async () => {
  const debugEvents = [];
  const detector = new LoopDetector({
    sameTool: { minRepeats: 2 },
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
