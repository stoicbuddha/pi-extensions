import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateLoopWithSubagent,
  normalizeLoopJudgeResponse,
  resolveSubagentAdapter,
} from "../src/subagent-bridge.js";

const evidence = {
  trigger: "same_tool_repetition",
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

test("bridge delivers steer messages from a spawned subagent", async () => {
  const adapter = {
    spawnSubagent: async (payload) => {
      assert.equal(payload.task, "loop_judge");
      return { id: "subagent-1" };
    },
    waitForSubagentCompletion: async (run) =>
      JSON.stringify({
        confidence: 0.9,
        action: "steer",
        steer_message: `reroute away from ${run.id}`,
      }),
  };

  const result = await evaluateLoopWithSubagent(adapter, evidence);

  assert.equal(result.action, "steer");
  assert.equal(result.steer_message, "reroute away from subagent-1");
});

test("bridge offloads to a separate pi subprocess when exec is available", async () => {
  let called = false;
  const pi = {
    exec: async (command, args) => {
      called = true;
      assert.equal(command, "pi");
      assert.deepEqual(args.slice(0, 6), ["--mode", "json", "-p", "--no-session", "--no-tools", "--append-system-prompt"]);
      return {
        stdout: JSON.stringify({
          confidence: 0.88,
          action: "continue",
          reason: "isolated subprocess",
        }),
      };
    },
  };

  const result = await evaluateLoopWithSubagent(pi, evidence);

  assert.equal(called, true);
  assert.equal(result.action, "continue");
  assert.equal(result.reason, "isolated subprocess");
});

test("resolver skips host-like roots and prefers explicit subagent adapters", async () => {
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

test("bridge normalizes stop responses and missing steer content closed", () => {
  const stopped = normalizeLoopJudgeResponse(
    {
      confidence: 0.52,
      action: "stop",
      reason: "loop confirmed",
    },
    evidence,
  );

  const malformed = normalizeLoopJudgeResponse("{not json}", evidence);
  const missingSteer = normalizeLoopJudgeResponse(
    {
      confidence: 0.88,
      action: "steer",
    },
    evidence,
  );

  assert.equal(stopped.action, "stop");
  assert.equal(malformed.reason, "subagent response malformed");
  assert.equal(missingSteer.action, "stop");
  assert.equal(missingSteer.reason, "subagent response missing steer_message");
});

test("bridge fails closed when RPC is unavailable", async () => {
  await assert.rejects(
    () => evaluateLoopWithSubagent({}, evidence),
    /subagent RPC unavailable/,
  );
});

test("bridge rejects when completion never arrives", async () => {
  const adapter = {
    spawnSubagent: async () => ({ id: "subagent-2" }),
    waitForSubagentCompletion: async () => new Promise(() => {}),
  };

  await assert.rejects(
    () => evaluateLoopWithSubagent(adapter, evidence, { timeoutMs: 10 }),
    /subagent completion timed out/,
  );
});
