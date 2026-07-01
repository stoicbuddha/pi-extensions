import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  buildRecoveryPrompt,
  DEFAULT_JUDGE_CONFIDENCE_THRESHOLD,
  RECOVERY_CHILD_PRIORITY,
  resolveJudgeDisposition,
  selectRecoveryChildren,
  summarizeRecovery,
} from "../routing.js";

const indexSource = fs.readFileSync(path.join(import.meta.dirname, "..", "index.ts"), "utf8");

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
    {
      title: "Ralph recovery after loop",
      analysis: {
        summary: "The agent was trying to validate repo state before continuing work.",
        nextSteps: ["Check the current task state.", "Use a different validation step than rollback_status."],
        rationale: "It kept reusing the same validation tool without learning anything new.",
        suspectedGoal: "Verify the workspace before editing files.",
      },
    },
  );

  assert.match(prompt, /Ralph recovery after loop/);
  assert.match(prompt, /A fresh recovery context has been created for this Ralph loop\./);
  assert.match(prompt, /## Recovery Summary/);
  assert.match(prompt, /## Next Steps/);
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

test("agent_end wires natural assistant stops into Ralph stop steering", () => {
  assert.match(indexSource, /const lastAssistant = getLatestAssistantEntry\(event\);/);
  assert.match(indexSource, /await maybeDispatchStoppedLoopSteering\(ctx, pi, \{/);
  assert.match(indexSource, /stopReason: typeof lastAssistant\?\.stopReason === "string" \? lastAssistant\.stopReason : ""/);
});
