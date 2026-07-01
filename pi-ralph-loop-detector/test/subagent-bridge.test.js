import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRecoverySummaryPayload,
  evaluateLoopWithSubagent,
  evaluateRecoverySummaryWithSubagent,
  normalizeRecoverySummaryResponse,
  resolveSubagentAdapter,
} from "../src/subagent-bridge.js";

const evidence = {
  trigger: { kind: "same_tool_repetition", offendingTool: "rollback_status" },
  normalizedSummary: {
    offendingTool: "rollback_status",
  },
};

test("bridge accepts continue from a direct subagent response", async () => {
  const adapter = {
    judgeLoop: async () => JSON.stringify({
      confidence: 0.81,
      action: "continue",
    }),
  };

  const result = await evaluateLoopWithSubagent(adapter, evidence);

  assert.equal(result.action, "continue");
  assert.equal(result.confidence, 0.81);
});

test("recovery summary bridge returns normalized summary content", async () => {
  const adapter = {
    invokeSubagent: async (payload) => {
      assert.equal(payload.task, "loop_recovery_summary");
      return JSON.stringify({
        summary: "The agent was trying to inspect repo state before making edits.",
        next_steps: ["Check the active Ralph task.", "Use a different inspection step than rollback_status."],
        rationale: "It repeated the same inspection without new evidence.",
        suspected_goal: "Verify repository state before editing files.",
      });
    },
  };

  const result = await evaluateRecoverySummaryWithSubagent(adapter, evidence);

  assert.match(result.summary, /inspect repo state/);
  assert.deepEqual(result.nextSteps, [
    "Check the active Ralph task.",
    "Use a different inspection step than rollback_status.",
  ]);
  assert.match(result.rationale, /without new evidence/);
});

test("bridge offloads recovery analysis to a separate pi subprocess when exec is available", async () => {
  let called = false;
  const pi = {
    exec: async (command, args) => {
      called = true;
      assert.equal(command, "pi");
      assert.deepEqual(args.slice(0, 6), ["--mode", "json", "-p", "--no-session", "--no-tools", "--append-system-prompt"]);
      return {
        stdout: JSON.stringify({
          summary: "Fresh recovery summary",
          next_steps: ["Re-state the goal."],
          rationale: "Loop detected.",
        }),
      };
    },
  };

  const result = await evaluateRecoverySummaryWithSubagent(pi, evidence);

  assert.equal(called, true);
  assert.equal(result.summary, "Fresh recovery summary");
  assert.deepEqual(result.nextSteps, ["Re-state the goal."]);
});

test("resolver still skips host-like roots and prefers explicit subagent adapters", async () => {
  let parentJudgeCalled = false;
  const hostLikeRoot = {
    sendUserMessage: () => {},
    registerTool: () => {},
    judgeLoop: async () => {
      parentJudgeCalled = true;
      return JSON.stringify({
        confidence: 0.99,
        action: "stop",
      });
    },
  };
  const subagentRoot = {
    spawnSubagent: async () => ({ id: "subagent-2" }),
    waitForSubagentCompletion: async () =>
      JSON.stringify({
        confidence: 0.77,
        action: "continue",
      }),
  };

  const adapter = resolveSubagentAdapter([hostLikeRoot, subagentRoot]);
  const result = await evaluateLoopWithSubagent(adapter, evidence);

  assert.equal(parentJudgeCalled, false);
  assert.equal(result.action, "continue");
});

test("recovery summary normalization falls back when the response is malformed", () => {
  const result = normalizeRecoverySummaryResponse("{not json}", evidence);

  assert.match(result.summary, /got stuck/);
  assert.equal(result.offendingTool, "rollback_status");
  assert.ok(result.nextSteps.length > 0);
});

test("buildRecoverySummaryPayload tags recovery analysis requests", () => {
  const payload = buildRecoverySummaryPayload(evidence, { requestId: "abc123" });

  assert.equal(payload.task, "loop_recovery_summary");
  assert.equal(payload.requestId, "abc123");
});
