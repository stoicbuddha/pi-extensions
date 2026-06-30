const assert = require("node:assert/strict");
const test = require("node:test");

const {
	parseReviewArgs,
	buildReviewPrompt,
	DEFAULT_SINGLE_SESSION_PAGE_CHAR_LIMIT,
	MAX_SINGLE_SESSION_PAGE_CHAR_LIMIT,
	buildTranscriptReviewBundleFromSessions,
	buildTranscriptReviewSessionBundleFromSession,
	formatTranscriptReviewBundle,
	formatTranscriptReviewSessionBundle,
} = require("../review-helpers.js");
const fixture = require("./fixtures/review-session.json");

test("parseReviewArgs supports recent, named, and slice-based review targets", () => {
	assert.deepEqual(parseReviewArgs(""), {});
	assert.deepEqual(parseReviewArgs("4"), { limit: 4 });
	assert.deepEqual(parseReviewArgs("session-a session-b"), { sessionIds: ["session-a", "session-b"] });
	assert.deepEqual(parseReviewArgs('--slice around-compaction --window 12 7 "session-a"'), {
		limit: 7,
		sliceKind: "around-compaction",
		windowSize: 12,
		sessionIds: ["session-a"],
	});
});

test("buildReviewPrompt keeps the review turn strict and explicit", () => {
	const prompt = buildReviewPrompt({ sliceKind: "front-of-session" }, ["session-alpha", "session-beta"]);
	assert.match(prompt, /Do not invent issues/);
	assert.match(prompt, /session-alpha, session-beta/);
	assert.match(prompt, /Requested slice: front-of-session/);
});

test("buildReviewPrompt switches to paged instructions for a single session", () => {
	const prompt = buildReviewPrompt({ pageChars: 12, sliceKind: "full-session" }, ["session-alpha"]);
	assert.match(prompt, /one item at a time/);
	assert.match(prompt, /Start with page 0/);
	assert.match(prompt, /Requested page character limit: 12/);
	assert.match(prompt, /Target session: session-alpha/);
});

test("buildReviewPrompt clamps oversized single-session page limits", () => {
	const prompt = buildReviewPrompt({ pageChars: MAX_SINGLE_SESSION_PAGE_CHAR_LIMIT * 3, sliceKind: "full-session" }, ["session-alpha"]);
	assert.match(prompt, new RegExp(`Requested page character limit: ${MAX_SINGLE_SESSION_PAGE_CHAR_LIMIT}`));
	assert.doesNotMatch(prompt, /token budget/);
});

test("buildTranscriptReviewBundleFromSessions preserves raw evidence and slice metadata", () => {
	const fullBundle = buildTranscriptReviewBundleFromSessions({ sliceKind: "full-session" }, [fixture]);
	assert.equal(fullBundle.sessionIds.length, 1);
	assert.equal(fullBundle.sessions[0].session.id, "session-alpha");
	assert.equal(fullBundle.sessions[0].messages.length, 5);
	assert.equal(fullBundle.slices[0].description, "Full session transcript");

	const frontBundle = buildTranscriptReviewBundleFromSessions({ sliceKind: "front-of-session", windowSize: 3 }, [fixture]);
	assert.equal(frontBundle.sessions[0].messages.length, 3);
	assert.equal(frontBundle.sessions[0].lifecycleEvents.length, 1);
	assert.equal(frontBundle.sessions[0].lifecycleEvents[0].kind, "session_start");

	const compactedBundle = buildTranscriptReviewBundleFromSessions({ sliceKind: "around-compaction", windowSize: 5 }, [fixture]);
	assert.equal(compactedBundle.sessions[0].messages.length, 3);
	assert.equal(compactedBundle.sessions[0].lifecycleEvents.some((event) => event.kind === "session_before_compact"), true);
	assert.equal(compactedBundle.sessions[0].annotations.length, 1);
	assert.equal(compactedBundle.sessions[0].metrics.length, 0);
});

test("formatTranscriptReviewBundle renders the raw bundle payload", () => {
	const bundle = buildTranscriptReviewBundleFromSessions({ sliceKind: "full-session" }, [fixture]);
	const output = formatTranscriptReviewBundle(bundle);
	assert.match(output, /Slice kind: full-session/);
	assert.match(output, /session-alpha/);
	assert.match(output, /good-recovery/);
	assert.match(output, /"toolName":"read_file"/);
});

test("paged single-session bundles expose timeline events and cursors", () => {
	const bundle = buildTranscriptReviewSessionBundleFromSession(fixture, { page: 0, pageChars: DEFAULT_SINGLE_SESSION_PAGE_CHAR_LIMIT });
	assert.equal(bundle.session.id, "session-alpha");
	assert.equal(bundle.page.page, 0);
	assert.equal(bundle.page.pageCharLimit, DEFAULT_SINGLE_SESSION_PAGE_CHAR_LIMIT);
	assert.equal(bundle.page.pageSize, DEFAULT_SINGLE_SESSION_PAGE_CHAR_LIMIT);
	assert.equal(bundle.page.maxPageCharLimit, MAX_SINGLE_SESSION_PAGE_CHAR_LIMIT);
	assert.equal(bundle.page.maxPageSize, MAX_SINGLE_SESSION_PAGE_CHAR_LIMIT);
	assert.equal(bundle.page.hasMore, true);
	assert.equal(bundle.page.nextPage, 1);
	assert.equal(bundle.events.length, 1);
	assert.equal(bundle.page.events[0].truncated, false);
	const output = formatTranscriptReviewSessionBundle(bundle);
	assert.match(output, /one item at a time/);
	assert.match(output, /Session: session-alpha/);
	assert.match(output, /"kind":"message"/);
	assert.match(output, new RegExp(`charLimit=${DEFAULT_SINGLE_SESSION_PAGE_CHAR_LIMIT}`));
	assert.match(output, /chars=/);
});

test("paged single-session bundles advance one item at a time with char limits", () => {
	const bundle = buildTranscriptReviewSessionBundleFromSession(fixture, { page: 0, pageChars: 30 });
	assert.equal(bundle.page.page, 0);
	assert.equal(bundle.page.pageCharLimit, 30);
	assert.equal(bundle.page.hasMore, true);
	assert.equal(bundle.page.nextPage, 1);
	assert.ok(bundle.page.eventCount >= 1);
	assert.equal(bundle.page.eventCount, 1);
	assert.ok(bundle.page.charCount <= 30);
	assert.equal(bundle.page.events[0].truncated, true);
	const nextBundle = buildTranscriptReviewSessionBundleFromSession(fixture, { page: 1, pageChars: 30 });
	assert.equal(nextBundle.page.page, 1);
	assert.notEqual(nextBundle.page.startIndex, bundle.page.startIndex);
});
