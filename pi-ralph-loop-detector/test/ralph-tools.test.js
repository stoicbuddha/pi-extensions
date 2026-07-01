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
  assert.match(source, /loop\.lastDoneReminderAt = loop\.iteration;/);
  assert.match(source, /call the actual ralph_done tool now using the tool interface/);
});
