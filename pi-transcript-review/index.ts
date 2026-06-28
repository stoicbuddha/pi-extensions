import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

type SessionStatus = "active" | "completed" | "paused";
type MessageRole = "user" | "assistant" | "tool" | "system" | "other";
type LifecycleKind =
	| "session_start"
	| "session_shutdown"
	| "session_before_compact"
	| "before_agent_start"
	| "context"
	| "agent_end"
	| "input"
	| "tool_call"
	| "tool_result";

interface ReviewSession {
	id: string;
	workspace: string;
	status: SessionStatus;
	title: string;
	startedAt: string;
	endedAt?: string | null;
	lastSeenAt: string;
	messageCount: number;
	toolCallCount: number;
	compactionCount: number;
	meta: Record<string, unknown>;
}

interface MessageRow {
	sessionId: string;
	role: MessageRole;
	content: string;
	createdAt: string;
	seq: number;
	meta?: Record<string, unknown>;
}

interface ToolCallRow {
	sessionId: string;
	callId: string;
	toolName: string;
	status: "started" | "completed" | "failed";
	inputJson?: string | null;
	outputJson?: string | null;
	createdAt: string;
	finishedAt?: string | null;
	seq: number;
	meta?: Record<string, unknown>;
}

const STATE_DIR = ".pi-transcript-review";
const DB_FILE = "transcript-review.sqlite";

const DEFAULT_SESSION_TITLE = "Pi transcript session";

const tables = `
CREATE TABLE IF NOT EXISTS schema_meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
	id TEXT PRIMARY KEY,
	workspace TEXT NOT NULL,
	status TEXT NOT NULL,
	title TEXT NOT NULL,
	started_at TEXT NOT NULL,
	ended_at TEXT,
	last_seen_at TEXT NOT NULL,
	message_count INTEGER NOT NULL DEFAULT 0,
	tool_call_count INTEGER NOT NULL DEFAULT 0,
	compaction_count INTEGER NOT NULL DEFAULT 0,
	meta_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS messages (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	role TEXT NOT NULL,
	content TEXT NOT NULL,
	created_at TEXT NOT NULL,
	seq INTEGER NOT NULL,
	meta_json TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS tool_calls (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	call_id TEXT NOT NULL,
	tool_name TEXT NOT NULL,
	status TEXT NOT NULL,
	input_json TEXT,
	output_json TEXT,
	created_at TEXT NOT NULL,
	finished_at TEXT,
	seq INTEGER NOT NULL,
	meta_json TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_calls_session_call_id ON tool_calls(session_id, call_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session_created ON tool_calls(session_id, created_at);

CREATE TABLE IF NOT EXISTS lifecycle_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	kind TEXT NOT NULL,
	body TEXT,
	created_at TEXT NOT NULL,
	meta_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_events_session_kind ON lifecycle_events(session_id, kind, created_at);

CREATE TABLE IF NOT EXISTS annotations (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	target_kind TEXT NOT NULL,
	target_id TEXT,
	label TEXT NOT NULL,
	body TEXT NOT NULL,
	created_at TEXT NOT NULL,
	created_by TEXT NOT NULL DEFAULT 'agent',
	meta_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_annotations_session_created ON annotations(session_id, created_at);

CREATE TABLE IF NOT EXISTS metrics (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	value REAL NOT NULL,
	unit TEXT,
	created_at TEXT NOT NULL,
	meta_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_metrics_session_name ON metrics(session_id, name, created_at);
`;

type SessionCache = {
	sessionId: string | null;
	lastMessageCount: number;
	lastToolCount: number;
	lastEventStamp: string;
};

const sessionCacheByWorkspace = new Map<string, SessionCache>();
const activeSessionByWorkspace = new Map<string, string>();

function nowIso(): string {
	return new Date().toISOString();
}

function ensureDir(filePath: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function safeReadJson<T>(value: unknown, fallback: T): T {
	if (value && typeof value === "object") return value as T;
	return fallback;
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
	if (!value) return {};
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function dbPath(ctx: ExtensionContext): string {
	return path.join(ctx.cwd, STATE_DIR, DB_FILE);
}

function workspaceKey(ctx: ExtensionContext): string {
	return ctx.cwd;
}

function openDb(ctx: ExtensionContext): DatabaseSync {
	const file = dbPath(ctx);
	ensureDir(file);
	const db = new DatabaseSync(file);
	db.exec("PRAGMA foreign_keys = ON;");
	db.exec(tables);
	db.exec(`INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('schema_version', '1');`);
	return db;
}

function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = fn();
		db.exec("COMMIT");
		return result;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

function defaultSessionId(ctx: ExtensionContext): string {
	return `session-${Buffer.from(ctx.cwd).toString("base64url")}-${Date.now().toString(36)}`;
}

function sessionKey(event: any, ctx: ExtensionContext): string {
	const candidates = [
		event?.sessionId,
		event?.session_id,
		event?.session?.id,
		event?.session?.sessionId,
		event?.id,
		activeSessionByWorkspace.get(workspaceKey(ctx)),
	];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
	}
	return defaultSessionId(ctx);
}

function extractCreatedAt(event: any): string {
	const candidates = [event?.createdAt, event?.created_at, event?.timestamp, event?.time];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.trim()) return candidate;
	}
	return nowIso();
}

function extractTitle(event: any): string {
	const candidates = [event?.title, event?.name, event?.label];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
	}
	return DEFAULT_SESSION_TITLE;
}

function normalizeRole(role: unknown): MessageRole {
	switch (role) {
		case "user":
		case "assistant":
		case "tool":
		case "system":
			return role;
		default:
			return "other";
	}
}

function stringifyContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (value == null) return "";
	if (Array.isArray(value)) {
		return value
			.map((part) => {
				if (typeof part === "string") return part;
				if (part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string") {
					return (part as { text: string }).text;
				}
				return JSON.stringify(part);
			})
			.join("\n");
	}
	if (typeof value === "object") {
		return JSON.stringify(value);
	}
	return String(value);
}

function eventJson(event: any): string {
	try {
		return JSON.stringify(event ?? null);
	} catch {
		return "{}";
	}
}

function getSessionRow(db: DatabaseSync, sessionId: string): ReviewSession | null {
	const row = db
		.prepare("SELECT * FROM sessions WHERE id = ? LIMIT 1")
		.get(sessionId) as
		| {
				id: string;
				workspace: string;
				status: SessionStatus;
				title: string;
				started_at: string;
				ended_at: string | null;
				last_seen_at: string;
				message_count: number;
				tool_call_count: number;
				compaction_count: number;
				meta_json: string;
		  }
		| undefined;
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

function upsertSession(
	db: DatabaseSync,
	sessionId: string,
	ctx: ExtensionContext,
	event: any,
	status: SessionStatus = "active",
): ReviewSession {
	const startedAt = extractCreatedAt(event);
	const title = extractTitle(event);
	const workspace = ctx.cwd;
	const existing = getSessionRow(db, sessionId);
	const now = extractCreatedAt(event);
	const meta = {
		...(existing?.meta ?? {}),
		workspace,
		firstEvent: existing?.meta?.firstEvent ?? event?.type ?? event?.kind ?? "session_start",
		lastEvent: event?.type ?? event?.kind ?? "session_start",
	};
	db.prepare(`
		INSERT INTO sessions (
			id, workspace, status, title, started_at, ended_at, last_seen_at,
			message_count, tool_call_count, compaction_count, meta_json
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			workspace = excluded.workspace,
			status = excluded.status,
			title = CASE WHEN sessions.title = ? OR sessions.title = '' THEN excluded.title ELSE sessions.title END,
			started_at = CASE WHEN sessions.started_at = '' THEN excluded.started_at ELSE sessions.started_at END,
			ended_at = excluded.ended_at,
			last_seen_at = excluded.last_seen_at,
			message_count = sessions.message_count,
			tool_call_count = sessions.tool_call_count,
			compaction_count = sessions.compaction_count,
			meta_json = excluded.meta_json
	`).run(
		sessionId,
		workspace,
		status,
		title,
		existing?.startedAt ?? startedAt,
		status === "completed" ? now : existing?.endedAt ?? null,
		now,
		existing?.messageCount ?? 0,
		existing?.toolCallCount ?? 0,
		existing?.compactionCount ?? 0,
		JSON.stringify(meta),
		existing?.title ?? "",
	);
	const updated = getSessionRow(db, sessionId);
	if (!updated) throw new Error(`Failed to upsert session ${sessionId}`);
	return updated;
}

function cacheFor(ctx: ExtensionContext): SessionCache {
	const key = workspaceKey(ctx);
	const existing = sessionCacheByWorkspace.get(key);
	if (existing) return existing;
	const fresh: SessionCache = { sessionId: null, lastMessageCount: 0, lastToolCount: 0, lastEventStamp: nowIso() };
	sessionCacheByWorkspace.set(key, fresh);
	return fresh;
}

function rememberActiveSession(ctx: ExtensionContext, sessionId: string): void {
	activeSessionByWorkspace.set(workspaceKey(ctx), sessionId);
}

function currentSessionId(ctx: ExtensionContext): string | null {
	return activeSessionByWorkspace.get(workspaceKey(ctx)) ?? null;
}

function ensureSession(db: DatabaseSync, ctx: ExtensionContext, event: any, status: SessionStatus = "active"): ReviewSession {
	const sessionId = sessionKey(event, ctx);
	rememberActiveSession(ctx, sessionId);
	return upsertSession(db, sessionId, ctx, event, status);
}

function insertLifecycle(db: DatabaseSync, sessionId: string, kind: LifecycleKind, event: any): void {
	db.prepare(`
		INSERT INTO lifecycle_events (session_id, kind, body, created_at, meta_json)
		VALUES (?, ?, ?, ?, ?)
	`).run(sessionId, kind, stringifyContent(event?.body ?? event?.message ?? event?.reason ?? null), extractCreatedAt(event), eventJson(event));
}

function storeMessage(db: DatabaseSync, sessionId: string, role: MessageRole, content: unknown, seq: number, event: any): void {
	db.prepare(`
		INSERT OR IGNORE INTO messages (session_id, role, content, created_at, seq, meta_json)
		VALUES (?, ?, ?, ?, ?, ?)
	`).run(sessionId, role, stringifyContent(content), extractCreatedAt(event), seq, eventJson(event));
}

function storeToolCall(
	db: DatabaseSync,
	sessionId: string,
	callId: string,
	toolName: string,
	status: "started" | "completed" | "failed",
	event: any,
	seq: number,
): void {
	db.prepare(`
		INSERT INTO tool_calls (
			session_id, call_id, tool_name, status, input_json, output_json, created_at, finished_at, seq, meta_json
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(session_id, call_id) DO UPDATE SET
			tool_name = excluded.tool_name,
			status = excluded.status,
			input_json = COALESCE(tool_calls.input_json, excluded.input_json),
			output_json = COALESCE(excluded.output_json, tool_calls.output_json),
			finished_at = COALESCE(excluded.finished_at, tool_calls.finished_at),
			meta_json = excluded.meta_json
	`).run(
		sessionId,
		callId,
		toolName,
		status,
		event?.input ? eventJson(event.input) : event?.params ? eventJson(event.params) : null,
		event?.output ? eventJson(event.output) : null,
		extractCreatedAt(event),
		status === "completed" || status === "failed" ? extractCreatedAt(event) : null,
		seq,
		eventJson(event),
	);
}

function updateSessionCounters(db: DatabaseSync, sessionId: string): void {
	const messageCount = db.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id = ?").get(sessionId) as { count: number };
	const toolCount = db.prepare("SELECT COUNT(*) AS count FROM tool_calls WHERE session_id = ?").get(sessionId) as { count: number };
	const compactionCount = db.prepare("SELECT COUNT(*) AS count FROM lifecycle_events WHERE session_id = ? AND kind = 'session_before_compact'").get(sessionId) as {
		count: number;
	};
	const stamp = nowIso();
	db.prepare(`
		UPDATE sessions
		SET message_count = ?, tool_call_count = ?, compaction_count = ?, last_seen_at = ?
		WHERE id = ?
	`).run(messageCount.count, toolCount.count, compactionCount.count, stamp, sessionId);
	const insertMetric = db.prepare(`
		INSERT INTO metrics (session_id, name, value, unit, created_at, meta_json)
		VALUES (?, ?, ?, ?, ?, ?)
	`);
	insertMetric.run(sessionId, "message_count", messageCount.count, "count", stamp, null);
	insertMetric.run(sessionId, "tool_call_count", toolCount.count, "count", stamp, null);
	insertMetric.run(sessionId, "compaction_count", compactionCount.count, "count", stamp, null);
}

function sessionSummary(db: DatabaseSync, sessionId: string): string {
	const session = getSessionRow(db, sessionId);
	if (!session) return `Session ${sessionId} not found.`;
	const tools = db
		.prepare(
			"SELECT tool_name, COUNT(*) AS count FROM tool_calls WHERE session_id = ? GROUP BY tool_name ORDER BY count DESC, tool_name ASC LIMIT 8",
		)
		.all(sessionId) as Array<{ tool_name: string; count: number }>;
	const lifecycle = db
		.prepare("SELECT kind, COUNT(*) AS count FROM lifecycle_events WHERE session_id = ? GROUP BY kind ORDER BY count DESC, kind ASC")
		.all(sessionId) as Array<{ kind: string; count: number }>;
	const notes = db
		.prepare("SELECT label, body FROM annotations WHERE session_id = ? ORDER BY created_at DESC LIMIT 5")
		.all(sessionId) as Array<{ label: string; body: string }>;
	const recentMessages = db
		.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT 3")
		.all(sessionId) as Array<{ role: MessageRole; content: string }>;
	const lines = [
		`${session.title} (${session.id})`,
		`Status: ${session.status}`,
		`Workspace: ${session.workspace}`,
		`Started: ${session.startedAt}`,
		`Last seen: ${session.lastSeenAt}`,
		`Messages: ${session.messageCount}`,
		`Tool calls: ${session.toolCallCount}`,
		`Compactions: ${session.compactionCount}`,
	];
	if (tools.length > 0) lines.push(`Top tools: ${tools.map((row) => `${row.tool_name} (${row.count})`).join(", ")}`);
	if (lifecycle.length > 0) lines.push(`Lifecycle: ${lifecycle.map((row) => `${row.kind} (${row.count})`).join(", ")}`);
	if (notes.length > 0) lines.push(`Recent notes: ${notes.map((row) => `${row.label}: ${row.body}`).join(" | ")}`);
	if (recentMessages.length > 0) {
		lines.push(
			"Recent messages:",
			...recentMessages.map((row) => `- [${row.role}] ${row.content.slice(0, 180)}`),
		);
	}
	return lines.join("\n");
}

function listSessions(db: DatabaseSync, limit = 20): string {
	const rows = db
		.prepare(
			"SELECT id, title, status, started_at, last_seen_at, message_count, tool_call_count, compaction_count FROM sessions ORDER BY last_seen_at DESC LIMIT ?",
		)
		.all(limit) as Array<{
		id: string;
		title: string;
		status: SessionStatus;
		started_at: string;
		last_seen_at: string;
		message_count: number;
		tool_call_count: number;
		compaction_count: number;
	}>;
	if (rows.length === 0) return "No transcript sessions captured yet.";
	return rows
		.map(
			(row) =>
				`- ${row.id} | ${row.status} | ${row.title} | messages=${row.message_count} tools=${row.tool_call_count} compactions=${row.compaction_count} | started ${row.started_at} | last ${row.last_seen_at}`,
		)
		.join("\n");
}

function exportSession(db: DatabaseSync, sessionId: string): string {
	const session = getSessionRow(db, sessionId);
	if (!session) return `Session ${sessionId} not found.`;
	const messages = db
		.prepare("SELECT role, content, created_at, seq, meta_json FROM messages WHERE session_id = ? ORDER BY seq ASC")
		.all(sessionId) as Array<{ role: string; content: string; created_at: string; seq: number; meta_json: string | null }>;
	const tools = db
		.prepare(
			"SELECT call_id, tool_name, status, input_json, output_json, created_at, finished_at, seq, meta_json FROM tool_calls WHERE session_id = ? ORDER BY seq ASC, id ASC",
		)
		.all(sessionId) as Array<{
		call_id: string;
		tool_name: string;
		status: string;
		input_json: string | null;
		output_json: string | null;
		created_at: string;
		finished_at: string | null;
		seq: number;
		meta_json: string | null;
	}>;
	const lifecycle = db
		.prepare("SELECT kind, body, created_at, meta_json FROM lifecycle_events WHERE session_id = ? ORDER BY created_at ASC, id ASC")
		.all(sessionId) as Array<{ kind: string; body: string | null; created_at: string; meta_json: string | null }>;
	return JSON.stringify({ session, messages, tools, lifecycle }, null, 2);
}

function addAnnotation(
	db: DatabaseSync,
	sessionId: string,
	label: string,
	body: string,
	targetKind = "session",
	targetId?: string,
	meta?: Record<string, unknown>,
): string {
	const createdAt = nowIso();
	db.prepare(`
		INSERT INTO annotations (session_id, target_kind, target_id, label, body, created_at, created_by, meta_json)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`).run(sessionId, targetKind, targetId ?? null, label, body, createdAt, "agent", meta ? JSON.stringify(meta) : null);
	return `${label}: ${body}`;
}

function analyzePatterns(db: DatabaseSync, sessionId?: string): string {
	const sessions = sessionId
		? [getSessionRow(db, sessionId)].filter((row): row is ReviewSession => !!row)
		: (db.prepare("SELECT id FROM sessions ORDER BY last_seen_at DESC LIMIT 10").all() as Array<{ id: string }>).map((row) =>
				getSessionRow(db, row.id),
			).filter((row): row is ReviewSession => !!row);
	if (sessions.length === 0) return "No sessions available for analysis.";

	const findings: string[] = [];
	for (const session of sessions) {
		const firstTool = db
			.prepare("SELECT tool_name, seq FROM tool_calls WHERE session_id = ? ORDER BY seq ASC LIMIT 1")
			.get(session.id) as { tool_name: string; seq: number } | undefined;
		const repeatedToolRows = db
			.prepare(
				`
				SELECT tool_name, COUNT(*) AS count
				FROM tool_calls
				WHERE session_id = ?
				GROUP BY tool_name
				HAVING count >= 3
				ORDER BY count DESC, tool_name ASC
				LIMIT 5
			`,
			)
			.all(session.id) as Array<{ tool_name: string; count: number }>;
		const compactions = session.compactionCount;
		const messageCount = session.messageCount;
		const toolCount = session.toolCallCount;
		const beforeToolMessages = firstTool ? firstTool.seq - 1 : messageCount;
		if (beforeToolMessages > 12) {
			findings.push(`- ${session.id}: ${beforeToolMessages} messages before first tool call (${firstTool?.tool_name ?? "none"}).`);
		}
		if (compactions > 0) {
			findings.push(`- ${session.id}: ${compactions} compaction event(s).`);
		}
		if (repeatedToolRows.length > 0) {
			findings.push(
				`- ${session.id}: repeated tools -> ${repeatedToolRows.map((row) => `${row.tool_name} (${row.count})`).join(", ")}`,
			);
		}
		if (toolCount === 0 && messageCount > 0) {
			findings.push(`- ${session.id}: conversation recorded with no tool calls.`);
		}
	}
	if (findings.length === 0) return "No obvious transcript anomalies found in the sampled sessions.";
	return [
		"Transcript review findings:",
		...findings,
		"",
		"Suggested follow-up actions:",
		"- Inspect sessions with long pre-tool chat to tighten prompting or tool routing.",
		"- Review compaction-heavy sessions for restart or context-loss regressions.",
		"- Look for repeated tool usage to reduce loops or redundant checks.",
	].join("\n");
}

function sessionFromContext(ctx: ExtensionContext): string {
	const current = currentSessionId(ctx);
	if (current) return current;
	const id = defaultSessionId(ctx);
	activeSessionByWorkspace.set(workspaceKey(ctx), id);
	return id;
}

export default function (pi: ExtensionAPI) {
	function captureEvent(kind: LifecycleKind, event: any, ctx: ExtensionContext, status: SessionStatus = "active"): void {
		const db = openDb(ctx);
		withTransaction(db, () => {
			const session = ensureSession(db, ctx, event, status);
			insertLifecycle(db, session.id, kind, event);
			const cache = cacheFor(ctx);
			if (cache.sessionId !== session.id) {
				cache.sessionId = session.id;
				cache.lastMessageCount = 0;
				cache.lastToolCount = 0;
			}
			cache.lastEventStamp = extractCreatedAt(event);
			if (Array.isArray(event?.messages) || Array.isArray(event?.context?.messages)) {
				const messages = Array.isArray(event?.messages) ? event.messages : event.context.messages;
				const existingCount = cache.lastMessageCount;
				const nextBatch = messages.slice(existingCount);
				let nextSeqRow = db.prepare("SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM messages WHERE session_id = ?").get(session.id) as {
					maxSeq: number;
				};
				let nextSeq = nextSeqRow.maxSeq;
				for (const message of nextBatch) {
					nextSeq += 1;
					storeMessage(db, session.id, normalizeRole(message?.role), message?.content ?? message?.text ?? message?.body ?? message, nextSeq, message);
				}
				cache.lastMessageCount = messages.length;
			} else if (kind === "input") {
				const content = event?.content ?? event?.text ?? event?.message ?? event?.input ?? event;
				const nextSeqRow = db.prepare("SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM messages WHERE session_id = ?").get(session.id) as {
					maxSeq: number;
				};
				storeMessage(db, session.id, "user", content, nextSeqRow.maxSeq + 1, event);
				cache.lastMessageCount = nextSeqRow.maxSeq + 1;
			}
			if (kind === "tool_call" || kind === "tool_result") {
				const callId = typeof event?.callId === "string" ? event.callId : typeof event?.id === "string" ? event.id : `${kind}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
				const toolName = typeof event?.toolName === "string" ? event.toolName : typeof event?.name === "string" ? event.name : "unknown_tool";
				const status = kind === "tool_call" ? "started" : event?.error ? "failed" : "completed";
				const seq = db.prepare("SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM tool_calls WHERE session_id = ?").get(session.id) as { maxSeq: number };
				storeToolCall(db, session.id, callId, toolName, status, event, seq.maxSeq + 1);
				cache.lastToolCount = seq.maxSeq + 1;
			}
			updateSessionCounters(db, session.id);
		});
	}

	pi.on("session_start", async (event: any, ctx: any) => {
		captureEvent("session_start", event, ctx, "active");
	});

	pi.on("session_shutdown", async (event: any, ctx: any) => {
		captureEvent("session_shutdown", event, ctx, "completed");
		const db = openDb(ctx);
		const sessionId = sessionFromContext(ctx);
		withTransaction(db, () => {
			db.prepare("UPDATE sessions SET status = ?, ended_at = ?, last_seen_at = ? WHERE id = ?").run(
				"completed",
				nowIso(),
				nowIso(),
				sessionId,
			);
		});
		activeSessionByWorkspace.delete(workspaceKey(ctx));
		sessionCacheByWorkspace.delete(workspaceKey(ctx));
	});

	pi.on("session_before_compact", async (event: any, ctx: any) => {
		captureEvent("session_before_compact", event, ctx);
	});

	pi.on("before_agent_start", async (event: any, ctx: any) => {
		captureEvent("before_agent_start", event, ctx);
	});

	pi.on("context", async (event: any, ctx: any) => {
		captureEvent("context", event, ctx);
	});

	pi.on("agent_end", async (event: any, ctx: any) => {
		captureEvent("agent_end", event, ctx);
	});

	pi.on("input", async (event: any, ctx: any) => {
		captureEvent("input", event, ctx);
	});

	pi.on("tool_call", async (event: any, ctx: any) => {
		captureEvent("tool_call", event, ctx);
	});

	pi.on("tool_result", async (event: any, ctx: any) => {
		captureEvent("tool_result", event, ctx);
	});

	pi.registerCommand("transcript-review", {
		description: "Inspect transcript review state and reports",
		handler: async (args: string, ctx: any) => {
			const [command, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const db = openDb(ctx);
			const sessionId = rest[0] || currentSessionId(ctx) || undefined;
			if (!command) {
				ctx.ui.notify(
					[
						"Transcript review commands:",
						"  /transcript-review status",
						"  /transcript-review list [limit]",
						"  /transcript-review show [sessionId]",
						"  /transcript-review export [sessionId]",
						"  /transcript-review analyze [sessionId]",
						"  /transcript-review annotate <sessionId> <label> <body>",
					].join("\n"),
					"info",
				);
				return;
			}
			if (command === "status") {
				const current = sessionId ? getSessionRow(db, sessionId) : null;
				const summary = current ? sessionSummary(db, current.id) : listSessions(db, 20);
				ctx.ui.notify(summary, "info");
				return;
			}
			if (command === "list") {
				const limit = Number.parseInt(rest[1] ?? "20", 10);
				ctx.ui.notify(listSessions(db, Number.isFinite(limit) ? limit : 20), "info");
				return;
			}
			if (command === "show") {
				if (!sessionId) {
					ctx.ui.notify("Usage: /transcript-review show [sessionId]", "warning");
					return;
				}
				ctx.ui.notify(sessionSummary(db, sessionId), "info");
				return;
			}
			if (command === "export") {
				if (!sessionId) {
					ctx.ui.notify("Usage: /transcript-review export [sessionId]", "warning");
					return;
				}
				ctx.ui.notify(exportSession(db, sessionId), "info");
				return;
			}
			if (command === "analyze") {
				ctx.ui.notify(analyzePatterns(db, sessionId), "info");
				return;
			}
			if (command === "annotate") {
				const targetSession = rest[0];
				const label = rest[1];
				const body = rest.slice(2).join(" ");
				if (!targetSession || !label || !body) {
					ctx.ui.notify("Usage: /transcript-review annotate <sessionId> <label> <body>", "warning");
					return;
				}
				withTransaction(db, () => {
					const session = getSessionRow(db, targetSession);
					if (!session) throw new Error(`Session ${targetSession} not found`);
					addAnnotation(db, targetSession, label, body, "session", targetSession, { source: "command" });
				});
				ctx.ui.notify(`Annotated ${targetSession}: ${label}`, "info");
				return;
			}
			ctx.ui.notify("Unknown transcript-review command.", "warning");
		},
	});

	pi.registerTool({
		name: "transcript_review_list_sessions",
		label: "List Transcript Sessions",
		description: "List captured transcript sessions in the local SQLite store.",
		promptSnippet: "List captured transcript sessions and their aggregate counts.",
		promptGuidelines: ["Use this to find a session to inspect before querying the full transcript."],
		parameters: Type.Object({
			limit: Type.Optional(Type.Number({ description: "Maximum sessions to return", default: 20 })),
		}),
		async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
			const db = openDb(ctx);
			return { content: [{ type: "text", text: listSessions(db, Math.max(1, Math.min(100, params.limit ?? 20))) }], details: {} };
		},
	});

	pi.registerTool({
		name: "transcript_review_get_session",
		label: "Get Transcript Session",
		description: "Return a structured summary for one transcript session.",
		promptSnippet: "Inspect one session's transcript summary without dumping the full database.",
		promptGuidelines: ["Use this when you need session counts, recent messages, and recent annotations."],
		parameters: Type.Object({
			sessionId: Type.String({ description: "Session identifier" }),
		}),
		async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
			const db = openDb(ctx);
			const summary = sessionSummary(db, params.sessionId);
			return { content: [{ type: "text", text: summary }], details: {} };
		},
	});

	pi.registerTool({
		name: "transcript_review_export_session",
		label: "Export Transcript Session",
		description: "Export a session as JSON for downstream analysis or storage.",
		promptSnippet: "Export a full transcript session as JSON.",
		promptGuidelines: ["Use this to hand the raw transcript to a secondary review agent or external process."],
		parameters: Type.Object({
			sessionId: Type.String({ description: "Session identifier" }),
		}),
		async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
			const db = openDb(ctx);
			return { content: [{ type: "text", text: exportSession(db, params.sessionId) }], details: {} };
		},
	});

	pi.registerTool({
		name: "transcript_review_annotate",
		label: "Annotate Transcript",
		description: "Attach a note or label to a transcript session.",
		promptSnippet: "Annotate transcript sessions with labels and notes.",
		promptGuidelines: ["Use this to mark interesting turns, regressions, or review findings."],
		parameters: Type.Object({
			sessionId: Type.String({ description: "Session identifier" }),
			label: Type.String({ description: "Short label such as 'looping' or 'good-recovery'" }),
			body: Type.String({ description: "Annotation text" }),
		}),
		async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
			const db = openDb(ctx);
			withTransaction(db, () => {
				const session = getSessionRow(db, params.sessionId);
				if (!session) throw new Error(`Session ${params.sessionId} not found`);
				addAnnotation(db, params.sessionId, params.label, params.body, "session", params.sessionId, { source: "tool" });
			});
			return { content: [{ type: "text", text: `Annotated ${params.sessionId} with ${params.label}.` }], details: {} };
		},
	});

	pi.registerTool({
		name: "transcript_review_analyze",
		label: "Analyze Transcript Patterns",
		description: "Generate a lightweight review report from captured sessions.",
		promptSnippet: "Look for transcript review patterns across captured sessions.",
		promptGuidelines: ["Use this to identify repeated tool calls, compaction pressure, or long pre-tool conversations."],
		parameters: Type.Object({
			sessionId: Type.Optional(Type.String({ description: "Optional single session to analyze" })),
		}),
		async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
			const db = openDb(ctx);
			return { content: [{ type: "text", text: analyzePatterns(db, params.sessionId) }], details: {} };
		},
	});
}
