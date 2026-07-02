import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const source = fs.readFileSync(path.join(import.meta.dirname, "..", "index.ts"), "utf8");

test("does not register ralph_start as an agent tool", () => {
	assert.equal(source.includes('name: "ralph_start"'), false);
});

test("/ralph start restores existing Ralph state before creating a new default plan", () => {
	assert.match(source, /const existing = loadState\(ctx, loopName\) \?\? restoreLoopStateFromPlan\(ctx, loopName, args\);/);
	assert.match(source, /if \(existing\) \{\s+applyLoopArgs\(existing, args\);\s+saveState\(ctx, existing\);\s+await resumeLoopByName\(ctx, loopName\);\s+return;\s+\}/s);
});

test("archived state lookup is respected when restoring loops", () => {
	assert.match(source, /return stateFromDb\(db, name, archived\);/);
	assert.match(source, /const archived = loadState\(ctx, loopName, true\);/);
});

test("marking a task done advances the iteration and queues the reset prompt", () => {
	assert.match(source, /if \(action === "done" && !wasDone && result\.state\.status === "active"\) \{\s+void advanceLoopIteration\(ctx, result\.state, "ralph_task_done"\)/s);
	assert.match(source, /if \(params\.status === "done" && previousStatus !== "done" && result\.state\.status === "active"\) \{\s+const message = await advanceLoopIteration\(ctx, result\.state, "ralph_task_done"\)/s);
	assert.match(source, /dispatchNextIterationResetFollowUp\(ctx, state, content, needsReflection\);/);
});
