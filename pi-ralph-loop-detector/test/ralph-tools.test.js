import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildCompactionHandoffMessage } from "../ralph-tools.js";

const source = fs.readFileSync(path.join(import.meta.dirname, "..", "ralph-tools.js"), "utf8");
const bridgeSource = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "subagent-bridge.js"), "utf8");
const indexSource = fs.readFileSync(path.join(import.meta.dirname, "..", "index.ts"), "utf8");

test("does not register ralph_start as an agent tool", () => {
  assert.equal(source.includes('name: "ralph_start"'), false);
  assert.match(source, /name: "ralph_get_plan"/);
});

test("/ralph start routes existing loops through resume behavior", () => {
  assert.match(source, /const existing = getCurrentLoop\(store, parsed\.name\);/);
  assert.match(source, /if \(existing\) \{\s+updateLoopFromArgs\(existing, parsed\);\s+await resumeLoop\(pi, ctx, store, existing\);/s);
  assert.match(source, /if \(!hasRemainingTaskWork\(loop\)\) \{\s+setStatus\(loop, "completed"\);/s);
});

test("/ralph resume resolves paused or selected loops without active-loop fallback", () => {
  assert.match(source, /function getResumeLoop\(store, ctx, loopName\) \{/);
  assert.match(source, /if \(store\.selectedLoopName\) \{\s+const selected = store\.loops\.find\(\(loop\) => loop\.name === store\.selectedLoopName\) \?\? null;\s+if \(selected\) return selected;\s+\}/s);
  assert.match(source, /return store\.loops\.find\(\(loop\) => loop\.status === "paused"\)\s+\?\? store\.loops\.find\(\(loop\) => loop\.status === "active"\)\s+\?\? store\.loops\[0\]\s+\?\? null;/s);
  assert.match(source, /const loop = getResumeLoop\(store, ctx, name \|\| undefined\);/);
  assert.match(source, /if \(loop\.status === "completed"\) \{/);
});

test("exports Ralph stop steering for natural assistant stops", () => {
  assert.match(source, /export async function maybeDispatchStoppedLoopSteering\(ctx, pi, options = \{\}\)/);
  assert.match(source, /if \(stopReason !== "stop"\) return false;/);
  assert.match(source, /const loop = getSessionActiveRalphLoop\(ctx\);/);
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
  assert.match(source, /Graphify bootstrap unavailable/);
  assert.match(source, /Do not invent a wide discovery plan unless that context is missing or contradicted/);
  assert.match(source, /## Workspace Overlay/);
  assert.match(source, /`\.\/RALPH\.md` was found\. Its full contents will be injected into hidden system context for this turn\./);
  assert.match(source, /\[Handoff prompt still exceeded the safety cap\. Use Ralph tools for the remaining context\.\]/);
  assert.match(source, /debugLog\(`\[ralph\] prompt dispatch mode=\$\{mode\} loop=\$\{loop\?\.name \?\? "unknown"\} iteration=\$\{loop\?\.iteration \?\? "\?"\} chars=\$\{promptChars\}`\);/);
});

test("task selection ignores currentTaskId and uses first unfinished task", () => {
  assert.match(source, /function hasRemainingTaskWork\(loop\) \{\s+return Boolean\(selectNextTask\(loop\)\);\s+\}/s);
  assert.match(source, /function selectActiveTask\(loop\) \{\s+return selectNextTask\(loop\);\s+\}/s);
  assert.match(source, /const currentTask = selectActiveTask\(loop\);/);
  assert.match(source, /`Current task: \$\{currentTask\?\.id \?\? "none"\}`/);
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
  assert.match(source, /export function primeActiveTaskGraphifyContext\(ctx, loopName\)/);
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
  assert.match(source, /function buildDefaultGraphifyPlan\(loop, task\)/);
  assert.match(source, /What files, modules, and entry points are most relevant to/);
  assert.match(source, /wired through the codebase\? Include callers, handlers, routes, and tests/);
  assert.match(source, /function ensureTaskGraphifyContext\(ctx, store, loop, task\)/);
  assert.match(source, /graphify graph not found; skipped preplanned graph context/);
  assert.match(source, /spawnSync\("graphify", args/);
  assert.match(source, /metadata: Type\.Optional\(TASK_METADATA_PARAMETER\)/);
});

test("compact plan summary includes actionable task context", () => {
  assert.match(source, /Task counts: todo \$\{counts\.todo\}, in_progress \$\{counts\.in_progress\}, blocked \$\{counts\.blocked\}, done \$\{counts\.done\}, cancelled \$\{counts\.cancelled\}/);
  assert.match(source, /## Current Task/);
  assert.match(source, /## Verification Target/);
  assert.match(source, /## Active Task Contract/);
  assert.match(source, /## Recent Verification/);
  assert.match(source, /## Tasks/);
});

test("ralph_done resolves the running loop through session hints", () => {
  assert.match(source, /const sessionLoopHints = new Map\(\);/);
  assert.match(source, /const sessionActiveLoops = new Map\(\);/);
  assert.match(source, /function rememberLoopHint\(ctx, loopName\)/);
  assert.match(source, /function rememberActiveLoopSession\(ctx, loopName\)/);
  assert.match(source, /export function getSessionActiveRalphLoop\(ctx\)/);
  assert.match(source, /const loopName = getActiveLoopSessionName\(ctx\);/);
  assert.match(source, /function getCurrentLoopWithHint\(store, ctx, loopName\)/);
  assert.match(source, /const loop = getCurrentLoopWithHint\(store, ctx\);/);
  assert.match(source, /rememberLoopHint\(ctx, loop\.name\);/);
  assert.match(source, /rememberActiveLoopSession\(ctx, loop\?\.name\);/);
  assert.match(source, /rememberActiveLoopSession\(replacementCtx, loop\?\.name\);/);
  assert.match(source, /rememberActiveLoopSession\(ctx, null\);/);
  assert.match(source, /if \(!hasRemainingTaskWork\(loop\)\) \{\s+setStatus\(loop, "completed"\);/s);
  assert.match(source, /All Ralph tasks are complete\. Loop stopped\./);
});

test("recovery summarizer prompt de-emphasizes Ralph bookkeeping mismatches", () => {
  assert.match(bridgeSource, /Do not turn Ralph bookkeeping mismatches, tracker drift, stale currentTaskId values, or note\/plan inconsistencies into primary work items/);
  assert.match(bridgeSource, /Prioritize concrete user-task continuity, recent real code activity, and the next productive engineering step/);
});

test("compaction handoff summarizer input includes current task, task counts, and graph metadata", () => {
  assert.match(indexSource, /function summarizeTaskCounts\(loop: any\)/);
  assert.match(indexSource, /function summarizeTaskMetadata\(task: any\)/);
  assert.match(indexSource, /currentTask: summarizeTaskForHandoff\(activeTask\)/);
  assert.match(indexSource, /taskCounts,/);
  assert.match(indexSource, /openTasks,/);
  assert.match(indexSource, /recentlyCompletedTasks,/);
  assert.match(indexSource, /handoffHelpers\.primeActiveTaskGraphifyContext\(ctx, loop\.name\);/);
});

test("pending handoff suppresses normal Ralph iteration dispatch", () => {
  assert.match(source, /if \(loop\.pendingHandoff\) \{\s+logPromptDispatch\(loop, "next\/skipped-pending-handoff", ""\);\s+return false;\s+\}/s);
  assert.match(source, /if \(loop\.pendingHandoff\) \{\s+logPromptDispatch\(loop, "fresh\/skipped-pending-handoff", ""\);\s+return false;\s+\}/s);
  assert.match(source, /logPromptDispatch\(currentLoop, "next\/completed-no-active-task", ""\);/);
  assert.match(source, /logPromptDispatch\(currentLoop, "fresh\/completed-no-active-task", ""\);/);
  assert.match(source, /Pending Ralph handoff preserved for \$\{loop\.name\}; skipping in-session iteration dispatch\./);
  assert.match(source, /Next iteration will continue via pending Ralph compaction handoff\./);
  assert.match(source, /Paused after ralph_done because fresh-context dispatch failed/);
  assert.match(source, /Paused after ralph_done because follow-up dispatch failed/);
  assert.match(source, /## Active Task Momentum/);
});

test("compaction handoff message renders continuity delta once and preserves prior-session continuity", () => {
  const prompt = buildCompactionHandoffMessage(
    {
      name: "rust-store-mvp-v1",
      status: "active",
      iteration: 49,
      maxIterations: 300,
      summary: "Build the Rust store MVP.",
      tasks: [
        {
          id: "task-28",
          title: "Issue the auth cookie after successful login",
          status: "todo",
          details: "Add secure cookie issuance and a verification test.",
          evidence: ["Session row creation already works."],
          notes: ["Cookie flags still need to be centralized."],
        },
        {
          id: "task-27",
          title: "Add DB-backed session creation on successful login",
          status: "done",
        },
      ],
      verification: [{ text: "Added DB-backed session creation before redirect." }],
      notes: [{ text: "Summary is too generic and duplicates the state dump." }],
      reflections: [{ text: "Need prior-session thoughts in the handoff." }],
    },
    [
      'Ralph compaction handoff for loop "rust-store-mvp-v1" at iteration 49/300.',
      "",
      "Pi skipped compaction and created a fresh session for this Ralph loop.",
      "",
      "## Prior Session Continuity",
      "- Last assistant thought: pull thoughts from the parent session instead of repeating the task list.",
      "",
      "## Continuity Delta",
      "The agent had already completed DB-backed session creation and was moving to cookie issuance. The handoff should carry over the prior-session thought about avoiding duplicated summaries.",
      "",
      "## Why Fresh Context Was Needed",
      "Repeated summary formatting produced low-signal handoffs.",
      "",
      "## Next Steps",
      "- Add cookie issuance with centralized flags.",
    ].join("\n"),
  );

  assert.match(prompt, /## Prior Session Continuity/);
  assert.match(prompt, /pull thoughts from the parent session/);
  assert.match(prompt, /## Continuity Delta/);
  assert.equal((prompt.match(/## Continuity Delta/g) ?? []).length, 1);
  assert.doesNotMatch(prompt, /## Handoff Summary/);
});
