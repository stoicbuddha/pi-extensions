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
const routingSource = fs.readFileSync(path.join(import.meta.dirname, "..", "routing.js"), "utf8");
const toolsSource = fs.readFileSync(path.join(import.meta.dirname, "..", "ralph-tools.js"), "utf8");

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

test("compaction handoff prompt tells the next session to use web access for exact technical failures", () => {
  assert.match(indexSource, /use the web access tool to research the exact issue before guessing/);
  assert.match(indexSource, /delegate early: use researcher for sourced web investigation or oracle for a second-opinion diagnosis/);
  assert.match(indexSource, /Do not keep brute-forcing the same exact technical issue in the main session/);
});

test("deferred compaction queue marks the handoff before sending the follow-up prompt", () => {
  const markIndex = indexSource.indexOf("if (!handoffHelpers.markPendingRalphHandoffQueued(ctx, loop.name, true)) {");
  const sendIndex = indexSource.indexOf("await pi.sendUserMessage(prompt, { deliverAs: \"followUp\" });");

  assert.ok(markIndex !== -1);
  assert.ok(sendIndex !== -1);
  assert.ok(markIndex < sendIndex);
});

test("compaction summarizer input and prompt avoid elevating Ralph bookkeeping mismatches into primary work", () => {
  assert.doesNotMatch(indexSource, /currentTaskId: loop\.currentTaskId/);
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

test("session_before_compact stores handoff and deferred hooks queue a tool-call prompt after compaction", () => {
  assert.match(indexSource, /pi\.on\("session_before_compact", async \(event, ctx\) => \{/);
  assert.match(indexSource, /const prepared = await prepareCompactionHandoff\(runtime, event, ctx, pi\);/);
  assert.match(indexSource, /return \{ cancel: true \};/);
  assert.match(indexSource, /analysis = await evaluateRecoverySummaryWithSubagent\(pi, summarizerInput, \{ timeoutMs: DEFAULT_JUDGE_TIMEOUT_MS \}\);/);
  assert.match(indexSource, /const handoff = handoffHelpers\.ensurePendingRalphHandoff\(ctx, loop\.name, handoffPrompt, "compaction"\);/);
  assert.match(indexSource, /stored for .*it will dispatch after compaction completes/);
  assert.match(indexSource, /ralph_handoff/);
  assert.doesNotMatch(indexSource, /loopName: "\$\{loopName\}"/);
  assert.match(indexSource, /Do not continue normal work in this session before calling that tool\./);
  assert.match(indexSource, /async function maybeQueueDeferredCompactionHandoff\(ctx: any, pi: ExtensionAPI, trigger: string\): Promise<void>/);
  assert.match(indexSource, /pi\.on\("session_compact", async \(_event, ctx\) => \{/);
  assert.match(indexSource, /await maybeQueueDeferredCompactionHandoff\(ctx, pi, "session_compact"\);/);
  assert.match(indexSource, /if \(!handoffHelpers\.markPendingRalphHandoffQueued\(ctx, loop\.name, true\)\) \{/);
  assert.match(indexSource, /await pi\.sendUserMessage\(prompt, \{ deliverAs: "followUp" \}\);/);
  assert.match(indexSource, /compaction handoff deferred-queue complete/);
});

test("queued handoff turns log provider and tool-call lifecycle", () => {
  assert.match(indexSource, /function isCompactionHandoffToolPrompt\(prompt: string\): boolean/);
  assert.match(indexSource, /handoff-turn before_agent_start/);
  assert.match(indexSource, /handoff-turn agent_start/);
  assert.match(indexSource, /handoff-turn provider_response/);
  assert.match(indexSource, /handoff-turn tool_call/);
  assert.match(indexSource, /handoff-turn tool_result/);
  assert.match(indexSource, /handoff-turn agent_end/);
  assert.match(toolsSource, /function getSessionControlCtx\(ctx\)/);
});
