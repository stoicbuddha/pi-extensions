import test from "node:test";
import assert from "node:assert/strict";

import { LoopDetector, createEvidencePacket } from "../src/index.js";

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
  assert.equal(outcome.intervention.type, "stop");
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
    type: "tool_result",
    toolName: "rollback_status",
    args: {},
    ok: false,
    progress: false,
    result: "failed",
  });
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

test("does not treat ordinary prose as a tool declaration", async () => {
  const detector = new LoopDetector();

  await detector.handleEvent({
    type: "assistant_message",
    content: "Use a clear, professional tone suitable for an agent evaluation.",
  });
  await detector.handleEvent({
    type: "tool_call",
    toolName: "ToolkitMCP_create_file",
    args: { path: "ONBOARDING_PROPOSAL.md" },
  });
  await detector.handleEvent({
    type: "tool_result",
    toolName: "ToolkitMCP_create_file",
    args: { path: "ONBOARDING_PROPOSAL.md" },
    ok: true,
    progress: true,
    result: { created: true, ok: true },
  });
  await detector.handleEvent({
    type: "assistant_message",
    content: "Ensure technical details like Argon2id are accurate based on the current code inspection.",
  });
  const outcome = await detector.handleEvent({
    type: "tool_call",
    toolName: "ToolkitMCP_create_file",
    args: { path: "ONBOARDING_PROPOSAL.md" },
  });

  assert.equal(outcome, null);
});

test("does not trigger intent mismatch when the alternate tool makes progress", async () => {
  const detector = new LoopDetector();

  await detector.handleEvent({
    type: "assistant_message",
    content: "I should call `ralph_done` now.",
  });
  await detector.handleEvent({ type: "tool_call", toolName: "ToolkitMCP_create_file", args: { path: "a.md" } });
  await detector.handleEvent({
    type: "tool_result",
    toolName: "ToolkitMCP_create_file",
    args: { path: "a.md" },
    ok: true,
    progress: true,
    result: { created: true },
  });
  await detector.handleEvent({
    type: "assistant_message",
    content: "Let me call `ralph_done` next.",
  });
  const outcome = await detector.handleEvent({
    type: "tool_call",
    toolName: "ToolkitMCP_create_file",
    args: { path: "a.md" },
  });

  assert.equal(outcome, null);
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

test("detects repeated successful status command during self-correction loop", async () => {
  const detector = new LoopDetector({
    sameTool: { enabled: false },
    intentMismatch: { mismatchThreshold: 99 },
    selfCorrection: { minCorrections: 2, minRepeatedCalls: 2 },
  });

  const content = `I keep running the same command. Let me actually execute a bash script to modify all files at once.

The approach:
1. Stash current uncommitted changes
2. Use bash to write all three files atomically
3. Run cargo check to verify`;

  let outcome = null;
  for (let index = 0; index < 3; index += 1) {
    outcome =
      (await detector.handleEvent({ type: "assistant_message", content })) ?? outcome;
    outcome =
      (await detector.handleEvent({
        type: "tool_call",
        toolName: "ToolKitMCP_git_status",
        args: { args: ["--short"] },
      })) ?? outcome;
    outcome =
      (await detector.handleEvent({
        type: "tool_result",
        toolName: "ToolKitMCP_git_status",
        args: { args: ["--short"] },
        ok: true,
        progress: true,
        result: "program: git\nexit_code: 0",
      })) ?? outcome;
  }

  assert.equal(outcome.trigger.kind, "self_correction_loop");
  assert.equal(outcome.intervention.offendingTool, "ToolKitMCP_git_status");
});

test("detects repeated assistant tool result cycles with successful low-information output", async () => {
  const detector = new LoopDetector({
    sameTool: { enabled: false },
    failureRepetition: { minFailures: 99 },
    selfCorrection: { minCorrections: 99 },
    tools: {
      ToolKitMCP_cargo_clean: { sameCycleRepeats: 2 },
    },
  });

  const plan = `I need to fix the compilation issues in this Ralph loop iteration. Let me apply all necessary changes atomically using a bash script since str_replace validates against partial state.

The 4 errors are:
1. db.rs:211 - Tuple expects 12 elements but destructuring has only 10
2. db.rs:293 - Tuple expects 12 elements but destructuring has only 11
3. dashboard.rs:19 - Askama can't use String as boolean primitive
4. dashboard.rs:137 - Non-exhaustive pattern match`;

  let outcome = null;
  for (let index = 0; index < 2; index += 1) {
    await detector.handleEvent({ type: "assistant_message", content: plan });
    await detector.handleEvent({
      type: "tool_call",
      toolName: "ToolKitMCP_cargo_clean",
      args: { args: [] },
    });
    outcome = await detector.handleEvent({
      type: "tool_result",
      toolName: "ToolKitMCP_cargo_clean",
      args: { args: [] },
      ok: true,
      progress: true,
      result: { program: "cargo", exit_code: 0, stdout: "", stderr: "" },
    });
  }

  assert.equal(outcome.trigger.kind, "cycle_repetition");
  assert.equal(outcome.intervention.offendingTool, "ToolKitMCP_cargo_clean");
});

test("detects repeated long assistant messages even without tool calls", async () => {
  const detector = new LoopDetector({
    assistantRepetition: { minRepeats: 3, minNormalizedChars: 40 },
  });
  const message = "I am going to repeat this same long planning paragraph without taking a materially different action.";

  await detector.handleEvent({ type: "assistant_message", content: message });
  await detector.handleEvent({ type: "assistant_message", content: message });
  const outcome = await detector.handleEvent({ type: "assistant_message", content: message });

  assert.equal(outcome.trigger.kind, "assistant_repetition");
});

test("does not flag short repeated assistant acknowledgements", async () => {
  const detector = new LoopDetector();

  await detector.handleEvent({ type: "assistant_message", content: "Done." });
  await detector.handleEvent({ type: "assistant_message", content: "Done." });
  const outcome = await detector.handleEvent({ type: "assistant_message", content: "Done." });

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
    selfCorrection: { minCorrections: 99 },
    tools: {
      ToolKitMCP_apply_edit_plan: { sameToolRepeats: 99 },
    },
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

test("detects repeated edit-plan path failures with self-correction narration", async () => {
  const detector = new LoopDetector({
    sameTool: { minRepeats: 99 },
    selfCorrection: { minCorrections: 99 },
    tools: {
      ToolKitMCP_apply_edit_plan: { sameToolRepeats: 99 },
    },
  });

  const messages = [
    "I keep making the SAME error with /tmp paths! Let me stop and think clearly.",
    "I keep making the exact same mistake! Let me stop and read the instructions one more time very carefully.",
    "I keep making this exact same mistake with /tmp paths! Let me stop and think clearly about what I need to do here.",
  ];

  let outcome = null;
  for (const [index, content] of messages.entries()) {
    outcome = (await detector.handleEvent({ type: "assistant_message", content })) ?? outcome;
    outcome = (await detector.handleEvent({
      type: "tool_call",
      toolName: "ToolKitMCP_apply_edit_plan",
      args: {
        edits: [
          {
            op: "create_file",
            path: "/tmp/dbfix.rs",
            content: "impl DashboardEmail {}",
          },
        ],
      },
    })) ?? outcome;
    outcome = (await detector.handleEvent({
      type: "tool_result",
      toolName: "ToolKitMCP_apply_edit_plan",
      args: {
        edits: [
          {
            op: "create_file",
            path: "/tmp/dbfix.rs",
          },
        ],
      },
      ok: false,
      result: "apply_edit_plan entry for '/tmp/dbfix.rs' failed: 'path' must be relative to project cwd",
    })) ?? outcome;
  }

  assert.equal(outcome.trigger.kind, "failure_repetition");
  assert.equal(outcome.intervention.offendingTool, "ToolKitMCP_apply_edit_plan");
});

test("detects self-correction loop", async () => {
  const detector = new LoopDetector({
    sameTool: { minRepeats: 99 },
    failureRepetition: { minFailures: 99 },
    selfCorrection: { minCorrections: 2, minRepeatedCalls: 2 },
  });

  await detector.handleEvent({
    type: "assistant_message",
    content: "I keep doing the wrong thing. Let me correct that.",
  });
  await detector.handleEvent({ type: "tool_call", toolName: "rollback_status", args: {} });
  await detector.handleEvent({
    type: "tool_result",
    toolName: "rollback_status",
    args: {},
    ok: false,
    result: "same status as before",
  });
  await detector.handleEvent({
    type: "assistant_message",
    content: "I need to stop calling rollback_status.",
  });
  let outcome = await detector.handleEvent({
    type: "tool_call",
    toolName: "rollback_status",
    args: {},
  });
  outcome = (await detector.handleEvent({
    type: "tool_result",
    toolName: "rollback_status",
    args: {},
    ok: false,
    result: "same status as before",
  })) ?? outcome;

  assert.equal(outcome.trigger.kind, "self_correction_loop");
});

test("does not trigger while assistant is still attempting a short self-correction recovery", async () => {
  const detector = new LoopDetector({
    sameTool: { minRepeats: 99 },
    failureRepetition: { minFailures: 99 },
  });

  await detector.handleEvent({
    type: "assistant_message",
    content: "I need to stop and reassess. The previous command was not enough, so I will inspect the state before changing approach.",
  });
  await detector.handleEvent({ type: "tool_call", toolName: "ToolKitMCP_git_status", args: {} });
  await detector.handleEvent({
    type: "tool_result",
    toolName: "ToolKitMCP_git_status",
    args: {},
    ok: true,
    result: "program: git\nexit_code: 0",
  });
  await detector.handleEvent({
    type: "assistant_message",
    content: "That status output shows I should read the relevant file next instead of repeating edits blindly.",
  });
  const outcome = await detector.handleEvent({ type: "tool_call", toolName: "ToolKitMCP_cat", args: { path: "src/app.rs" } });

  assert.equal(outcome, null);
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
  assert.equal(first.intervention.type, "stop");

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

test("resets loop evidence after an intervention so a follow-up read does not retrigger the same stale loop", async () => {
  const detector = new LoopDetector({
    failureRepetition: { minFailures: 99 },
    selfCorrection: { minCorrections: 99 },
  });

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
  assert.equal(detector.getState().recentEvents.length, 0);

  await detector.handleEvent({
    type: "tool_call",
    toolName: "ToolKitMCP_cat",
    args: { path: "src/app.rs" },
  });
  const retriggered = await detector.handleEvent({
    type: "tool_result",
    toolName: "ToolKitMCP_cat",
    args: { path: "src/app.rs" },
    ok: true,
    result: "read ok",
  });

  assert.equal(retriggered, null);
});

test("uses judge output to choose deterministic intervention", async () => {
  const detector = new LoopDetector({
    judge: async () => ({
      is_loop: true,
      confidence: 0.93,
      reason: "clear loop",
      action: "stop",
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

  assert.equal(outcome.intervention.type, "stop");
  assert.deepEqual(outcome.intervention.blockedTools, ["rollback_status"]);
});

test("compacts large tool arguments in evidence packets", async () => {
  const hugeContent = "x".repeat(50_000);
  const evidence = createEvidencePacket(
    [
      {
        type: "tool_call",
        toolName: "apply_patch",
        args: {
          path: "src/app.js",
          content: hugeContent,
          nested: { transcript: hugeContent },
        },
      },
    ],
    { kind: "same_tool_repetition", offendingTool: "apply_patch" },
  );

  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes(hugeContent), false);
  assert.equal(serialized.includes("[omitted 50000 chars]"), true);
  assert.ok(serialized.length < 2500);
});

test("uses config aliases and tool classes for cycle thresholds", async () => {
  const detector = new LoopDetector({
    sameTool: { enabled: false },
    toolAliases: [{ match: "^Vendor_(.+)$", replace: "$1" }],
    tools: {
      clean_cache: {
        class: "cleanup",
        sameCycleRepeats: 2,
        successCountsAsProgress: false,
      },
    },
  });
  const plan = "I will clear generated state and then continue with a different implementation path after this step.";

  let outcome = null;
  for (let index = 0; index < 2; index += 1) {
    await detector.handleEvent({ type: "assistant_message", content: plan });
    await detector.handleEvent({
      type: "tool_call",
      toolName: "Vendor_clean_cache",
      args: { scope: "all" },
    });
    outcome = await detector.handleEvent({
      type: "tool_result",
      toolName: "Vendor_clean_cache",
      args: { scope: "all" },
      ok: true,
      result: "cache already clear",
    });
  }

  assert.equal(outcome.trigger.kind, "cycle_repetition");
  assert.equal(outcome.evidence.toolCalls.at(-1).toolBaseName, "clean_cache");
  assert.equal(outcome.evidence.toolCalls.at(-1).toolClass, "cleanup");
});

test("uses configured no-progress result patterns", async () => {
  const detector = new LoopDetector({
    tools: {
      inspect_state: {
        class: "write",
        sameToolRepeats: 2,
        noProgressPatterns: ["dry run only"],
      },
    },
  });

  await detector.handleEvent({ type: "tool_call", toolName: "inspect_state", args: { id: 1 } });
  await detector.handleEvent({
    type: "tool_result",
    toolName: "inspect_state",
    args: { id: 1 },
    ok: true,
    result: "dry run only; no update applied",
  });
  const outcome = await detector.handleEvent({
    type: "tool_call",
    toolName: "inspect_state",
    args: { id: 1 },
  });

  assert.equal(outcome.trigger.kind, "same_tool_repetition");
});
