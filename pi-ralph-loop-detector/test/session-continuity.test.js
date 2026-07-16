import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readSessionHeader, summarizeParentSessionContinuity } from "../session-continuity.js";

function writeSessionFile(filePath, records) {
  fs.writeFileSync(filePath, records.map((record) => JSON.stringify(record)).join("\n"), "utf8");
}

test("summarizeParentSessionContinuity follows the parentSession chain and extracts last-session thoughts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-session-continuity-"));
  try {
    const parentFile = path.join(dir, "parent.jsonl");
    const currentFile = path.join(dir, "current.jsonl");
    writeSessionFile(parentFile, [
      {
        type: "session",
        version: 3,
        id: "parent-session",
        timestamp: "2026-07-10T10:00:00.000Z",
        cwd: "/repo",
      },
      {
        type: "custom_message",
        customType: "ralph-iteration",
        content: "🔄 RALPH LOOP\n\nRecent Reflections\n- Cookie issuance is next; summary is still weak.",
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: "I should pull the last session thoughts into the next handoff instead of restating task titles.",
        },
      },
      {
        type: "message",
        message: {
          role: "user",
          content: "Fix the duplicated handoff summary.",
        },
      },
    ]);
    writeSessionFile(currentFile, [
      {
        type: "session",
        version: 3,
        id: "current-session",
        timestamp: "2026-07-10T10:05:00.000Z",
        cwd: "/repo",
        parentSession: parentFile,
      },
    ]);

    const summary = summarizeParentSessionContinuity(currentFile, { expectedCwd: "/repo" });

    assert.ok(summary);
    assert.equal(summary.id, "parent-session");
    assert.match(summary.latestRalphIteration ?? "", /Cookie issuance is next/);
    assert.match(summary.lastAssistantMessage ?? "", /pull the last session thoughts/);
    assert.match(summary.lastUserMessage ?? "", /duplicated handoff summary/);
    assert.equal(summary.currentSessionFile, currentFile);
    assert.equal(summary.sourceSessionFile, parentFile);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("summarizeParentSessionContinuity ignores parents from a different cwd", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-session-continuity-"));
  try {
    const parentFile = path.join(dir, "parent.jsonl");
    const currentFile = path.join(dir, "current.jsonl");
    writeSessionFile(parentFile, [
      {
        type: "session",
        version: 3,
        id: "parent-session",
        timestamp: "2026-07-10T10:00:00.000Z",
        cwd: "/other-repo",
      },
    ]);
    writeSessionFile(currentFile, [
      {
        type: "session",
        version: 3,
        id: "current-session",
        timestamp: "2026-07-10T10:05:00.000Z",
        cwd: "/repo",
        parentSession: parentFile,
      },
    ]);

    const summary = summarizeParentSessionContinuity(currentFile, { expectedCwd: "/repo" });
    assert.equal(summary, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readSessionHeader returns the session envelope metadata", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-session-continuity-"));
  try {
    const file = path.join(dir, "session.jsonl");
    writeSessionFile(file, [
      {
        type: "session",
        version: 3,
        id: "session-id",
        timestamp: "2026-07-10T10:05:00.000Z",
        cwd: "/repo",
        parentSession: "/tmp/parent.jsonl",
      },
      { type: "message", message: { role: "assistant", content: "hello" } },
    ]);

    const header = readSessionHeader(file);
    assert.deepEqual(header, {
      id: "session-id",
      cwd: "/repo",
      timestamp: "2026-07-10T10:05:00.000Z",
      parentSession: "/tmp/parent.jsonl",
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
