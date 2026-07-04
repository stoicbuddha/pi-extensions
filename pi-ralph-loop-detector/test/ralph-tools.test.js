import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const source = fs.readFileSync(path.join(import.meta.dirname, "..", "ralph-tools.js"), "utf8");

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
  assert.match(source, /const PROMPT_TASK_WINDOW = 3;/);
  assert.match(source, /function truncateForPrompt\(text, maxChars = PROMPT_FIELD_MAX_CHARS\)/);
  assert.match(source, /buildTaskWindow\(loop, PROMPT_TASK_WINDOW\)\.filter\(\(task\) => task\?\.id !== nextTask\?\.id\)/);
  assert.match(source, /## Workspace Overlay/);
  assert.match(source, /`\.\/RALPH\.md` was found\. Its full contents will be injected into hidden system context for this turn\./);
  assert.match(source, /console\.info\(`\[ralph\] prompt dispatch mode=\$\{mode\} loop=\$\{loop\?\.name \?\? "unknown"\} iteration=\$\{loop\?\.iteration \?\? "\?"\} chars=\$\{promptChars\}`\);/);
});

test("managed Ralph system prompt is replaced instead of appended repeatedly", () => {
  assert.match(source, /const RALPH_CONTEXT_START = "<!-- RALPH_LOOP_CONTEXT_START -->";/);
  assert.match(source, /const RALPH_CONTEXT_END = "<!-- RALPH_LOOP_CONTEXT_END -->";/);
  assert.match(source, /function stripManagedRalphContext\(systemPrompt\)/);
  assert.match(source, /const cleanBasePrompt = stripManagedRalphContext\(basePrompt\);/);
  assert.match(source, /const managedPrompt = buildManagedRalphSystemPrompt\(loop, overlay\);/);
});

test("persists and dispatches pending Ralph handoffs through a dedicated command", () => {
  assert.match(source, /pending_handoff INTEGER NOT NULL DEFAULT 0/);
  assert.match(source, /pending_handoff_prompt TEXT/);
  assert.match(source, /pending_handoff_generation INTEGER NOT NULL DEFAULT 0/);
  assert.match(source, /export function ensurePendingRalphHandoff\(ctx, loopName, handoffPrompt, reason = "compaction"\)/);
  assert.match(source, /export async function dispatchPendingRalphHandoff\(pi, ctx, loopName\)/);
  assert.match(source, /registerCommand\(pi, "ralph-handoff-now", async \(args, ctx\) => \{/);
  assert.match(source, /const pending = getPendingRalphHandoff\(ctx, loopName\);/);
  assert.match(source, /const result = await dispatchPendingRalphHandoff\(pi, ctx, pending\.loop\.name\);/);
});

test("pending handoff suppresses normal Ralph iteration dispatch", () => {
  assert.match(source, /if \(loop\.pendingHandoff\) \{\s+logPromptDispatch\(loop, "next\/skipped-pending-handoff", ""\);\s+return false;\s+\}/s);
  assert.match(source, /if \(loop\.pendingHandoff\) \{\s+logPromptDispatch\(loop, "fresh\/skipped-pending-handoff", ""\);\s+return false;\s+\}/s);
  assert.match(source, /Pending Ralph handoff preserved for \$\{loop\.name\}; skipping in-session iteration dispatch\./);
});
