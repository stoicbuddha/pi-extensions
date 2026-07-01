import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRecoveryPrompt,
  DEFAULT_JUDGE_CONFIDENCE_THRESHOLD,
  RECOVERY_CHILD_PRIORITY,
  resolveJudgeDisposition,
  selectRecoveryChildren,
  summarizeRecovery,
} from "../routing.js";

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
  assert.match(prompt, /Stay in the current session and steer the active agent directly\./);
  assert.match(prompt, /Do not fork a fresh recovery context for this loop\./);
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

test("resolveJudgeDisposition downgrades low-confidence interventions to continue", () => {
  const outcome = {
    review: { action: "stop", confidence: DEFAULT_JUDGE_CONFIDENCE_THRESHOLD - 0.1, message: "too fuzzy" },
    judgeOutcome: { action: "stop", confidence: DEFAULT_JUDGE_CONFIDENCE_THRESHOLD - 0.1, reason: "too fuzzy" },
  };

  const disposition = resolveJudgeDisposition(outcome, { confidenceThreshold: DEFAULT_JUDGE_CONFIDENCE_THRESHOLD });

  assert.equal(disposition.action, "continue");
  assert.equal(disposition.confidence, DEFAULT_JUDGE_CONFIDENCE_THRESHOLD - 0.1);
});

test("resolveJudgeDisposition preserves high-confidence steer decisions", () => {
  const outcome = {
    review: { action: "steer", confidence: 0.91, message: "redirect" },
    judgeOutcome: { action: "steer", confidence: 0.91, steer_message: "redirect" },
  };

  const disposition = resolveJudgeDisposition(outcome);

  assert.equal(disposition.action, "steer");
  assert.equal(disposition.reason, "redirect");
});
