const DEFAULT_SINGLE_SESSION_PAGE_CHAR_LIMIT = 1_000;
const MAX_SINGLE_SESSION_PAGE_CHAR_LIMIT = 16_000;

function parseReviewArgs(rest) {
	const tokens = rest.trim().match(/(?:[^\s"]+|"[^"]*")+/g) || [];
	if (tokens.length === 0) return {};
	const selection = {};
	const sessionIds = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index].replace(/^"|"$/g, "");
		if (token === "--limit" && tokens[index + 1]) {
			const limit = Number.parseInt(tokens[++index].replace(/^"|"$/g, ""), 10);
			if (Number.isFinite(limit)) selection.limit = limit;
			continue;
		}
		if (token === "--slice" && tokens[index + 1]) {
			const sliceKind = tokens[++index].replace(/^"|"$/g, "");
			if (sliceKind === "full-session" || sliceKind === "front-of-session" || sliceKind === "around-compaction") {
				selection.sliceKind = sliceKind;
			}
			continue;
		}
		if (token === "--window" && tokens[index + 1]) {
			const windowSize = Number.parseInt(tokens[++index].replace(/^"|"$/g, ""), 10);
			if (Number.isFinite(windowSize)) selection.windowSize = windowSize;
			continue;
		}
		if ((token === "--page-chars" || token === "--pageChars" || token === "--page-budget" || token === "--pageBudget") && tokens[index + 1]) {
			const pageChars = Number.parseInt(tokens[++index].replace(/^"|"$/g, ""), 10);
			if (Number.isFinite(pageChars)) selection.pageChars = pageChars;
			continue;
		}
		if (token === "--page" && tokens[index + 1]) {
			const page = Number.parseInt(tokens[++index].replace(/^"|"$/g, ""), 10);
			if (Number.isFinite(page)) selection.page = page;
			continue;
		}
		if ((token === "--page-size" || token === "--pageSize") && tokens[index + 1]) {
			const pageSize = Number.parseInt(tokens[++index].replace(/^"|"$/g, ""), 10);
			if (Number.isFinite(pageSize)) selection.pageSize = pageSize;
			continue;
		}
		if (/^\d+$/.test(token) && sessionIds.length === 0 && selection.limit === undefined) {
			selection.limit = Number.parseInt(token, 10);
			continue;
		}
		sessionIds.push(token);
	}
	if (sessionIds.length > 0) selection.sessionIds = sessionIds;
	return selection;
}

function buildReviewInstructions() {
	return [
		"You are reviewing Pi transcript evidence.",
		"Use the transcript bundle as the only source of truth.",
		"Return ranked findings in descending severity.",
		"For every finding, include the session id, the exact evidence that supports it, why it is a real regression rather than a normal tradeoff, and one concrete process change.",
		"Do not invent issues, do not infer hidden failures, and do not keep weak findings if the transcript does not support them.",
		"If the bundle does not support actionable critique, say that explicitly instead of forcing a conclusion.",
	].join(" ");
}

function buildPagedReviewInstructions() {
	return [
		"You are reviewing one Pi transcript session one item at a time.",
		"Use the page bundle as the only source of truth.",
		"Start with page 0 and the requested character limit.",
		"If hasMore is true, request the next page using the provided nextPage cursor and the same character limit.",
		"Do not synthesize the final review until you have read all pages.",
		"Each page contains one transcript item and its serialized text is character-limited.",
		"For each finding, cite the exact event evidence, explain why it is a regression rather than a normal tradeoff, and give one concrete process change.",
		"Do not invent issues or fill gaps with speculation.",
	].join(" ");
}

function buildReviewPrompt(selection, sessionIds) {
	if (sessionIds.length === 1) {
		const requestedPageChars = Number.isFinite(selection.pageChars)
			? selection.pageChars
			: Number.isFinite(selection.pageBudget)
				? selection.pageBudget
				: Number.isFinite(selection.pageSize)
					? selection.pageSize
					: DEFAULT_SINGLE_SESSION_PAGE_CHAR_LIMIT;
		const pageChars = Math.min(
			Math.max(1, Math.trunc(requestedPageChars)),
			MAX_SINGLE_SESSION_PAGE_CHAR_LIMIT,
		);
		return [
			"Review the selected single transcript session with the transcript_review_review_session tool.",
			"Read the session one item at a time before writing a final critique.",
			"Start with page 0 and continue with nextPage until hasMore is false.",
			"Use the same character limit for every page request.",
			"Do not produce the final review until every page has been inspected.",
			"Use only transcript evidence present in the paged bundle.",
			`Requested page character limit: ${pageChars}`,
			"Return ranked findings in descending severity.",
			"For each finding, include transcript evidence, explain why it is a real regression rather than an acceptable tradeoff, and give one concrete process change.",
			"Prefer fewer, stronger findings over a long list of weak ones.",
			`Target session: ${sessionIds[0]}`,
			`Requested page character limit: ${pageChars}`,
			`Requested slice: ${selection.sliceKind ?? "full-session"}`,
		].join("\n");
	}
	const lines = [
		"Review the selected transcript sessions using the transcript_review_review_sessions tool.",
		"Do not invent issues. Use only evidence present in the transcript bundle.",
		"Return ranked findings in descending severity.",
		"For each finding, include transcript evidence, explain why it is a real regression rather than an acceptable tradeoff, and give one concrete process change.",
		"Prefer fewer, stronger findings over a long list of weak ones.",
		"If the bundle does not support a finding, omit it.",
	];
	if (sessionIds.length > 0) lines.push(`Target sessions: ${sessionIds.join(", ")}`);
	else lines.push("Target sessions: recent completed sessions.");
	lines.push(`Requested slice: ${selection.sliceKind ?? "full-session"}`);
	return lines.join("\n");
}

function buildTranscriptEventTimeline(session) {
	const timeline = [];
	for (const message of session.messages ?? []) {
		timeline.push({
			kind: "message",
			createdAt: message.createdAt,
			seq: message.seq ?? null,
			message,
		});
	}
	for (const toolCall of session.toolCalls ?? []) {
		timeline.push({
			kind: `tool_call:${toolCall.status}`,
			createdAt: toolCall.createdAt,
			seq: toolCall.seq ?? null,
			toolCall,
		});
	}
	for (const event of session.lifecycleEvents ?? []) {
		timeline.push({
			kind: `lifecycle:${event.kind}`,
			createdAt: event.createdAt,
			seq: null,
			lifecycleEvent: event,
		});
	}
	for (const annotation of session.annotations ?? []) {
		timeline.push({
			kind: `annotation:${annotation.label}`,
			createdAt: annotation.createdAt,
			seq: null,
			annotation,
		});
	}
	for (const metric of session.metrics ?? []) {
		timeline.push({
			kind: `metric:${metric.name}`,
			createdAt: metric.createdAt,
			seq: null,
			metric,
		});
	}
	return timeline.sort((a, b) => {
		const timeDiff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
		if (timeDiff !== 0) return timeDiff;
		const seqA = a.seq ?? Number.POSITIVE_INFINITY;
		const seqB = b.seq ?? Number.POSITIVE_INFINITY;
		if (seqA !== seqB) return seqA - seqB;
		return a.kind.localeCompare(b.kind);
	});
}

function cloneTranscriptSessionExport(session) {
	return {
		session: { ...session.session, meta: { ...session.session.meta } },
		messages: session.messages.map((row) => ({ ...row, meta: row.meta ? { ...row.meta } : row.meta })),
		toolCalls: session.toolCalls.map((row) => ({ ...row, meta: row.meta ? { ...row.meta } : row.meta })),
		lifecycleEvents: session.lifecycleEvents.map((row) => ({ ...row, meta: { ...row.meta } })),
		annotations: session.annotations.map((row) => ({ ...row, meta: { ...row.meta } })),
		metrics: session.metrics.map((row) => ({ ...row, meta: { ...row.meta } })),
	};
}

function sessionCompactionWindow(session, windowSize = 40) {
	const compactionEvents = session.lifecycleEvents.filter((event) => event.kind === "session_before_compact");
	if (compactionEvents.length === 0) return cloneTranscriptSessionExport(session);
	const compactionTimes = compactionEvents.map((event) => new Date(event.createdAt).getTime()).filter((time) => Number.isFinite(time));
	if (compactionTimes.length === 0) return cloneTranscriptSessionExport(session);
	const minTime = Math.min(...compactionTimes);
	const maxTime = Math.max(...compactionTimes);
	const lowerBound = minTime - windowSize * 60 * 1000;
	const upperBound = maxTime + windowSize * 60 * 1000;
	const keepByTime = (createdAt) => {
		const time = new Date(createdAt).getTime();
		return Number.isFinite(time) && time >= lowerBound && time <= upperBound;
	};
	return {
		...cloneTranscriptSessionExport(session),
		messages: session.messages.filter((message) => keepByTime(message.createdAt)),
		toolCalls: session.toolCalls.filter((toolCall) => keepByTime(toolCall.createdAt) || (toolCall.finishedAt ? keepByTime(toolCall.finishedAt) : false)),
		lifecycleEvents: session.lifecycleEvents.filter((event) => keepByTime(event.createdAt)),
		annotations: session.annotations.filter((annotation) => keepByTime(annotation.createdAt)),
		metrics: session.metrics.filter((metric) => keepByTime(metric.createdAt)),
	};
}

function frontOfSessionWindow(session, messageLimit = 40) {
	const messages = session.messages.slice(0, Math.max(1, messageLimit));
	const lastMessageTime = messages.at(-1)?.createdAt ?? session.session.startedAt;
	const lastTime = new Date(lastMessageTime).getTime();
	const keepByTime = (createdAt) => {
		const time = new Date(createdAt).getTime();
		return Number.isFinite(time) && Number.isFinite(lastTime) && time <= lastTime;
	};
	return {
		...cloneTranscriptSessionExport(session),
		messages,
		toolCalls: session.toolCalls.filter((toolCall) => keepByTime(toolCall.createdAt) || (toolCall.finishedAt ? keepByTime(toolCall.finishedAt) : false)),
		lifecycleEvents: session.lifecycleEvents.filter((event) => keepByTime(event.createdAt)),
		annotations: session.annotations.filter((annotation) => keepByTime(annotation.createdAt)),
		metrics: session.metrics.filter((metric) => keepByTime(metric.createdAt)),
	};
}

function sliceTranscriptSession(session, sliceKind, windowSize) {
	switch (sliceKind) {
		case "front-of-session":
			return frontOfSessionWindow(session, windowSize ?? 40);
		case "around-compaction":
			return sessionCompactionWindow(session, windowSize ?? 40);
		default:
			return cloneTranscriptSessionExport(session);
	}
}

function clampPageCharLimit(requestedPageChars) {
	return Math.min(
		Math.max(1, Number.isFinite(requestedPageChars) ? Math.trunc(requestedPageChars) : DEFAULT_SINGLE_SESSION_PAGE_CHAR_LIMIT),
		MAX_SINGLE_SESSION_PAGE_CHAR_LIMIT,
	);
}

function serializeTimelineEvent(event) {
	return JSON.stringify(event, null, 0);
}

function truncateText(text, maxChars) {
	if (text.length <= maxChars) return { text, truncated: false };
	const suffix = `...[truncated ${text.length - maxChars} chars]`;
	const available = Math.max(0, maxChars - suffix.length);
	return {
		text: `${text.slice(0, available)}${suffix}`,
		truncated: true,
	};
}

function takeTranscriptTimelinePage(timeline, startIndex, pageCharLimit) {
	const event = timeline[startIndex];
	if (!event) {
		return {
			events: [],
			charCount: 0,
			rawCharCount: 0,
			nextStartIndex: null,
		};
	}
	const serialized = serializeTimelineEvent(event);
	const rawCharCount = serialized.length;
	const cappedCharLimit = clampPageCharLimit(pageCharLimit);
	const { text, truncated } = truncateText(serialized, cappedCharLimit);
	return {
		events: [
			{
				kind: event.kind,
				createdAt: event.createdAt,
				seq: event.seq,
				charLimit: cappedCharLimit,
				charCount: text.length,
				rawCharCount,
				truncated,
				text,
			},
		],
		charCount: text.length,
		rawCharCount,
		nextStartIndex: startIndex + 1 < timeline.length ? startIndex + 1 : null,
	};
}

function paginateTranscriptTimeline(session, page = 0, pageChars = DEFAULT_SINGLE_SESSION_PAGE_CHAR_LIMIT) {
	const timeline = buildTranscriptEventTimeline(session);
	const safePage = Math.max(0, Number.isFinite(page) ? Math.trunc(page) : 0);
	const requestedPageCharLimit = Number.isFinite(pageChars) ? Math.trunc(pageChars) : DEFAULT_SINGLE_SESSION_PAGE_CHAR_LIMIT;
	const safePageCharLimit = clampPageCharLimit(requestedPageCharLimit);
	const pageSlice = takeTranscriptTimelinePage(timeline, safePage, safePageCharLimit);
	const nextPage = pageSlice.nextStartIndex !== null ? safePage + 1 : null;
	return {
		page: safePage,
		requestedPageCharLimit,
		pageCharLimit: safePageCharLimit,
		requestedPageSize: requestedPageCharLimit,
		pageSize: safePageCharLimit,
		maxPageCharLimit: MAX_SINGLE_SESSION_PAGE_CHAR_LIMIT,
		maxPageSize: MAX_SINGLE_SESSION_PAGE_CHAR_LIMIT,
		totalEvents: timeline.length,
		eventCount: pageSlice.events.length,
		startIndex: safePage,
		endIndex: pageSlice.nextStartIndex ?? timeline.length,
		charCount: pageSlice.charCount,
		rawCharCount: pageSlice.rawCharCount,
		hasMore: nextPage !== null,
		nextPage,
		events: pageSlice.events,
	};
}

function buildTranscriptReviewBundleFromSessions(selection, sessions) {
	const sliceKind = selection.sliceKind ?? "front-of-session";
	const slicedSessions = sessions.map((session) => sliceTranscriptSession(session, sliceKind, selection.windowSize));
	const sessionIds = slicedSessions.map((session) => session.session.id);
	const slices = slicedSessions.map((session) => ({
		sessionId: session.session.id,
		sliceKind,
		description:
			sliceKind === "front-of-session"
				? "Front of session transcript window"
				: sliceKind === "around-compaction"
					? "Transcript window around compaction events"
					: "Full session transcript",
		session,
	}));
	return {
		instructions: buildReviewInstructions(),
		scope: sessionIds.length > 0 ? `${sliceKind}: ${sessionIds.join(", ")}` : "No completed sessions available",
		sessionIds,
		slices,
		sessions: slicedSessions,
	};
}

function buildTranscriptReviewSessionBundleFromSession(session, selection = {}) {
	const page = Number.isFinite(selection.page) ? selection.page : 0;
	const pageChars = Number.isFinite(selection.pageChars)
		? selection.pageChars
		: Number.isFinite(selection.pageBudget)
			? selection.pageBudget
		: Number.isFinite(selection.pageSize)
			? selection.pageSize
			: DEFAULT_SINGLE_SESSION_PAGE_CHAR_LIMIT;
	const pageBundle = paginateTranscriptTimeline(session, page, pageChars);
	return {
		instructions: buildPagedReviewInstructions(),
		scope: `session: ${session.session.id}`,
		sessionId: session.session.id,
		session: session.session,
		page: pageBundle,
		events: pageBundle.events,
	};
}

function formatTranscriptReviewBundle(bundle) {
	return [
		bundle.instructions,
		`Scope: ${bundle.scope}`,
		`Sessions: ${bundle.sessionIds.length > 0 ? bundle.sessionIds.join(", ") : "none"}`,
		`Slice kind: ${bundle.slices[0]?.sliceKind ?? "full-session"}`,
		"",
		JSON.stringify({ slices: bundle.slices }, null, 0),
	].join("\n");
}

function formatTranscriptReviewSessionBundle(bundle) {
	return [
		bundle.instructions,
		`Scope: ${bundle.scope}`,
		`Session: ${bundle.sessionId}`,
		`Page: ${bundle.page.page} charLimit=${bundle.page.pageCharLimit} requested=${bundle.page.requestedPageCharLimit} totalEvents=${bundle.page.totalEvents} events=${bundle.page.eventCount} chars=${bundle.page.charCount} rawChars=${bundle.page.rawCharCount} hasMore=${bundle.page.hasMore} nextPage=${bundle.page.nextPage ?? "none"}`,
		"",
		JSON.stringify({ session: bundle.session, page: bundle.page, events: bundle.events }, null, 0),
	].join("\n");
}

module.exports = {
	parseReviewArgs,
	buildReviewInstructions,
	buildPagedReviewInstructions,
	MAX_SINGLE_SESSION_PAGE_SIZE: MAX_SINGLE_SESSION_PAGE_CHAR_LIMIT,
	DEFAULT_SINGLE_SESSION_PAGE_BUDGET_TOKENS: DEFAULT_SINGLE_SESSION_PAGE_CHAR_LIMIT,
	MAX_SINGLE_SESSION_PAGE_BUDGET_TOKENS: MAX_SINGLE_SESSION_PAGE_CHAR_LIMIT,
	DEFAULT_SINGLE_SESSION_PAGE_CHAR_LIMIT,
	MAX_SINGLE_SESSION_PAGE_CHAR_LIMIT,
	buildReviewPrompt,
	buildTranscriptEventTimeline,
	cloneTranscriptSessionExport,
	clampPageCharLimit,
	takeTranscriptTimelinePage,
	paginateTranscriptTimeline,
	sliceTranscriptSession,
	buildTranscriptReviewBundleFromSessions,
	buildTranscriptReviewSessionBundleFromSession,
	formatTranscriptReviewBundle,
	formatTranscriptReviewSessionBundle,
};
