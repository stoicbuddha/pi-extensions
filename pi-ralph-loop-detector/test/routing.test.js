import test from "node:test";
import assert from "node:assert/strict";

import { buildRecoveryPrompt, RECOVERY_CHILD_PRIORITY, selectRecoveryChildren, summarizeRecovery } from "../routing.js";

test("uses the fixed child-agent priority order", () => {
  assert.deepEqual(selectRecoveryChildren(), RECOVERY_CHILD_PRIORITY);
});

test("builds a recovery prompt that references the prioritized agents", () => {
  const prompt = buildRecoveryPrompt(
    {
      trigger: { kind: "same_tool_repetition", offendingTool: "rollback_status" },
      judgeOutcome: { action: "steer", reason: "repeated tool call", steer_message: "switch approach" },
      review: { action: "steer", message: "switch approach" },
    },
    { title: "Ralph recovery after loop" },
  );

  assert.match(prompt, /Ralph recovery after loop/);
  assert.match(prompt, /scout -> researcher -> reviewer/);
  assert.match(prompt, /rollback_status/);
});

test("summarizeRecovery prefers review data when present", () => {
  const summary = summarizeRecovery({
    trigger: { kind: "intent_action_mismatch" },
    review: { action: "stop", message: "stop here" },
    judgeOutcome: { action: "stop", reason: "stop here" },
  });

  assert.equal(summary, "Loop detected via intent_action_mismatch. Action: stop. Reason: stop here");
});
