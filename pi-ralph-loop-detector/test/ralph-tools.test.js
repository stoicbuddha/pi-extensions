import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const source = fs.readFileSync(path.join(import.meta.dirname, "..", "ralph-tools.js"), "utf8");
const bridgeSource = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "subagent-bridge.js"), "utf8");

test("does not register ralph_start as an agent tool", () => {
  assert.equal(source.includes('name: "ralph_start"'), false);
  assert.match(source, /name: "ralph_get_plan"/);
});

test("/ralph start routes existing loops through resume behavior", () => {
  assert.match(source, /const existing = getCurrentLoop\(store, parsed\.name\);/);
  assert.match(source, /if \(existing\) \{\s+updateLoopFromArgs\(existing, parsed\);\s+await resumeLoop\(pi, ctx, store, existing\);/s);
});

test("exports Ralph stop steering for natural assistant stops", () => {
  assert.match(source, /export async function maybeDispatchStoppedLoopSteering\(ctx, pi, options = \{\}\)/);
  assert.match(source, /if \(stopReason !== "stop"\) return false;/);
  assert.match(source, /if \(loop\.pendingHandoff\) return false;/);
  assert.match(source, /loop\.lastDoneReminderAt = loop\.iteration;/);
  assert.match(source, /call the actual ralph_done tool now using the tool interface/);
});

test("iteration prompt avoids duplicating next task and caps prompt fields", () => {
  assert.match(source, /const PROMPT_MAX_CHARS = 7000;/);
  assert.match(source, /const HANDOFF_PROMPT_MAX_CHARS = 18000;/);
  assert.match(source, /const PROMPT_TASK_WINDOW = 3;/);
  assert.match(source, /function truncateForPrompt\(text, maxChars = PROMPT_FIELD_MAX_CHARS\)/);
  assert.match(source, /function trimHandoffSection\(text, maxChars\)/);
  assert.match(source, /function isQueuedCompactionHandoffPrompt\(prompt\)/);
  assert.match(source, /## Verification Target/);
  assert.match(source, /## Active Task Contract/);
  assert.match(source, /## Relevant Graph Context/);
  assert.match(source, /Use this task-scoped Graphify context first/);
  assert.match(source, /Do not invent a wide discovery plan unless that context is missing or contradicted/);
  assert.match(source, /## Workspace Overlay/);
  assert.match(source, /`\.\/RALPH\.md` was found\. Its full contents will be injected into hidden system context for this turn\./);
  assert.match(source, /\[Handoff prompt still exceeded the safety cap\. Use Ralph tools for the remaining context\.\]/);
  assert.match(source, /debugLog\(`\[ralph\] prompt dispatch mode=\$\{mode\} loop=\$\{loop\?\.name \?\? "unknown"\} iteration=\$\{loop\?\.iteration \?\? "\?"\} chars=\$\{promptChars\}`\);/);
});

test("managed Ralph system prompt is replaced instead of appended repeatedly", () => {
  assert.match(source, /const RALPH_CONTEXT_START = "<!-- RALPH_LOOP_CONTEXT_START -->";/);
  assert.match(source, /const RALPH_CONTEXT_END = "<!-- RALPH_LOOP_CONTEXT_END -->";/);
  assert.match(source, /function stripManagedRalphContext\(systemPrompt\)/);
  assert.match(source, /before_agent_start handoff-tool-turn/);
  assert.match(source, /const cleanBasePrompt = stripManagedRalphContext\(basePrompt\);/);
  assert.match(source, /const managedPrompt = buildManagedRalphSystemPrompt\(loop, overlay\);/);
});

test("persists and dispatches pending Ralph handoffs through dedicated tooling", () => {
  assert.match(source, /pending_handoff INTEGER NOT NULL DEFAULT 0/);
  assert.match(source, /pending_handoff_prompt TEXT/);
  assert.match(source, /pending_handoff_generation INTEGER NOT NULL DEFAULT 0/);
  assert.match(source, /export function ensurePendingRalphHandoff\(ctx, loopName, handoffPrompt, reason = "compaction"\)/);
  assert.match(source, /export async function dispatchPendingRalphHandoff\(pi, ctx, loopName\)/);
  assert.match(source, /registerCommand\(pi, "ralph-handoff-now", async \(args, ctx\) => \{/);
  assert.match(source, /name: "ralph_handoff"/);
  assert.match(source, /tool ralph_handoff start requestedLoop=/);
  assert.match(source, /tool ralph_handoff complete loop=/);
  assert.match(source, /const pending = getPendingRalphHandoff\(ctx, loopName\);/);
  assert.match(source, /const result = await dispatchPendingRalphHandoff\(pi, ctx, pending\.loop\.name\);/);
});

test("task metadata persists graphify plans and cached graph context", () => {
  assert.match(source, /meta_json TEXT/);
  assert.match(source, /function ensureTaskColumns\(db\)/);
  assert.match(source, /function normalizeTaskMetadata\(input\)/);
  assert.match(source, /function ensureTaskGraphifyContext\(ctx, store, loop, task\)/);
  assert.match(source, /graphify graph not found; skipped preplanned graph context/);
  assert.match(source, /spawnSync\("graphify", args/);
  assert.match(source, /metadata: Type\.Optional\(TASK_METADATA_PARAMETER\)/);
});

test("ralph_done resolves the running loop through session hints", () => {
  assert.match(source, /const sessionLoopHints = new Map\(\);/);
  assert.match(source, /function rememberLoopHint\(ctx, loopName\)/);
  assert.match(source, /function getCurrentLoopWithHint\(store, ctx, loopName\)/);
  assert.match(source, /const loop = getCurrentLoopWithHint\(store, ctx\);/);
  assert.match(source, /rememberLoopHint\(ctx, loop\.name\);/);
});

test("recovery summarizer prompt de-emphasizes Ralph bookkeeping mismatches", () => {
  assert.match(bridgeSource, /Do not turn Ralph bookkeeping mismatches, tracker drift, stale currentTaskId values, or note\/plan inconsistencies into primary work items/);
  assert.match(bridgeSource, /Prioritize concrete user-task continuity, recent real code activity, and the next productive engineering step/);
});

test("pending handoff suppresses normal Ralph iteration dispatch", () => {
  assert.match(source, /if \(loop\.pendingHandoff\) \{\s+logPromptDispatch\(loop, "next\/skipped-pending-handoff", ""\);\s+return false;\s+\}/s);
  assert.match(source, /if \(loop\.pendingHandoff\) \{\s+logPromptDispatch\(loop, "fresh\/skipped-pending-handoff", ""\);\s+return false;\s+\}/s);
  assert.match(source, /Pending Ralph handoff preserved for \$\{loop\.name\}; skipping in-session iteration dispatch\./);
  assert.match(source, /Next iteration will continue via pending Ralph compaction handoff\./);
  assert.match(source, /Paused after ralph_done because fresh-context dispatch failed/);
  assert.match(source, /Paused after ralph_done because follow-up dispatch failed/);
});
