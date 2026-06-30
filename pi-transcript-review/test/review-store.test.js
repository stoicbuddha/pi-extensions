const assert = require("node:assert/strict");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const {
	buildTranscriptReviewBundleFromDb,
	buildTranscriptReviewSessionBundleFromDb,
	resolveReviewSessionIds,
	seedTranscriptDatabase,
} = require("../review-store.js");
const fixture = require("./fixtures/review-session.json");

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function makeTranscript(id, title, startedAt, lastSeenAt, status = "completed") {
	const transcript = clone(fixture);
	transcript.session.id = id;
	transcript.session.title = title;
	transcript.session.startedAt = startedAt;
	transcript.session.lastSeenAt = lastSeenAt;
	transcript.session.status = status;
	transcript.session.endedAt = status === "completed" ? lastSeenAt : null;
	transcript.session.meta.source = id;
	transcript.messages.forEach((row, index) => {
		row.sessionId = id;
		row.createdAt = new Date(new Date(startedAt).getTime() + index * 60_000).toISOString();
	});
	transcript.toolCalls.forEach((row) => {
		row.sessionId = id;
		row.createdAt = new Date(new Date(startedAt).getTime() + 5 * 60_000).toISOString();
		row.finishedAt = new Date(new Date(startedAt).getTime() + 6 * 60_000).toISOString();
	});
	transcript.lifecycleEvents.forEach((row) => {
		row.createdAt = row.kind === "session_before_compact" ? new Date(new Date(startedAt).getTime() + 10 * 60_000).toISOString() : row.kind === "session_shutdown" ? lastSeenAt : startedAt;
	});
	transcript.annotations.forEach((row) => {
		row.targetId = id;
		row.createdAt = new Date(new Date(startedAt).getTime() + 15 * 60_000).toISOString();
	});
	transcript.metrics.forEach((row) => {
		row.createdAt = lastSeenAt;
	});
	return transcript;
}

test("resolveReviewSessionIds prefers recent completed sessions from sqlite", () => {
	const db = new DatabaseSync(":memory:");
	seedTranscriptDatabase(
		db,
		makeTranscript("session-alpha", "Alpha session", "2026-06-28T10:00:00.000Z", "2026-06-28T10:25:00.000Z"),
	);
	seedTranscriptDatabase(
		db,
		makeTranscript("session-beta", "Beta session", "2026-06-28T11:00:00.000Z", "2026-06-28T11:25:00.000Z"),
	);
	seedTranscriptDatabase(
		db,
		makeTranscript("session-active", "Active session", "2026-06-28T12:00:00.000Z", "2026-06-28T12:25:00.000Z", "active"),
	);

	assert.deepEqual(resolveReviewSessionIds(db, {}), ["session-beta", "session-alpha"]);
	assert.deepEqual(resolveReviewSessionIds(db, { sessionIds: ["session-alpha", "session-alpha"] }), ["session-alpha"]);
});

test("buildTranscriptReviewBundleFromDb reads sqlite rows and preserves named targets", () => {
	const db = new DatabaseSync(":memory:");
	seedTranscriptDatabase(
		db,
		makeTranscript("session-alpha", "Alpha session", "2026-06-28T10:00:00.000Z", "2026-06-28T10:25:00.000Z"),
	);
	seedTranscriptDatabase(
		db,
		makeTranscript("session-beta", "Beta session", "2026-06-28T11:00:00.000Z", "2026-06-28T11:25:00.000Z"),
	);

	const defaultBundle = buildTranscriptReviewBundleFromDb(db, {});
	assert.deepEqual(defaultBundle.sessionIds, ["session-beta", "session-alpha"]);
	assert.equal(defaultBundle.sessions[0].session.id, "session-beta");
	assert.equal(defaultBundle.sessions[0].messages.length, 5);

	const namedBundle = buildTranscriptReviewBundleFromDb(db, { sessionIds: ["session-alpha"], sliceKind: "full-session" });
	assert.deepEqual(namedBundle.sessionIds, ["session-alpha"]);
	assert.equal(namedBundle.sessions.length, 1);
	assert.equal(namedBundle.sessions[0].session.title, "Alpha session");
	assert.equal(namedBundle.sessions[0].lifecycleEvents.some((event) => event.kind === "session_before_compact"), true);
});

test("buildTranscriptReviewSessionBundleFromDb pages a single sqlite session", () => {
	const db = new DatabaseSync(":memory:");
	seedTranscriptDatabase(
		db,
		makeTranscript("session-alpha", "Alpha session", "2026-06-28T10:00:00.000Z", "2026-06-28T10:25:00.000Z"),
	);

	const firstPage = buildTranscriptReviewSessionBundleFromDb(db, { sessionId: "session-alpha", page: 0, pageChars: 20 });
	assert.equal(firstPage.session.id, "session-alpha");
	assert.equal(firstPage.page.page, 0);
	assert.equal(firstPage.page.pageCharLimit, 20);
	assert.equal(firstPage.page.hasMore, true);
	assert.equal(firstPage.page.nextPage, 1);
	assert.ok(firstPage.events.length >= 1);
	assert.equal(firstPage.events[0].truncated, true);

	const secondPage = buildTranscriptReviewSessionBundleFromDb(db, { sessionId: "session-alpha", page: 1, pageChars: 20 });
	assert.equal(secondPage.page.page, 1);
	assert.ok(secondPage.events.length >= 1);
	assert.notEqual(secondPage.page.startIndex, firstPage.page.startIndex);
});
