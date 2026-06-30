const {
	buildTranscriptReviewBundleFromSessions,
	buildTranscriptReviewSessionBundleFromSession,
} = require("./review-helpers.js");

const tables = `
CREATE TABLE IF NOT EXISTS schema_meta (
\tkey TEXT PRIMARY KEY,
\tvalue TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
\tid TEXT PRIMARY KEY,
\tworkspace TEXT NOT NULL,
\tstatus TEXT NOT NULL,
\ttitle TEXT NOT NULL,
\tstarted_at TEXT NOT NULL,
\tended_at TEXT,
\tlast_seen_at TEXT NOT NULL,
\tmessage_count INTEGER NOT NULL DEFAULT 0,
\ttool_call_count INTEGER NOT NULL DEFAULT 0,
\tcompaction_count INTEGER NOT NULL DEFAULT 0,
\tmeta_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS messages (
\tid INTEGER PRIMARY KEY AUTOINCREMENT,
\tsession_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
\trole TEXT NOT NULL,
\tcontent TEXT NOT NULL,
\tcreated_at TEXT NOT NULL,
\tseq INTEGER NOT NULL,
\tmeta_json TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS tool_calls (
\tid INTEGER PRIMARY KEY AUTOINCREMENT,
\tsession_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
\tcall_id TEXT NOT NULL,
\ttool_name TEXT NOT NULL,
\tstatus TEXT NOT NULL,
\tinput_json TEXT,
\toutput_json TEXT,
\tcreated_at TEXT NOT NULL,
\tfinished_at TEXT,
\tseq INTEGER NOT NULL,
\tmeta_json TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_calls_session_call_id ON tool_calls(session_id, call_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session_created ON tool_calls(session_id, created_at);

CREATE TABLE IF NOT EXISTS lifecycle_events (
\tid INTEGER PRIMARY KEY AUTOINCREMENT,
\tsession_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
\tkind TEXT NOT NULL,
\tbody TEXT,
\tcreated_at TEXT NOT NULL,
\tmeta_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_events_session_kind ON lifecycle_events(session_id, kind, created_at);

CREATE TABLE IF NOT EXISTS annotations (
\tid INTEGER PRIMARY KEY AUTOINCREMENT,
\tsession_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
\ttarget_kind TEXT NOT NULL,
\ttarget_id TEXT,
\tlabel TEXT NOT NULL,
\tbody TEXT NOT NULL,
\tcreated_at TEXT NOT NULL,
\tcreated_by TEXT NOT NULL DEFAULT 'agent',
\tmeta_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_annotations_session_created ON annotations(session_id, created_at);

CREATE TABLE IF NOT EXISTS metrics (
\tid INTEGER PRIMARY KEY AUTOINCREMENT,
\tsession_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
\tname TEXT NOT NULL,
\tvalue REAL NOT NULL,
\tunit TEXT,
\tcreated_at TEXT NOT NULL,
\tmeta_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_metrics_session_name ON metrics(session_id, name, created_at);
`;

function nowIso() {
	return new Date().toISOString();
}

function parseJsonObject(value) {
	if (!value) return {};
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function safeStringify(value) {
	try {
		return JSON.stringify(value ?? null);
	} catch {
		return "{}";
	}
}

function initializeTranscriptSchema(db) {
	db.exec("PRAGMA foreign_keys = ON;");
	db.exec(tables);
	db.exec(`INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('schema_version', '1');`);
}

function getSessionRow(db, sessionId) {
	const row = db.prepare("SELECT * FROM sessions WHERE id = ? LIMIT 1").get(sessionId);
	if (!row) return null;
	return {
		id: row.id,
		workspace: row.workspace,
		status: row.status,
		title: row.title,
		startedAt: row.started_at,
		endedAt: row.ended_at,
		lastSeenAt: row.last_seen_at,
		messageCount: row.message_count,
		toolCallCount: row.tool_call_count,
		compactionCount: row.compaction_count,
		meta: parseJsonObject(row.meta_json),
	};
}

function getTranscriptSessionExport(db, sessionId) {
	const session = getSessionRow(db, sessionId);
	if (!session) return null;
	const messages = db.prepare("SELECT session_id, role, content, created_at, seq, meta_json FROM messages WHERE session_id = ? ORDER BY seq ASC, id ASC").all(sessionId);
	const toolCalls = db
		.prepare("SELECT session_id, call_id, tool_name, status, input_json, output_json, created_at, finished_at, seq, meta_json FROM tool_calls WHERE session_id = ? ORDER BY seq ASC, id ASC")
		.all(sessionId);
	const lifecycleEvents = db.prepare("SELECT kind, body, created_at, meta_json FROM lifecycle_events WHERE session_id = ? ORDER BY created_at ASC, id ASC").all(sessionId);
	const annotations = db
		.prepare("SELECT target_kind, target_id, label, body, created_at, created_by, meta_json FROM annotations WHERE session_id = ? ORDER BY created_at ASC, id ASC")
		.all(sessionId);
	const metrics = db.prepare("SELECT name, value, unit, created_at, meta_json FROM metrics WHERE session_id = ? ORDER BY created_at ASC, id ASC").all(sessionId);
	return {
		session,
		messages,
		toolCalls,
		lifecycleEvents: lifecycleEvents.map((row) => ({
			kind: row.kind,
			body: row.body,
			createdAt: row.created_at,
			meta: parseJsonObject(row.meta_json),
		})),
		annotations: annotations.map((row) => ({
			label: row.label,
			body: row.body,
			createdAt: row.created_at,
			targetKind: row.target_kind,
			targetId: row.target_id,
			createdBy: row.created_by,
			meta: parseJsonObject(row.meta_json),
		})),
		metrics: metrics.map((row) => ({
			name: row.name,
			value: row.value,
			unit: row.unit,
			createdAt: row.created_at,
			meta: parseJsonObject(row.meta_json),
		})),
	};
}

function recentCompletedSessionIds(db, limit = 5) {
	const rows = db.prepare("SELECT id FROM sessions WHERE status = 'completed' ORDER BY last_seen_at DESC, started_at DESC LIMIT ?").all(limit);
	return rows.map((row) => row.id);
}

function resolveReviewSessionIds(db, selection = {}) {
	if (selection.sessionIds && selection.sessionIds.length > 0) {
		const unique = new Set();
		for (const id of selection.sessionIds.map((item) => String(item).trim()).filter(Boolean)) unique.add(id);
		return [...unique];
	}
	return recentCompletedSessionIds(db, selection.limit ?? 5);
}

function buildTranscriptReviewBundleFromDb(db, selection = {}) {
	const resolved = resolveReviewSessionIds(db, selection);
	const sessions = resolved.map((id) => getTranscriptSessionExport(db, id)).filter(Boolean);
	return buildTranscriptReviewBundleFromSessions(selection, sessions);
}

function buildTranscriptReviewSessionBundleFromDb(db, selection = {}) {
	if (!selection.sessionId) return null;
	const session = getTranscriptSessionExport(db, String(selection.sessionId));
	if (!session) return null;
	return buildTranscriptReviewSessionBundleFromSession(session, selection);
}

function seedTranscriptDatabase(db, transcript) {
	initializeTranscriptSchema(db);
	const stamp = transcript.session.startedAt ?? nowIso();
	const session = transcript.session;
	db.prepare(
		`INSERT INTO sessions (
			id, workspace, status, title, started_at, ended_at, last_seen_at,
			message_count, tool_call_count, compaction_count, meta_json
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		session.id,
		session.workspace,
		session.status,
		session.title,
		session.startedAt,
		session.endedAt ?? null,
		session.lastSeenAt,
		session.messageCount ?? 0,
		session.toolCallCount ?? 0,
		session.compactionCount ?? 0,
		safeStringify(session.meta ?? {}),
	);
	for (const row of transcript.messages ?? []) {
		db.prepare(
			"INSERT INTO messages (session_id, role, content, created_at, seq, meta_json) VALUES (?, ?, ?, ?, ?, ?)",
		).run(row.sessionId, row.role, row.content, row.createdAt, row.seq, safeStringify(row.meta ?? null));
	}
	for (const row of transcript.toolCalls ?? []) {
		db.prepare(
			`INSERT INTO tool_calls (
				session_id, call_id, tool_name, status, input_json, output_json, created_at, finished_at, seq, meta_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			row.sessionId,
			row.callId,
			row.toolName,
			row.status,
			row.inputJson ?? null,
			row.outputJson ?? null,
			row.createdAt,
			row.finishedAt ?? null,
			row.seq,
			safeStringify(row.meta ?? null),
		);
	}
	for (const row of transcript.lifecycleEvents ?? []) {
		db.prepare("INSERT INTO lifecycle_events (session_id, kind, body, created_at, meta_json) VALUES (?, ?, ?, ?, ?)").run(
			session.id,
			row.kind,
			row.body ?? null,
			row.createdAt,
			safeStringify(row.meta ?? null),
		);
	}
	for (const row of transcript.annotations ?? []) {
		db.prepare(
			"INSERT INTO annotations (session_id, target_kind, target_id, label, body, created_at, created_by, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		).run(session.id, row.targetKind, row.targetId ?? null, row.label, row.body, row.createdAt, row.createdBy ?? "agent", safeStringify(row.meta ?? null));
	}
	for (const row of transcript.metrics ?? []) {
		db.prepare("INSERT INTO metrics (session_id, name, value, unit, created_at, meta_json) VALUES (?, ?, ?, ?, ?, ?)").run(
			session.id,
			row.name,
			row.value,
			row.unit ?? null,
			row.createdAt,
			safeStringify(row.meta ?? null),
		);
	}
	return { stamp, sessionId: session.id };
}

module.exports = {
	initializeTranscriptSchema,
	getSessionRow,
	getTranscriptSessionExport,
	recentCompletedSessionIds,
	resolveReviewSessionIds,
	buildTranscriptReviewBundleFromDb,
	buildTranscriptReviewSessionBundleFromDb,
	seedTranscriptDatabase,
};
