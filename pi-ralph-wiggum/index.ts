/**
 * Ralph Wiggum - Long-running agent loops for iterative development.
 * Port of Geoffrey Huntley's approach.
 */

import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const RALPH_DIR = ".ralph";
const SESSION_RESET_MARKER = "Previous Ralph loop transcript intentionally discarded. Continue from current task state only.";
const FAKE_RALPH_DONE_PATTERN = /<(?:invoke|tool_use|tool|function_call)\b[^>]*(?:name=["']ralph_done["']|ralph_done)[\s\S]*?<\/(?:invoke|tool_use|tool|function_call)>|<ralph_done\b[^>]*\/?>/i;
const PROMPT_PLAN_MAX_CHARS = 5000;
const PROMPT_FIELD_MAX_CHARS = 500;
const PROMPT_SUMMARY_MAX_CHARS = 700;
const PROMPT_MAX_GOALS = 5;
const PROMPT_MAX_TASK_NOTES = 1;
const PROMPT_MAX_TASK_EVIDENCE = 1;
const GET_PLAN_DEFAULT_MAX_TASKS = 12;
const GET_PLAN_MAX_NOTES = 3;
const GET_PLAN_MAX_VERIFICATION = 3;
const GET_PLAN_MAX_REFLECTIONS = 2;
const META_CURRENT_LOOP_NAME = "current_loop_name";

const DEFAULT_TEMPLATE = `# Task

Describe your task here.

## Goals
- Goal 1
- Goal 2

## Checklist
- [ ] Item 1
- [ ] Item 2

## Notes
(Update this as you work)
`;

const DEFAULT_REFLECT_INSTRUCTIONS = `REFLECTION CHECKPOINT

Pause and reflect on your progress:
1. What has been accomplished so far?
2. What's working well?
3. What's not working or blocking progress?
4. Should the approach be adjusted?
5. What are the next priorities?

Record your reflection with Ralph tools, then continue working.`;

type LoopStatus = "active" | "paused" | "completed";
type SessionStrategy = "followUp" | "newSession";
type SessionStrategyFailure = "followUp" | "stopAndAlert";
type TaskStatus = "todo" | "in_progress" | "blocked" | "done" | "cancelled";

interface LoopState {
	name: string;
	taskFile: string;
	iteration: number;
	maxIterations: number;
	itemsPerIteration: number;
	reflectEvery: number;
	reflectInstructions: string;
	active: boolean;
	status: LoopStatus;
	startedAt: string;
	completedAt?: string;
	lastReflectionAt: number; // Last iteration we reflected at
	lastDoneReminderAt: number; // Last iteration where we reminded the agent to call ralph_done
	resumeGeneration: number;
	lastResumeDispatchedGeneration: number;
	currentTaskId?: string | null;
	sessionStrategy: SessionStrategy;
	sessionStrategyFailure: SessionStrategyFailure;
	pendingSessionReset?: boolean;
	createdAt?: string;
	updatedAt?: string;
	archivedAt?: string | null;
}

interface RalphNote {
	at: string;
	text: string;
}

interface RalphReflection {
	at: string;
	iteration: number;
	text: string;
}

interface RalphVerificationEntry {
	at: string;
	text: string;
}

interface RalphTask {
	id: string;
	title: string;
	status: TaskStatus;
	order: number;
	details?: string;
	evidence: string[];
	notes: string[];
}

interface RalphPlan {
	version: 1;
	loopName: string;
	title: string;
	summary: string;
	goals: string[];
	tasks: RalphTask[];
	notes: RalphNote[];
	reflections: RalphReflection[];
	verification: RalphVerificationEntry[];
	meta: {
		createdAt: string;
		updatedAt: string;
		nextTaskNumber: number;
		importedFromMarkdown?: boolean;
	};
}

const STATUS_ICONS: Record<LoopStatus, string> = { active: "▶", paused: "⏸", completed: "✓" };
const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
	todo: "TODO",
	in_progress: "IN PROGRESS",
	blocked: "BLOCKED",
	done: "DONE",
	cancelled: "CANCELLED",
};

export default function (pi: ExtensionAPI) {
	let currentLoop: string | null = null;
	let dbHandle: { cwd: string; dbPath: string; db: DatabaseSync } | null = null;

	const ralphDir = (ctx: ExtensionContext) => path.resolve(ctx.cwd, RALPH_DIR);
	const archiveDir = (ctx: ExtensionContext) => path.join(ralphDir(ctx), "archive");
	const sanitize = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");

	function getPath(ctx: ExtensionContext, name: string, ext: string, archived = false): string {
		const dir = archived ? archiveDir(ctx) : ralphDir(ctx);
		return path.join(dir, `${sanitize(name)}${ext}`);
	}

	function ensureDir(filePath: string): void {
		const dir = path.dirname(filePath);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	}

	function tryDelete(filePath: string): void {
		try {
			if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
		} catch {
			/* ignore */
		}
	}

	function tryRead(filePath: string): string | null {
		try {
			return fs.readFileSync(filePath, "utf-8");
		} catch {
			return null;
		}
	}

	function loadRalphOverlay(ctx: ExtensionContext): string | null {
		const overlayPath = path.resolve(ctx.cwd, "RALPH.md");
		const content = tryRead(overlayPath);
		if (!content) return null;
		const trimmed = content.trim();
		if (!trimmed) return null;
		return trimmed;
	}

	function safeMtimeMs(filePath: string): number {
		try {
			return fs.statSync(filePath).mtimeMs;
		} catch {
			return 0;
		}
	}

	function tryRemoveDir(dirPath: string): boolean {
		try {
			if (fs.existsSync(dirPath)) fs.rmSync(dirPath, { recursive: true, force: true });
			return true;
		} catch {
			return false;
		}
	}

	function nowIso(): string {
		return new Date().toISOString();
	}

	type DbLoopRow = {
		id: string;
		name: string;
		task_file: string;
		status: LoopStatus;
		iteration: number;
		max_iterations: number;
		items_per_iteration: number;
		reflect_every: number;
		reflect_instructions: string;
		session_strategy: SessionStrategy;
		session_strategy_failure: SessionStrategyFailure;
		pending_session_reset: number;
		last_reflection_at: number;
		last_done_reminder_at: number;
		resume_generation: number;
		last_resume_dispatched_generation: number;
		current_task_id: string | null;
		started_at: string;
		completed_at: string | null;
		created_at: string;
		updated_at: string;
		archived_at: string | null;
	};

	type DbPlanRow = {
		loop_id: string;
		title: string;
		summary: string;
		next_task_number: number;
		imported_from_markdown: number;
		created_at: string;
		updated_at: string;
	};

	type DbMetaRow = {
		key: string;
		value: string;
	};

	function dbPath(ctx: ExtensionContext): string {
		return path.join(ralphDir(ctx), "ralph.sqlite");
	}

	function ensureRalphDir(ctx: ExtensionContext): void {
		const dir = ralphDir(ctx);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	}

	function openDb(ctx: ExtensionContext): DatabaseSync {
		const file = dbPath(ctx);
		if (!dbHandle || dbHandle.cwd !== ctx.cwd || dbHandle.dbPath !== file) {
			ensureRalphDir(ctx);
			dbHandle = { cwd: ctx.cwd, dbPath: file, db: new DatabaseSync(file) };
			initDbSchema(dbHandle.db);
		}
		return dbHandle.db;
	}

	function initDbSchema(db: DatabaseSync): void {
		db.exec("PRAGMA foreign_keys = ON;");
		db.exec(`
			CREATE TABLE IF NOT EXISTS schema_meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS loops (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL UNIQUE,
				task_file TEXT NOT NULL,
				status TEXT NOT NULL,
				iteration INTEGER NOT NULL,
				max_iterations INTEGER NOT NULL,
				items_per_iteration INTEGER NOT NULL,
				reflect_every INTEGER NOT NULL,
				reflect_instructions TEXT NOT NULL,
				session_strategy TEXT NOT NULL,
				session_strategy_failure TEXT NOT NULL,
				pending_session_reset INTEGER NOT NULL DEFAULT 0,
				last_reflection_at INTEGER NOT NULL DEFAULT 0,
				last_done_reminder_at INTEGER NOT NULL DEFAULT 0,
				resume_generation INTEGER NOT NULL DEFAULT 0,
				last_resume_dispatched_generation INTEGER NOT NULL DEFAULT 0,
				current_task_id TEXT,
				started_at TEXT NOT NULL,
				completed_at TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				archived_at TEXT
			);

			CREATE TABLE IF NOT EXISTS plans (
				loop_id TEXT PRIMARY KEY REFERENCES loops(id) ON DELETE CASCADE,
				title TEXT NOT NULL,
				summary TEXT NOT NULL,
				next_task_number INTEGER NOT NULL,
				imported_from_markdown INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS plan_goals (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				loop_id TEXT NOT NULL REFERENCES loops(id) ON DELETE CASCADE,
				goal TEXT NOT NULL,
				order_index INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_plan_goals_loop_order ON plan_goals(loop_id, order_index);

			CREATE TABLE IF NOT EXISTS tasks (
				id TEXT PRIMARY KEY,
				loop_id TEXT NOT NULL REFERENCES loops(id) ON DELETE CASCADE,
				task_key TEXT NOT NULL,
				title TEXT NOT NULL,
				status TEXT NOT NULL,
				order_index INTEGER NOT NULL,
				details TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);

			CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_loop_key ON tasks(loop_id, task_key);
			CREATE INDEX IF NOT EXISTS idx_tasks_loop_order ON tasks(loop_id, order_index);

			CREATE TABLE IF NOT EXISTS task_entries (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				loop_id TEXT NOT NULL REFERENCES loops(id) ON DELETE CASCADE,
				task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
				kind TEXT NOT NULL,
				body TEXT NOT NULL,
				iteration INTEGER,
				created_at TEXT NOT NULL,
				meta_json TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_task_entries_loop_kind ON task_entries(loop_id, kind, created_at);

			CREATE TABLE IF NOT EXISTS loop_entries (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				loop_id TEXT NOT NULL REFERENCES loops(id) ON DELETE CASCADE,
				kind TEXT NOT NULL,
				body TEXT NOT NULL,
				iteration INTEGER,
				created_at TEXT NOT NULL,
				meta_json TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_loop_entries_loop_kind ON loop_entries(loop_id, kind, created_at);

			CREATE TABLE IF NOT EXISTS loop_events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				loop_id TEXT NOT NULL REFERENCES loops(id) ON DELETE CASCADE,
				kind TEXT NOT NULL,
				body TEXT,
				iteration INTEGER,
				created_at TEXT NOT NULL,
				meta_json TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_loop_events_loop_kind ON loop_events(loop_id, kind, created_at);

			CREATE TABLE IF NOT EXISTS ralph_meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
		`);
		db.exec(`INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('schema_version', '1');`);
		ensureLoopSchemaColumns(db);
	}

	function ensureLoopSchemaColumns(db: DatabaseSync): void {
		const columns = new Set(
			(db.prepare("PRAGMA table_info(loops)").all() as Array<{ name: string }>).map((row) => row.name),
		);
		if (!columns.has("resume_generation")) {
			db.exec(`ALTER TABLE loops ADD COLUMN resume_generation INTEGER NOT NULL DEFAULT 0;`);
		}
		if (!columns.has("last_resume_dispatched_generation")) {
			db.exec(`ALTER TABLE loops ADD COLUMN last_resume_dispatched_generation INTEGER NOT NULL DEFAULT 0;`);
		}
		if (!columns.has("current_task_id")) {
			db.exec(`ALTER TABLE loops ADD COLUMN current_task_id TEXT;`);
		}
	}

	function getMetaValue(db: DatabaseSync, key: string): string | null {
		const row = db.prepare("SELECT value FROM ralph_meta WHERE key = ?").get(key) as DbMetaRow | undefined;
		return row?.value ?? null;
	}

	function setMetaValue(db: DatabaseSync, key: string, value: string): void {
		db.prepare(`
			INSERT INTO ralph_meta (key, value) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value
		`).run(key, value);
	}

	function clearMetaValue(db: DatabaseSync, key: string): void {
		db.prepare("DELETE FROM ralph_meta WHERE key = ?").run(key);
	}

	function setSelectedLoopName(ctx: ExtensionContext, loopName: string | null): void {
		const db = openDb(ctx);
		withTransaction(db, () => {
			if (loopName) setMetaValue(db, META_CURRENT_LOOP_NAME, loopName);
			else clearMetaValue(db, META_CURRENT_LOOP_NAME);
		});
		currentLoop = loopName;
	}

	function loadSelectedLoopName(ctx: ExtensionContext): string | null {
		const db = openDb(ctx);
		const selected = getMetaValue(db, META_CURRENT_LOOP_NAME);
		if (!selected) return null;
		const state = stateFromDb(db, selected);
		if (state) return selected;
		clearMetaValue(db, META_CURRENT_LOOP_NAME);
		return null;
	}

	function shouldRestoreLoopOnSessionStart(reason: unknown): boolean {
		return reason !== "startup";
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

	function stateToRow(state: LoopState): DbLoopRow {
		const now = state.updatedAt ?? nowIso();
		return {
			id: state.name,
			name: state.name,
			task_file: state.taskFile,
			status: state.status,
			iteration: state.iteration,
			max_iterations: state.maxIterations,
			items_per_iteration: state.itemsPerIteration,
			reflect_every: state.reflectEvery,
			reflect_instructions: state.reflectInstructions,
			session_strategy: state.sessionStrategy,
			session_strategy_failure: state.sessionStrategyFailure,
			pending_session_reset: state.pendingSessionReset ? 1 : 0,
			last_reflection_at: state.lastReflectionAt ?? 0,
			last_done_reminder_at: state.lastDoneReminderAt ?? 0,
			resume_generation: state.resumeGeneration ?? 0,
			last_resume_dispatched_generation: state.lastResumeDispatchedGeneration ?? 0,
			current_task_id: state.currentTaskId ?? null,
			started_at: state.startedAt,
			completed_at: state.completedAt ?? null,
			created_at: state.createdAt ?? state.startedAt,
			updated_at: now,
			archived_at: state.archivedAt ?? null,
		};
	}

	function rowToState(row: DbLoopRow): LoopState {
		return {
			name: row.name,
			taskFile: row.task_file,
			iteration: row.iteration,
			maxIterations: row.max_iterations,
			itemsPerIteration: row.items_per_iteration,
			reflectEvery: row.reflect_every,
			reflectInstructions: row.reflect_instructions,
			active: row.status === "active",
			status: row.status,
			startedAt: row.started_at,
			completedAt: row.completed_at ?? undefined,
			lastReflectionAt: row.last_reflection_at,
			lastDoneReminderAt: row.last_done_reminder_at,
			resumeGeneration: row.resume_generation,
			lastResumeDispatchedGeneration: row.last_resume_dispatched_generation,
			currentTaskId: row.current_task_id,
			sessionStrategy: row.session_strategy,
			sessionStrategyFailure: row.session_strategy_failure,
			pendingSessionReset: row.pending_session_reset === 1,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			archivedAt: row.archived_at,
		};
	}

	function upsertLoop(db: DatabaseSync, state: LoopState): void {
		const row = stateToRow(state);
		db.prepare(`
			INSERT INTO loops (
				id, name, task_file, status, iteration, max_iterations, items_per_iteration,
				reflect_every, reflect_instructions, session_strategy, session_strategy_failure,
				pending_session_reset, last_reflection_at, last_done_reminder_at, resume_generation,
				last_resume_dispatched_generation, current_task_id, started_at, completed_at,
				created_at, updated_at, archived_at
			) VALUES (
				@id, @name, @task_file, @status, @iteration, @max_iterations, @items_per_iteration,
				@reflect_every, @reflect_instructions, @session_strategy, @session_strategy_failure,
				@pending_session_reset, @last_reflection_at, @last_done_reminder_at, @resume_generation,
				@last_resume_dispatched_generation, @current_task_id, @started_at, @completed_at,
				@created_at, @updated_at, @archived_at
			)
			ON CONFLICT(id) DO UPDATE SET
				name = excluded.name,
				task_file = excluded.task_file,
				status = excluded.status,
				iteration = excluded.iteration,
				max_iterations = excluded.max_iterations,
				items_per_iteration = excluded.items_per_iteration,
				reflect_every = excluded.reflect_every,
				reflect_instructions = excluded.reflect_instructions,
				session_strategy = excluded.session_strategy,
				session_strategy_failure = excluded.session_strategy_failure,
				pending_session_reset = excluded.pending_session_reset,
				last_reflection_at = excluded.last_reflection_at,
				last_done_reminder_at = excluded.last_done_reminder_at,
				resume_generation = excluded.resume_generation,
				last_resume_dispatched_generation = excluded.last_resume_dispatched_generation,
				current_task_id = excluded.current_task_id,
				started_at = excluded.started_at,
				completed_at = excluded.completed_at,
				created_at = excluded.created_at,
				updated_at = excluded.updated_at,
				archived_at = excluded.archived_at
		`).run(row);
	}

	function replacePlan(db: DatabaseSync, plan: RalphPlan): void {
		const createdAt = plan.meta.createdAt;
		const updatedAt = plan.meta.updatedAt;
		db.prepare(`
			INSERT INTO plans (loop_id, title, summary, next_task_number, imported_from_markdown, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(loop_id) DO UPDATE SET
				title = excluded.title,
				summary = excluded.summary,
				next_task_number = excluded.next_task_number,
				imported_from_markdown = excluded.imported_from_markdown,
				created_at = excluded.created_at,
				updated_at = excluded.updated_at
		`).run(plan.loopName, plan.title, plan.summary, plan.meta.nextTaskNumber, plan.meta.importedFromMarkdown ? 1 : 0, createdAt, updatedAt);
		db.prepare("DELETE FROM plan_goals WHERE loop_id = ?").run(plan.loopName);
		db.prepare("DELETE FROM tasks WHERE loop_id = ?").run(plan.loopName);
		db.prepare("DELETE FROM task_entries WHERE loop_id = ?").run(plan.loopName);
		db.prepare("DELETE FROM loop_entries WHERE loop_id = ?").run(plan.loopName);
		const insertGoal = db.prepare("INSERT INTO plan_goals (loop_id, goal, order_index) VALUES (?, ?, ?)");
		const insertTask = db.prepare(`
			INSERT INTO tasks (id, loop_id, task_key, title, status, order_index, details, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		const insertTaskEntry = db.prepare(`
			INSERT INTO task_entries (loop_id, task_id, kind, body, iteration, created_at, meta_json)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`);
		const insertLoopEntry = db.prepare(`
			INSERT INTO loop_entries (loop_id, kind, body, iteration, created_at, meta_json)
			VALUES (?, ?, ?, ?, ?, ?)
		`);
		for (const [index, goal] of plan.goals.entries()) {
			insertGoal.run(plan.loopName, goal, index + 1);
		}
		for (const task of plan.tasks) {
			const taskId = `${plan.loopName}:${task.id}`;
			insertTask.run(taskId, plan.loopName, task.id, task.title, task.status, task.order, task.details ?? null, createdAt, updatedAt);
			for (const note of task.notes) {
				insertTaskEntry.run(plan.loopName, taskId, "note", note, null, createdAt, null);
			}
			for (const evidence of task.evidence) {
				insertTaskEntry.run(plan.loopName, taskId, "evidence", evidence, null, createdAt, null);
			}
		}
		for (const note of plan.notes) {
			insertLoopEntry.run(plan.loopName, "note", note.text, null, note.at, null);
		}
		for (const reflection of plan.reflections) {
			insertLoopEntry.run(plan.loopName, "reflection", reflection.text, reflection.iteration, reflection.at, null);
		}
		for (const verification of plan.verification) {
			insertLoopEntry.run(plan.loopName, "verification", verification.text, null, verification.at, null);
		}
	}

	function planFromDb(db: DatabaseSync, loopName: string): RalphPlan | null {
		const planRow = db.prepare("SELECT * FROM plans WHERE loop_id = ?").get(loopName) as DbPlanRow | undefined;
		if (!planRow) return null;
		const taskRows = db.prepare("SELECT * FROM tasks WHERE loop_id = ? ORDER BY order_index ASC").all(loopName) as Array<{
			id: string;
			task_key: string;
			title: string;
			status: TaskStatus;
			order_index: number;
			details: string | null;
			created_at: string;
			updated_at: string;
		}>;
		const goalRows = db.prepare("SELECT goal FROM plan_goals WHERE loop_id = ? ORDER BY order_index ASC").all(loopName) as Array<{ goal: string }>;
		const taskEntries = db.prepare("SELECT * FROM task_entries WHERE loop_id = ? ORDER BY created_at ASC, id ASC").all(loopName) as Array<{
			task_id: string;
			kind: string;
			body: string;
			created_at: string;
		}>;
		const loopEntries = db.prepare("SELECT * FROM loop_entries WHERE loop_id = ? ORDER BY created_at ASC, id ASC").all(loopName) as Array<{
			kind: string;
			body: string;
			iteration: number | null;
			created_at: string;
		}>;
		const taskById = new Map<string, RalphTask>();
		const tasks = taskRows.map((row, index) => {
			const task: RalphTask = {
				id: row.task_key,
				title: row.title,
				status: parseTaskStatus(row.status) ?? "todo",
				order: row.order_index ?? index + 1,
				details: row.details ?? undefined,
				evidence: [],
				notes: [],
			};
			taskById.set(row.id, task);
			return task;
		});
		for (const entry of taskEntries) {
			const task = taskById.get(entry.task_id);
			if (!task) continue;
			if (entry.kind === "evidence") task.evidence.push(entry.body);
			else if (entry.kind === "note") task.notes.push(entry.body);
		}
		const notes: RalphNote[] = [];
		const reflections: RalphReflection[] = [];
		const verification: RalphVerificationEntry[] = [];
		for (const entry of loopEntries) {
			if (entry.kind === "note") notes.push({ at: entry.created_at, text: entry.body });
			else if (entry.kind === "reflection") reflections.push({ at: entry.created_at, iteration: entry.iteration ?? 0, text: entry.body });
			else if (entry.kind === "verification") verification.push({ at: entry.created_at, text: entry.body });
		}
		return migratePlan(
			{
				loopName,
				title: planRow.title,
				summary: planRow.summary,
				goals: goalRows.map((row) => row.goal),
				tasks,
				notes,
				reflections,
				verification,
				meta: {
					createdAt: planRow.created_at,
					updatedAt: planRow.updated_at,
					nextTaskNumber: planRow.next_task_number,
					importedFromMarkdown: planRow.imported_from_markdown === 1,
				},
			},
			loopName,
		);
	}

	function stateFromDb(db: DatabaseSync, name: string, archived = false): LoopState | null {
		const row = db.prepare(
			`SELECT * FROM loops WHERE name = ? AND ${archived ? "archived_at IS NOT NULL" : "archived_at IS NULL"} LIMIT 1`,
		).get(name) as DbLoopRow | undefined;
		return row ? rowToState(row) : null;
	}

	function listStatesFromDb(db: DatabaseSync, archived = false): LoopState[] {
		const rows = db.prepare(
			`SELECT * FROM loops WHERE ${archived ? "archived_at IS NOT NULL" : "archived_at IS NULL"} ORDER BY updated_at DESC, name DESC`,
		).all() as DbLoopRow[];
		return rows.map(rowToState);
	}

	function deleteLoop(ctx: ExtensionContext, name: string, archived = false): void {
		const db = openDb(ctx);
		withTransaction(db, () => {
			db.prepare(`DELETE FROM loops WHERE name = ? AND ${archived ? "archived_at IS NOT NULL" : "archived_at IS NULL"}`).run(name);
		});
	}

	function runGitCommand(ctx: ExtensionContext, args: string[]): { ok: boolean; stdout: string; stderr: string; status: number | null } {
		const result = spawnSync("git", args, {
			cwd: ctx.cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return {
			ok: result.status === 0,
			stdout: typeof result.stdout === "string" ? result.stdout : "",
			stderr: typeof result.stderr === "string" ? result.stderr : "",
			status: result.status,
		};
	}

	function isNothingToCommit(output: string): boolean {
		return /nothing to commit|working tree clean/i.test(output);
	}

	function buildGitCheckpointMessage(state: LoopState): string {
		const completedIteration = Math.max(1, state.iteration - 1);
		return `ralph: ${state.name} iteration ${completedIteration} checkpoint`;
	}

	function checkpointLoopState(ctx: ExtensionContext, state: LoopState): { ok: boolean; skipped: boolean; message: string } {
		const addResult = runGitCommand(ctx, ["add", "."]);
		if (!addResult.ok) {
			return {
				ok: false,
				skipped: false,
				message: `git add . failed: ${[addResult.stderr, addResult.stdout].filter(Boolean).join("\n").trim() || `exit ${addResult.status ?? "unknown"}`}`,
			};
		}

		const commitMessage = buildGitCheckpointMessage(state);
		const commitResult = runGitCommand(ctx, ["commit", "-m", commitMessage]);
		if (!commitResult.ok) {
			if (isNothingToCommit(`${commitResult.stdout}\n${commitResult.stderr}`)) {
				return {
					ok: true,
					skipped: true,
					message: "No git changes to commit; checkpoint skipped.",
				};
			}
			return {
				ok: false,
				skipped: false,
				message: `git commit failed: ${[commitResult.stderr, commitResult.stdout].filter(Boolean).join("\n").trim() || `exit ${commitResult.status ?? "unknown"}`}`,
			};
		}

		const pushResult = runGitCommand(ctx, ["push"]);
		if (!pushResult.ok) {
			return {
				ok: false,
				skipped: false,
				message: `git push failed: ${[pushResult.stderr, pushResult.stdout].filter(Boolean).join("\n").trim() || `exit ${pushResult.status ?? "unknown"}`}`,
			};
		}

		return {
			ok: true,
			skipped: false,
			message: `Created git checkpoint: ${commitMessage}`,
		};
	}

	function runGraphifyUpdate(ctx: ExtensionContext): { ok: boolean; message?: string } {
		const result = spawnSync("graphify", ["update", "."], {
			cwd: ctx.cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (result.status === 0) {
			return { ok: true };
		}
		const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
		const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
		const message = [stderr, stdout].filter(Boolean).join("\n").trim() || `exit ${result.status ?? "unknown"}`;
		if (/ENOENT|not found|command not found/i.test(message)) {
			return { ok: false, message: "graphify not available; skipped graph update." };
		}
		return { ok: false, message: `graphify update failed: ${message}` };
	}

	function parseSessionStrategy(value: unknown): SessionStrategy {
		return value === "followUp" ? "followUp" : "newSession";
	}

	function parseSessionStrategyFailure(value: unknown): SessionStrategyFailure {
		return value === "stopAndAlert" ? "stopAndAlert" : "followUp";
	}

	function parseTaskStatus(value: unknown): TaskStatus | null {
		switch (value) {
			case "todo":
			case "in_progress":
			case "blocked":
			case "done":
			case "cancelled":
				return value;
			default:
				return null;
		}
	}

	function migrateState(raw: Partial<LoopState> & { name: string }): LoopState {
		if (!raw.status) raw.status = raw.active ? "active" : "paused";
		raw.active = raw.status === "active";
		// Migrate old field names
		if ("reflectEveryItems" in raw && !raw.reflectEvery) {
			raw.reflectEvery = (raw as any).reflectEveryItems;
		}
		if ("lastReflectionAtItems" in raw && raw.lastReflectionAt === undefined) {
			raw.lastReflectionAt = (raw as any).lastReflectionAtItems;
		}
		raw.lastDoneReminderAt = raw.lastDoneReminderAt ?? 0;
		raw.resumeGeneration = raw.resumeGeneration ?? 0;
		raw.lastResumeDispatchedGeneration = raw.lastResumeDispatchedGeneration ?? 0;
		raw.currentTaskId = raw.currentTaskId ?? null;
		raw.sessionStrategy = parseSessionStrategy(raw.sessionStrategy);
		raw.sessionStrategyFailure = parseSessionStrategyFailure(raw.sessionStrategyFailure);
		raw.pendingSessionReset = raw.pendingSessionReset === true;
		raw.createdAt = raw.createdAt ?? raw.startedAt ?? nowIso();
		raw.updatedAt = raw.updatedAt ?? raw.createdAt;
		raw.archivedAt = raw.archivedAt ?? null;
		return raw as LoopState;
	}

	function loadState(ctx: ExtensionContext, name: string, archived = false): LoopState | null {
		const db = openDb(ctx);
		void ctx;
		void archived;
		return stateFromDb(db, name, false);
	}

	function saveState(ctx: ExtensionContext, state: LoopState, archived = false): void {
		state.active = state.status === "active";
		state.updatedAt = nowIso();
		const db = openDb(ctx);
		withTransaction(db, () => {
			upsertLoop(db, state);
		});
		void archived;
	}

	function listLoops(ctx: ExtensionContext, archived = false): LoopState[] {
		const db = openDb(ctx);
		return listStatesFromDb(db, archived);
	}

	function migratePlan(raw: Partial<RalphPlan>, loopName: string): RalphPlan {
		const createdAt = raw.meta?.createdAt ?? nowIso();
		const updatedAt = raw.meta?.updatedAt ?? createdAt;
		const tasks = Array.isArray(raw.tasks)
			? raw.tasks.map((task, index) => ({
					id: typeof task.id === "string" && task.id ? task.id : `task-${index + 1}`,
					title: typeof task.title === "string" && task.title ? task.title : `Task ${index + 1}`,
					status: parseTaskStatus(task.status) ?? "todo",
					order: typeof task.order === "number" ? task.order : index + 1,
					details: typeof task.details === "string" && task.details ? task.details : undefined,
					evidence: Array.isArray(task.evidence) ? task.evidence.filter((item): item is string => typeof item === "string") : [],
					notes: Array.isArray(task.notes) ? task.notes.filter((item): item is string => typeof item === "string") : [],
				}))
			: [];
		const maxTaskNumber = tasks.reduce((max, task) => {
			const match = /^task-(\d+)$/.exec(task.id);
			return match ? Math.max(max, parseInt(match[1], 10)) : max;
		}, 0);

		return {
			version: 1,
			loopName,
			title: typeof raw.title === "string" && raw.title ? raw.title : loopName,
			summary: typeof raw.summary === "string" ? raw.summary : "",
			goals: Array.isArray(raw.goals) ? raw.goals.filter((item): item is string => typeof item === "string") : [],
			tasks: tasks.sort((a, b) => a.order - b.order).map((task, index) => ({ ...task, order: index + 1 })),
			notes: Array.isArray(raw.notes)
				? raw.notes
						.filter((note): note is RalphNote => !!note && typeof note.text === "string")
						.map((note) => ({ at: typeof note.at === "string" ? note.at : createdAt, text: note.text }))
				: [],
			reflections: Array.isArray(raw.reflections)
				? raw.reflections
						.filter((entry): entry is RalphReflection => !!entry && typeof entry.text === "string")
						.map((entry) => ({
							at: typeof entry.at === "string" ? entry.at : createdAt,
							iteration: typeof entry.iteration === "number" ? entry.iteration : 0,
							text: entry.text,
						}))
				: [],
			verification: Array.isArray(raw.verification)
				? raw.verification
						.filter((entry): entry is RalphVerificationEntry => !!entry && typeof entry.text === "string")
						.map((entry) => ({ at: typeof entry.at === "string" ? entry.at : createdAt, text: entry.text }))
				: [],
			meta: {
				createdAt,
				updatedAt,
				nextTaskNumber:
					typeof raw.meta?.nextTaskNumber === "number" && raw.meta.nextTaskNumber > maxTaskNumber
						? raw.meta.nextTaskNumber
						: maxTaskNumber + 1,
				importedFromMarkdown: raw.meta?.importedFromMarkdown === true,
			},
		};
	}

	function loadPlan(ctx: ExtensionContext, name: string, archived = false): RalphPlan | null {
		const db = openDb(ctx);
		void ctx;
		void archived;
		return planFromDb(db, name);
	}

	function savePlan(ctx: ExtensionContext, plan: RalphPlan, archived = false): void {
		plan.tasks = plan.tasks.sort((a, b) => a.order - b.order).map((task, index) => ({ ...task, order: index + 1 }));
		plan.meta.updatedAt = nowIso();
		const db = openDb(ctx);
		withTransaction(db, () => {
			replacePlan(db, plan);
			const loop = stateFromDb(db, plan.loopName, archived);
			if (loop) {
				loop.updatedAt = plan.meta.updatedAt;
				upsertLoop(db, loop);
			}
		});
		void archived;
	}

	function truncateForPrompt(text: string, maxChars = PROMPT_FIELD_MAX_CHARS): string {
		const normalized = text.replace(/\s+/g, " ").trim();
		if (normalized.length <= maxChars) return normalized;
		return `${normalized.slice(0, maxChars)}... [truncated ${normalized.length - maxChars} chars]`;
	}

	function formatPromptTask(task: RalphTask): string {
		const lines = [`- [${task.status === "done" ? "x" : " "}] \`${task.id}\` ${truncateForPrompt(task.title, 220)} (${TASK_STATUS_LABELS[task.status]})`];
		if (task.details?.trim()) lines.push(`  Details: ${truncateForPrompt(task.details)}`);
		if (task.evidence.length > 0) {
			const evidence = task.evidence.slice(-PROMPT_MAX_TASK_EVIDENCE).map((item) => truncateForPrompt(item, 260));
			lines.push(`  Recent evidence: ${evidence.join(" | ")}${task.evidence.length > evidence.length ? ` (+${task.evidence.length - evidence.length} older)` : ""}`);
		}
		if (task.notes.length > 0) {
			const notes = task.notes.slice(-PROMPT_MAX_TASK_NOTES).map((item) => truncateForPrompt(item, 260));
			lines.push(`  Recent notes: ${notes.join(" | ")}${task.notes.length > notes.length ? ` (+${task.notes.length - notes.length} older)` : ""}`);
		}
		return lines.join("\n");
	}

	function capPromptPlan(text: string): string {
		if (text.length <= PROMPT_PLAN_MAX_CHARS) return text;
		return `${text.slice(0, PROMPT_PLAN_MAX_CHARS)}\n\n[Prompt plan truncated by ${text.length - PROMPT_PLAN_MAX_CHARS} chars. Use Graphify first for broader repo context, then fall back to docs or Ralph tools as needed.]`;
	}

	function selectInitialTask(plan: RalphPlan): RalphTask | null {
		return plan.tasks.find((task) => task.status === "in_progress") ?? plan.tasks.find((task) => task.status === "todo") ?? plan.tasks.find((task) => task.status === "blocked") ?? null;
	}

	function inferCurrentTaskId(plan: RalphPlan): string | null {
		const inProgress = plan.tasks.filter((task) => task.status === "in_progress");
		if (inProgress.length === 1) return inProgress[0].id;
		return null;
	}

	function isPlanComplete(plan: RalphPlan): boolean {
		return plan.tasks.length > 0 && plan.tasks.every((task) => task.status === "done" || task.status === "cancelled");
	}

	function selectNextTask(plan: RalphPlan, preferredTaskId?: string | null, currentTaskId?: string | null): RalphTask | null {
		if (preferredTaskId) {
			const preferredTask = findTask(plan, preferredTaskId);
			if (preferredTask && preferredTask.status !== "done" && preferredTask.status !== "cancelled") {
				return preferredTask;
			}
		}
		if (currentTaskId) {
			const currentTask = findTask(plan, currentTaskId);
			if (currentTask && currentTask.status !== "done" && currentTask.status !== "cancelled") {
				return currentTask;
			}
			const currentIndex = plan.tasks.findIndex((task) => task.id === currentTaskId);
			if (currentIndex >= 0) {
				for (let i = currentIndex + 1; i < plan.tasks.length; i++) {
					const nextTask = plan.tasks[i];
					if (nextTask.status !== "done" && nextTask.status !== "cancelled") return nextTask;
				}
				for (let i = 0; i < currentIndex; i++) {
					const nextTask = plan.tasks[i];
					if (nextTask.status !== "done" && nextTask.status !== "cancelled") return nextTask;
				}
			}
		}
		return plan.tasks.find((task) => task.status !== "done" && task.status !== "cancelled") ?? null;
	}

	function planToPromptText(state: LoopState, plan: RalphPlan): string {
		const counts = {
			todo: 0,
			in_progress: 0,
			blocked: 0,
			done: 0,
			cancelled: 0,
		};
		for (const task of plan.tasks) counts[task.status]++;

		const sections = [`# ${truncateForPrompt(plan.title, 220)}`];
		if (plan.summary.trim()) sections.push(truncateForPrompt(plan.summary, PROMPT_SUMMARY_MAX_CHARS));
		sections.push(
			`Minimal runtime view. Full canonical state remains in the Ralph database; use Ralph tools only when you need more than the next task.`,
			`Tasks: ${plan.tasks.length} total, ${counts.done} done, ${counts.in_progress} in progress, ${counts.blocked} blocked, ${counts.todo} todo, ${counts.cancelled} cancelled.`,
		);

		if (plan.goals.length > 0) {
			const goals = plan.goals.slice(0, PROMPT_MAX_GOALS).map((goal) => `- ${truncateForPrompt(goal, 260)}`);
			if (plan.goals.length > goals.length) goals.push(`- ${plan.goals.length - goals.length} additional goals omitted from prompt.`);
			sections.push("## Goals", ...goals);
		}

		const nextTask = selectNextTask(plan, state.currentTaskId, state.currentTaskId);
		sections.push(
			"## Next Task",
			nextTask
				? formatPromptTask(nextTask)
				: "- No active task found. If all work is complete, respond with the completion marker.",
		);

			sections.push(
				"## How To Proceed",
				"- Start with the next task above.",
				"- If the next task is ambiguous, use Graphify first for repo context, then use the relevant docs or Ralph tools as needed.",
				"- If the task is blocked, either unblock it directly or call ralph_update_task with a concise blocker note and move to the next available task.",
				"- Do not review old notes, reflections, or completed-task history unless the next task requires it.",
			);

		return capPromptPlan(sections.join("\n\n"));
	}

	function summarizePlan(plan: RalphPlan): string {
		const counts = {
			todo: 0,
			in_progress: 0,
			blocked: 0,
			done: 0,
			cancelled: 0,
		};
		for (const task of plan.tasks) counts[task.status]++;
		return [
			`${plan.title}`,
			plan.summary ? `Summary: ${plan.summary}` : "",
			`Tasks: ${plan.tasks.length} total, ${counts.done} done, ${counts.in_progress} in progress, ${counts.blocked} blocked, ${counts.todo} todo, ${counts.cancelled} cancelled`,
		]
			.filter(Boolean)
			.join("\n");
	}

	function buildPlanPreview(plan: RalphPlan, status?: TaskStatus): string {
		const tasks = plan.tasks.filter((task) => !status || task.status === status);
		const lines = tasks.flatMap((task) => {
			const parts = [`- ${task.id} [${task.status}] ${task.title}`];
			if (task.details?.trim()) parts.push(`  Details: ${truncateForPrompt(task.details, 220)}`);
			return parts;
		});
		return [summarizePlan(plan), "", ...(lines.length > 0 ? lines : ["No matching tasks."])].join("\n");
	}

	function buildCompactPlanResponse(
		plan: RalphPlan,
		options: { status?: TaskStatus; maxTasks?: number; currentTaskId?: string | null } = {},
	): string {
		const maxTasks = Math.max(1, Math.min(50, Math.floor(options.maxTasks ?? GET_PLAN_DEFAULT_MAX_TASKS)));
		const nextTask = selectNextTask(plan, options.currentTaskId, options.currentTaskId);
		const candidateTasks = plan.tasks.filter((task) =>
			options.status ? task.status === options.status : task.status !== "done" && task.status !== "cancelled",
		);
		const visibleTasks = candidateTasks.slice(0, maxTasks);
		const sections = [
			summarizePlan(plan),
			"",
				"Current task:",
				nextTask ? formatPromptTask(nextTask) : "- No active task found.",
			"",
			`Tasks${options.status ? ` [${options.status}]` : " [open]"}:`,
			...(visibleTasks.length > 0
				? visibleTasks.flatMap((task) => {
						const parts = [`- ${task.id} [${task.status}] ${truncateForPrompt(task.title, 180)}`];
						if (task.details?.trim()) parts.push(`  Details: ${truncateForPrompt(task.details, 220)}`);
						return parts;
					})
				: ["- No matching tasks."]),
		];
		if (candidateTasks.length > visibleTasks.length) {
			sections.push(`- ${candidateTasks.length - visibleTasks.length} additional matching task(s) omitted. Use ralph_list_tasks with a status filter if needed.`);
		}

		if (plan.verification.length > 0) {
			sections.push(
				"",
				"Recent verification:",
				...plan.verification.slice(-GET_PLAN_MAX_VERIFICATION).map((entry) => `- ${truncateForPrompt(entry.text, 220)}`),
			);
		}
		if (plan.notes.length > 0) {
			sections.push("", "Recent notes:", ...plan.notes.slice(-GET_PLAN_MAX_NOTES).map((note) => `- ${truncateForPrompt(note.text, 220)}`));
		}
		if (plan.reflections.length > 0) {
			sections.push(
				"",
				"Recent reflections:",
				...plan.reflections
					.slice(-GET_PLAN_MAX_REFLECTIONS)
					.map((entry) => `- Iteration ${entry.iteration}: ${truncateForPrompt(entry.text, 220)}`),
			);
		}
		sections.push("", "Use ralph_list_tasks with a status filter for a narrower task list.");
		return sections.join("\n");
	}

	function normalizePlanText(lines: string[]): string {
		return lines.map((line) => line.trim()).filter(Boolean).join("\n");
	}

	function parseLegacyMarkdownPlan(content: string, loopName: string): RalphPlan {
		const lines = content.split(/\r?\n/);
		let title = loopName;
		let summary = "";
		let section = "summary";
		let sectionLabel = "Summary";
		let sectionStarted = false;
		let taskContextHeading = "";
		const goals: string[] = [];
		const tasks: RalphTask[] = [];
		const notes: RalphNote[] = [];
		const verification: RalphVerificationEntry[] = [];
		const summaryLines: string[] = [];
		let nextTaskNumber = 1;
		let currentSectionLines: string[] = [];

		const flushSectionLines = () => {
			const text = normalizePlanText(currentSectionLines);
			currentSectionLines = [];
			if (!text) return;
			if (section === "summary") {
				summaryLines.push(text);
			} else if (section === "goals") {
				if (summaryLines.length === 0) summaryLines.push(text);
				else notes.push({ at: nowIso(), text: `${sectionLabel}: ${text}` });
			} else if (section === "notes") {
				notes.push({ at: nowIso(), text });
			} else if (section === "verification") {
				verification.push({ at: nowIso(), text });
			} else if (section === "tasks") {
				const prefix = taskContextHeading ? `${sectionLabel} / ${taskContextHeading}` : sectionLabel;
				notes.push({ at: nowIso(), text: `${prefix}: ${text}` });
			} else {
				notes.push({ at: nowIso(), text: `${sectionLabel}: ${text}` });
			}
		};

		for (const rawLine of lines) {
			const line = rawLine.trim();
			if (line.startsWith("# ")) {
				title = line.slice(2).trim() || loopName;
				continue;
			}
			if (line.startsWith("### ")) {
				flushSectionLines();
				taskContextHeading = line.slice(4).trim();
				if (section !== "tasks") {
					currentSectionLines.push(taskContextHeading);
				}
				continue;
			}
			if (line.startsWith("## ")) {
				flushSectionLines();
				const header = line.slice(3).trim().toLowerCase();
				sectionStarted = true;
				taskContextHeading = "";
				sectionLabel = line.slice(3).trim();
				if (header === "goal" || header === "goals") section = "goals";
				else if (header === "checklist" || header === "tasks") section = "tasks";
				else if (header === "notes") section = "notes";
				else if (header === "verification") section = "verification";
				else section = "other";
				continue;
			}
			if (section === "goals" && line.startsWith("- ")) {
				goals.push(line.slice(2).trim());
				continue;
			}
			if (section === "tasks") {
				const match = /^- \[([ xX])\] (.+)$/.exec(line);
				if (match) {
					tasks.push({
						id: `task-${nextTaskNumber++}`,
						title: match[2].trim(),
						status: match[1].toLowerCase() === "x" ? "done" : "todo",
						order: tasks.length + 1,
						evidence: [],
						notes: [],
					});
					continue;
				}
			}
			if (line) currentSectionLines.push(line);
			else flushSectionLines();
		}

		flushSectionLines();
		summary = summaryLines.join("\n\n");
		if (!summary && sectionStarted) {
			summary = `Imported Ralph task content for ${title}. Review notes and tasks for preserved context.`;
		}

		if (tasks.length === 0) {
			tasks.push({
				id: "task-1",
				title: "Review imported plan",
				status: "todo",
				order: 1,
				details: "Task content could not be cleanly mapped to structured tasks.",
				evidence: [],
				notes: [content.trim()],
			});
			nextTaskNumber = 2;
		}

		return migratePlan(
			{
				loopName,
				title,
				summary,
				goals,
				tasks,
				notes,
				reflections: [],
				verification,
				meta: {
					createdAt: nowIso(),
					updatedAt: nowIso(),
					nextTaskNumber,
					importedFromMarkdown: true,
				},
			},
			loopName,
		);
	}

	function ensurePlan(ctx: ExtensionContext, state: LoopState, sourceContent?: string): RalphPlan {
		const existingPlan = loadPlan(ctx, state.name, !!state.archivedAt);
		if (existingPlan) {
			return existingPlan;
		}

		const rawContent = sourceContent ?? DEFAULT_TEMPLATE;
		const plan = parseLegacyMarkdownPlan(rawContent, state.name);
		savePlan(ctx, plan, !!state.archivedAt);
		return plan;
	}

	function getPlanState(ctx: ExtensionContext, loopName?: string): { state: LoopState; plan: RalphPlan } | null {
		const state = resolveLoopState(ctx, loopName);
		if (!state) return null;
		const plan = ensurePlan(ctx, state);
		if (!state.currentTaskId) {
			const inferredTaskId = inferCurrentTaskId(plan);
			if (inferredTaskId) {
				state.currentTaskId = inferredTaskId;
				saveState(ctx, state);
				recordLoopEvent(ctx, state.name, "current_task_backfill", "Backfilled current task from canonical plan state", state.iteration, {
					currentTaskId: inferredTaskId,
				});
			}
		}
		return { state, plan };
	}

	function resolveLoopName(ctx: ExtensionContext, loopName?: string): string | null {
		if (loopName) return loopName;
		if (currentLoop) {
			const current = loadState(ctx, currentLoop);
			if (current) return currentLoop;
			currentLoop = null;
		}
		const selected = loadSelectedLoopName(ctx);
		if (!selected) return null;
		currentLoop = selected;
		return selected;
	}

	function resolveLoopState(ctx: ExtensionContext, loopName?: string): LoopState | null {
		const resolvedName = resolveLoopName(ctx, loopName);
		if (!resolvedName) return null;
		const state = loadState(ctx, resolvedName);
		if (!state) return null;
		if (state.status === "active") currentLoop = state.name;
		return state;
	}

	function findTask(plan: RalphPlan, taskId: string): RalphTask | null {
		return plan.tasks.find((task) => task.id === taskId) ?? null;
	}

	function nextTaskId(plan: RalphPlan): string {
		const id = `task-${plan.meta.nextTaskNumber}`;
		plan.meta.nextTaskNumber += 1;
		return id;
	}

	function addVerification(plan: RalphPlan, text: string): void {
		plan.verification.push({ at: nowIso(), text });
	}

	function recordLoopEvent(ctx: ExtensionContext, loopId: string, kind: string, body?: string, iteration?: number, meta?: unknown): void {
		const db = openDb(ctx);
		db.prepare(`
			INSERT INTO loop_events (loop_id, kind, body, iteration, created_at, meta_json)
			VALUES (?, ?, ?, ?, ?, ?)
		`).run(loopId, kind, body ?? null, iteration ?? null, nowIso(), meta ? JSON.stringify(meta) : null);
	}

	function formatLoop(l: LoopState): string {
		const status = `${STATUS_ICONS[l.status]} ${l.status}`;
		const iter = l.maxIterations > 0 ? `${l.iteration}/${l.maxIterations}` : `${l.iteration}`;
		const currentTask = l.currentTaskId ? ` · task ${l.currentTaskId}` : "";
		return `${l.name}: ${status} (iteration ${iter})${currentTask}`;
	}

	function updateUI(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const state = resolveLoopState(ctx, currentLoop ?? undefined);
		if (!state) {
			ctx.ui.setStatus("ralph", undefined);
			ctx.ui.setWidget("ralph", undefined);
			return;
		}
		const { theme } = ctx.ui;
		const maxStr = state.maxIterations > 0 ? `/${state.maxIterations}` : "";
		const reflection =
			state.reflectEvery > 0
				? ` · 🪞 reflect in ${state.reflectEvery - ((state.iteration - 1) % state.reflectEvery)}`
				: "";
		const title = theme.fg("success", theme.bold("Ralph Wiggum"));
		const status = theme.fg(
			"dim",
			` · 🔁 ${state.name} · ${STATUS_ICONS[state.status]} ${state.status} · 🔢 ${state.iteration}${maxStr}${reflection}${state.currentTaskId ? ` · 📌 ${state.currentTaskId}` : ""} · Esc pause · msg resume · /ralph-stop stop`,
		);
		ctx.ui.setStatus("ralph", `${title}${status}`);
		ctx.ui.setWidget("ralph", undefined);
	}

	function buildPrompt(ctx: ExtensionContext, state: LoopState, taskContent: string, isReflection: boolean): string {
		const maxStr = state.maxIterations > 0 ? `/${state.maxIterations}` : "";
		const header = `───────────────────────────────────────────────────────────────────────
🔄 RALPH LOOP: ${state.name} | Iteration ${state.iteration}${maxStr}${isReflection ? " | 🪞 REFLECTION" : ""}
───────────────────────────────────────────────────────────────────────`;
		const parts = [header, ""];
		if (isReflection) parts.push(state.reflectInstructions, "\n---\n");
		parts.push(`## Current Plan Runtime View (compact; sourced from the Ralph database)\n\n${taskContent}\n\n---`);
		parts.push(`\n## Instructions\n`);
		parts.push("User controls: ESC pauses the assistant. Send a message to resume. Run /ralph-stop when idle to stop the loop.\n");
		parts.push("## Momentum");
		parts.push("- Aim for the smallest useful step that reduces uncertainty.");
		parts.push("- If you already know the next concrete action, take it now.");
		parts.push("- If you need more context, fetch only the missing detail that blocks progress.");
		parts.push("- Keep planning brief, then switch back to tools.");
		parts.push("- Good iterations usually look like: inspect, act, verify, report.");
		parts.push("");
		parts.push(`You are in a Ralph loop (iteration ${state.iteration}${state.maxIterations > 0 ? ` of ${state.maxIterations}` : ""}).\n`);
		if (state.itemsPerIteration > 0) {
			parts.push(`**THIS ITERATION: Process approximately ${state.itemsPerIteration} task items, then call the actual ralph_done tool.**\n`);
			parts.push(`1. Start from the single Next Task in the runtime view, then inspect additional tasks only if you need up to ~${state.itemsPerIteration} items for this iteration.`);
		} else {
			parts.push("1. Start from the single Next Task in the runtime view.");
		}
		parts.push("2. Use Graphify first for repo navigation and file/symbol lookup when you need broader context.");
		parts.push("3. Move straight to the next concrete step instead of recapping the plan.");
		parts.push("4. Update Ralph task state and evidence as you go.");
		parts.push("5. When the current iteration is complete, call the actual ralph_done tool to proceed to the next iteration.");
		return parts.join("\n");
	}

	function buildResetPrompt(ctx: ExtensionContext, state: LoopState, taskContent: string, isReflection: boolean): string {
		return `${SESSION_RESET_MARKER}\n\n${buildPrompt(ctx, state, taskContent, isReflection)}`;
	}

	function getIterationContent(ctx: ExtensionContext, state: LoopState): { content: string; needsReflection: boolean } | null {
		const plan = ensurePlan(ctx, state);
		const content = planToPromptText(state, plan);
		const needsReflection = state.reflectEvery > 0 && (state.iteration - 1) % state.reflectEvery === 0;
		return { content, needsReflection };
	}

	function dispatchNextIterationFollowUp(ctx: ExtensionContext, state: LoopState, taskContent: string, needsReflection: boolean): void {
		pi.sendUserMessage(buildPrompt(ctx, state, taskContent, needsReflection), { deliverAs: "followUp" });
	}

	function dispatchNextIterationResetFollowUp(ctx: ExtensionContext, state: LoopState, taskContent: string, needsReflection: boolean): void {
		pi.sendUserMessage(buildResetPrompt(ctx, state, taskContent, needsReflection), { deliverAs: "followUp" });
	}

	function isNaturalAssistantStop(message: any): boolean {
		return message?.role === "assistant" && message.stopReason === "stop";
	}

	function messageText(message: any): string {
		if (typeof message?.content === "string") return message.content;
		if (!Array.isArray(message?.content)) return "";
		return message.content
			.filter((part: any) => part?.type === "text" && typeof part.text === "string")
			.map((part: any) => part.text)
			.join("\n");
	}

	function lastResetPromptMessage(messages: any[]): any | null {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message?.role !== "user") continue;
			if (messageText(message).includes(SESSION_RESET_MARKER)) return message;
			return null;
		}
		return null;
	}

	async function dispatchNextIterationFreshContext(ctx: ExtensionContext, state: LoopState): Promise<void> {
		const iterationData = getIterationContent(ctx, state);
		if (!iterationData) {
			pauseLoop(ctx, state, `Paused Ralph loop: ${state.name}. Could not read Ralph plan state from the database.`);
			return;
		}
		const { content, needsReflection } = iterationData;
		if (state.sessionStrategy === "newSession") {
			const parentSession = ctx.sessionManager.getSessionFile() ?? undefined;
			const result = await ctx.newSession({
				parentSession,
				withSession: async (replacementCtx) => {
					await replacementCtx.sendUserMessage(buildResetPrompt(replacementCtx, state, content, needsReflection));
				},
			});
			if (result.cancelled) {
				const failureMessage = `Paused Ralph loop: ${state.name}. Failed to create a fresh session.`;
				if (state.sessionStrategyFailure === "stopAndAlert") {
					pauseLoop(ctx, state, failureMessage);
					return;
				}
				state.pendingSessionReset = true;
				saveState(ctx, state);
				dispatchNextIterationResetFollowUp(ctx, state, content, needsReflection);
				return;
			}
			return;
		}
		state.pendingSessionReset = true;
		saveState(ctx, state);
		dispatchNextIterationResetFollowUp(ctx, state, content, needsReflection);
	}

	function logCompactionResumeDecision(
		ctx: ExtensionContext,
		state: LoopState,
		kind: string,
		meta: Record<string, unknown>,
		message?: string,
	): void {
		recordLoopEvent(ctx, state.name, kind, message ?? kind, state.iteration, meta);
	}

	function maybeDispatchCompactionResume(ctx: ExtensionContext, state: LoopState, trigger: string): boolean {
		if (state.status !== "active") return false;
		if (!state.pendingSessionReset) return false;
		if (state.resumeGeneration <= state.lastResumeDispatchedGeneration) {
			logCompactionResumeDecision(ctx, state, "compaction_resume_skip", {
				trigger,
				reason: "already_dispatched",
				resumeGeneration: state.resumeGeneration,
				lastResumeDispatchedGeneration: state.lastResumeDispatchedGeneration,
			});
			return false;
		}
		if (ctx.hasPendingMessages()) {
			logCompactionResumeDecision(ctx, state, "compaction_resume_deferred", {
				trigger,
				reason: "pending_messages",
				resumeGeneration: state.resumeGeneration,
				lastResumeDispatchedGeneration: state.lastResumeDispatchedGeneration,
			});
			return false;
		}
		state.lastResumeDispatchedGeneration = state.resumeGeneration;
		state.pendingSessionReset = false;
		saveState(ctx, state);
		logCompactionResumeDecision(ctx, state, "compaction_resume_dispatch", {
			trigger,
			resumeGeneration: state.resumeGeneration,
			lastResumeDispatchedGeneration: state.lastResumeDispatchedGeneration,
		});
		return true;
	}

	function pauseLoop(ctx: ExtensionContext, state: LoopState, message?: string): void {
		state.status = "paused";
		state.active = false;
		state.pendingSessionReset = false;
		saveState(ctx, state);
		recordLoopEvent(ctx, state.name, "pause", message ?? "Paused Ralph loop", state.iteration);
		currentLoop = null;
		updateUI(ctx);
		if (message && ctx.hasUI) ctx.ui.notify(message, "info");
	}

	function completeLoop(ctx: ExtensionContext, state: LoopState, banner: string): void {
		state.status = "completed";
		state.completedAt = nowIso();
		state.active = false;
		state.pendingSessionReset = false;
		saveState(ctx, state);
		recordLoopEvent(ctx, state.name, "complete", banner, state.iteration);
		currentLoop = null;
		updateUI(ctx);
		pi.sendUserMessage(banner);
	}

	function stopLoop(ctx: ExtensionContext, state: LoopState, message?: string): void {
		state.status = "completed";
		state.completedAt = nowIso();
		state.active = false;
		state.pendingSessionReset = false;
		saveState(ctx, state);
		recordLoopEvent(ctx, state.name, "stop", message ?? "Stopped Ralph loop", state.iteration);
		currentLoop = null;
		updateUI(ctx);
		if (message && ctx.hasUI) ctx.ui.notify(message, "info");
	}

	function parseArgs(argsStr: string) {
		const tokens = argsStr.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
		const result = {
			name: "",
			maxIterations: 50,
			itemsPerIteration: 0,
			reflectEvery: 0,
			reflectInstructions: DEFAULT_REFLECT_INSTRUCTIONS,
			sessionStrategy: "newSession" as SessionStrategy,
			sessionStrategyFailure: "followUp" as SessionStrategyFailure,
		};
		for (let i = 0; i < tokens.length; i++) {
			const tok = tokens[i];
			const next = tokens[i + 1];
			if (tok === "--max-iterations" && next) {
				result.maxIterations = parseInt(next, 10) || 0;
				i++;
			} else if (tok === "--items-per-iteration" && next) {
				result.itemsPerIteration = parseInt(next, 10) || 0;
				i++;
			} else if (tok === "--reflect-every" && next) {
				result.reflectEvery = parseInt(next, 10) || 0;
				i++;
			} else if (tok === "--reflect-instructions" && next) {
				result.reflectInstructions = next.replace(/^"|"$/g, "");
				i++;
			} else if (tok === "--session-strategy" && next) {
				result.sessionStrategy = parseSessionStrategy(next.replace(/^"|"$/g, ""));
				i++;
			} else if (tok === "--session-strategy-failure" && next) {
				result.sessionStrategyFailure = parseSessionStrategyFailure(next.replace(/^"|"$/g, ""));
				i++;
			} else if (!tok.startsWith("--")) {
				result.name = tok;
			}
		}
		return result;
	}

	function parseTaskListArgs(rest: string): { loopName?: string; status?: TaskStatus } {
		const tokens = rest.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
		const result: { loopName?: string; status?: TaskStatus } = {};
		for (let i = 0; i < tokens.length; i++) {
			const tok = tokens[i];
			const next = tokens[i + 1];
			if (tok === "--status" && next) {
				const status = parseTaskStatus(next.replace(/^"|"$/g, ""));
				if (status) result.status = status;
				i++;
			} else if (!tok.startsWith("--") && !result.loopName) {
				result.loopName = tok;
			}
		}
		return result;
	}

	function applyLoopArgs(state: LoopState, args: ReturnType<typeof parseArgs>): void {
		state.maxIterations = args.maxIterations;
		state.itemsPerIteration = args.itemsPerIteration;
		state.reflectEvery = args.reflectEvery;
		state.reflectInstructions = args.reflectInstructions;
		state.sessionStrategy = args.sessionStrategy;
		state.sessionStrategyFailure = args.sessionStrategyFailure;
	}

	function registerPlanCommand(name: string, _description: string, handler: (rest: string, ctx: any) => void | Promise<void>): void {
		commands[name] = handler;
	}

	async function resumeLoopByName(ctx: any, loopName: string): Promise<void> {
		const state = resolveLoopState(ctx, loopName);
		if (!state) {
			ctx.ui.notify(`Loop "${loopName}" not found`, "error");
			return;
		}
		if (currentLoop && currentLoop !== loopName) {
			const curr = resolveLoopState(ctx, currentLoop);
			if (curr) pauseLoop(ctx, curr);
		}

		state.status = "active";
		state.active = true;
		state.completedAt = undefined;
		state.iteration++;
		saveState(ctx, state);
		recordLoopEvent(ctx, state.name, "resume", "Resumed Ralph loop", state.iteration, { sessionStrategy: state.sessionStrategy });
		const plan = ensurePlan(ctx, state);
		if (!state.currentTaskId) {
			state.currentTaskId = inferCurrentTaskId(plan);
			if (!state.currentTaskId) state.currentTaskId = selectInitialTask(plan)?.id ?? null;
			if (state.currentTaskId) saveState(ctx, state);
		}
		setSelectedLoopName(ctx, loopName);
		updateUI(ctx);
		ctx.ui.notify(`Resumed: ${loopName} (iteration ${state.iteration})`, "info");

		const needsReflection = state.reflectEvery > 0 && state.iteration > 1 && (state.iteration - 1) % state.reflectEvery === 0;
		if (state.sessionStrategy === "newSession") {
			await dispatchNextIterationFreshContext(ctx, state);
			return;
		}
		dispatchNextIterationFollowUp(ctx, state, planToPromptText(state, plan), needsReflection);
	}

	const commands: Record<string, (rest: string, ctx: any) => void | Promise<void>> = {
		async start(rest, ctx) {
			const args = parseArgs(rest);
			if (!args.name) {
				ctx.ui.notify(
					"Usage: /ralph start <name|path> [--items-per-iteration N] [--reflect-every N] [--max-iterations N] [--session-strategy MODE] [--session-strategy-failure MODE]",
					"warning",
				);
				return;
			}

			const isPath = args.name.includes("/") || args.name.includes("\\");
			const loopName = isPath ? sanitize(path.basename(args.name, path.extname(args.name))) : args.name;
			const existing = loadState(ctx, loopName);
			if (existing) {
				applyLoopArgs(existing, args);
				saveState(ctx, existing);
				await resumeLoopByName(ctx, loopName);
				return;
			}

			const state: LoopState = {
				name: loopName,
				taskFile: "",
				iteration: 1,
				maxIterations: args.maxIterations,
				itemsPerIteration: args.itemsPerIteration,
				reflectEvery: args.reflectEvery,
				reflectInstructions: args.reflectInstructions,
				active: true,
				status: "active",
				startedAt: existing?.startedAt || nowIso(),
				lastReflectionAt: 0,
				lastDoneReminderAt: 0,
				resumeGeneration: 0,
				lastResumeDispatchedGeneration: 0,
				sessionStrategy: args.sessionStrategy,
				sessionStrategyFailure: args.sessionStrategyFailure,
				pendingSessionReset: false,
			};

				saveState(ctx, state);
				const initialPlan = ensurePlan(ctx, state);
				savePlan(ctx, initialPlan, false);
				if (!state.currentTaskId) {
					state.currentTaskId = inferCurrentTaskId(initialPlan);
					if (!state.currentTaskId) state.currentTaskId = selectInitialTask(initialPlan)?.id ?? null;
					if (state.currentTaskId) saveState(ctx, state);
				}
				setSelectedLoopName(ctx, loopName);
			recordLoopEvent(ctx, state.name, "start", "Started Ralph loop", state.iteration, { sessionStrategy: state.sessionStrategy });
			updateUI(ctx);
			if (state.sessionStrategy === "newSession") {
				await dispatchNextIterationFreshContext(ctx, state);
				return;
			}
			dispatchNextIterationFollowUp(ctx, state, planToPromptText(state, initialPlan), false);
		},

		stop(_rest, ctx) {
			if (!currentLoop) {
				const selected = loadSelectedLoopName(ctx);
				if (!selected) {
					ctx.ui.notify("No active Ralph loop", "warning");
					return;
				}
				const active = resolveLoopState(ctx, selected);
				if (active && active.status === "active") pauseLoop(ctx, active, `Paused Ralph loop: ${active.name} (iteration ${active.iteration})`);
				else ctx.ui.notify(`Loop "${selected}" is not active`, "warning");
				return;
			}
			const state = resolveLoopState(ctx, currentLoop);
			if (state) pauseLoop(ctx, state, `Paused Ralph loop: ${currentLoop} (iteration ${state.iteration})`);
		},

		async resume(rest, ctx) {
			const requestedName = rest.trim();
			let loopName = requestedName;
			if (!loopName) {
				if (currentLoop) {
					const current = resolveLoopState(ctx, currentLoop);
					if (current) loopName = currentLoop;
				}
				if (!loopName) loopName = loadSelectedLoopName(ctx) ?? "";
				if (!loopName) {
					ctx.ui.notify("No selected Ralph loop found. Use /ralph resume <name>.", "warning");
					return;
				}
			}
			await resumeLoopByName(ctx, loopName);
		},

		status(_rest, ctx) {
			const loops = listLoops(ctx);
			if (loops.length === 0) {
				ctx.ui.notify("No Ralph loops found.", "info");
				return;
			}
			ctx.ui.notify(`Ralph loops:\n${loops.map((l) => formatLoop(l)).join("\n")}`, "info");
		},

		cancel(rest, ctx) {
			const loopName = rest.trim();
			if (!loopName) {
				ctx.ui.notify("Usage: /ralph cancel <name>", "warning");
				return;
			}
			if (!loadState(ctx, loopName)) {
				ctx.ui.notify(`Loop "${loopName}" not found`, "error");
				return;
			}
			if (currentLoop === loopName) currentLoop = null;
			deleteLoop(ctx, loopName);
			ctx.ui.notify(`Cancelled: ${loopName}`, "info");
			updateUI(ctx);
		},

		archive(rest, ctx) {
			const loopName = rest.trim();
			if (!loopName) {
				ctx.ui.notify("Usage: /ralph archive <name>", "warning");
				return;
			}
			const state = loadState(ctx, loopName);
			if (!state) {
				ctx.ui.notify(`Loop "${loopName}" not found`, "error");
				return;
			}
			if (state.status === "active") {
				ctx.ui.notify("Cannot archive active loop. Stop it first.", "warning");
				return;
			}
			if (currentLoop === loopName) currentLoop = null;
			state.archivedAt = nowIso();
			saveState(ctx, state, true);
			const plan = ensurePlan(ctx, state);
			savePlan(ctx, plan, !!state.archivedAt);

			ctx.ui.notify(`Archived: ${loopName}`, "info");
			updateUI(ctx);
		},

		clean(rest, ctx) {
			const all = rest.trim() === "--all";
			const completed = listLoops(ctx).filter((l) => l.status === "completed");
			if (completed.length === 0) {
				ctx.ui.notify("No completed loops to clean", "info");
				return;
			}
			for (const loop of completed) {
				deleteLoop(ctx, loop.name);
				if (currentLoop === loop.name) currentLoop = null;
			}
			const suffix = all ? " (all records)" : " (database records)";
			ctx.ui.notify(`Cleaned ${completed.length} loop(s)${suffix}:\n${completed.map((l) => `  • ${l.name}`).join("\n")}`, "info");
			updateUI(ctx);
		},

		list(rest, ctx) {
			const archived = rest.trim() === "--archived";
			const loops = listLoops(ctx, archived);
			if (loops.length === 0) {
				ctx.ui.notify(archived ? "No archived loops" : "No loops found. Use /ralph list --archived for archived.", "info");
				return;
			}
			const label = archived ? "Archived loops" : "Ralph loops";
			ctx.ui.notify(`${label}:\n${loops.map((l) => formatLoop(l)).join("\n")}`, "info");
		},

		nuke(rest, ctx) {
			const force = rest.trim() === "--yes";
			const warning = "This deletes all Ralph database records and the database file.";
			const run = () => {
				const dir = ralphDir(ctx);
				if (!fs.existsSync(dir)) {
					if (ctx.hasUI) ctx.ui.notify("No Ralph database found.", "info");
					return;
				}
				currentLoop = null;
				dbHandle = null;
				const ok = tryRemoveDir(dir);
				if (ctx.hasUI) ctx.ui.notify(ok ? "Removed Ralph database directory." : "Failed to remove Ralph database directory.", ok ? "info" : "error");
				updateUI(ctx);
			};
			if (!force) {
				if (ctx.hasUI) {
					void ctx.ui.confirm("Delete all Ralph loop data?", warning).then((confirmed) => {
						if (confirmed) run();
					});
				} else {
					ctx.ui.notify(`Run /ralph nuke --yes to confirm. ${warning}`, "warning");
				}
				return;
			}
			if (ctx.hasUI) ctx.ui.notify(warning, "warning");
			run();
		},
	};

	registerPlanCommand("list-tasks", "List tasks for a loop", (rest, ctx) => {
		const args = parseTaskListArgs(rest);
		const result = getPlanState(ctx, args.loopName);
		if (!result) {
			ctx.ui.notify(args.loopName ? `Loop "${args.loopName}" not found` : "No active Ralph loop", "warning");
			return;
		}
		ctx.ui.notify(buildPlanPreview(result.plan, args.status), "info");
	});

	registerPlanCommand("show-plan", "Show plan summary", (rest, ctx) => {
		const loopName = rest.trim() || undefined;
		const result = getPlanState(ctx, loopName);
		if (!result) {
			ctx.ui.notify(loopName ? `Loop "${loopName}" not found` : "No active Ralph loop", "warning");
			return;
		}
		ctx.ui.notify(buildPlanPreview(result.plan), "info");
	});

		registerPlanCommand("task", "Quick task status updates", (rest, ctx) => {
			const [action, taskId, ...loopParts] = rest.trim().split(/\s+/).filter(Boolean);
			if (!action || !taskId || (action !== "done" && action !== "block")) {
				ctx.ui.notify("Usage: /ralph task <done|block> <task-id> [loop]", "warning");
				return;
		}
		const loopName = loopParts[0];
		const result = getPlanState(ctx, loopName);
		if (!result) {
			ctx.ui.notify(loopName ? `Loop "${loopName}" not found` : "No active Ralph loop", "warning");
			return;
		}
		const task = findTask(result.plan, taskId);
		if (!task) {
			ctx.ui.notify(`Task "${taskId}" not found`, "error");
			return;
		}
		task.status = action === "done" ? "done" : "blocked";
		addVerification(result.plan, `Task ${task.id} marked ${task.status} via /ralph task.`);
		if ((action === "done" || action === "block") && result.state.currentTaskId === task.id) {
			result.state.currentTaskId = selectNextTask(result.plan, null, task.id)?.id ?? null;
		}
			savePlan(ctx, result.plan, !!result.state.archivedAt);
			saveState(ctx, result.state);
			ctx.ui.notify(`Updated ${task.id}: ${task.title} -> ${task.status}`, "info");
		});

		registerPlanCommand("set-max-iterations", "Update a loop's max iteration limit", (rest, ctx) => {
			const [value, ...loopParts] = rest.trim().split(/\s+/).filter(Boolean);
			const maxIterations = Number.parseInt(value ?? "", 10);
			if (!value || Number.isNaN(maxIterations) || maxIterations < 0) {
				ctx.ui.notify("Usage: /ralph set-max-iterations <N> [loop]", "warning");
				return;
			}
			const loopName = loopParts[0];
			const result = getPlanState(ctx, loopName);
			if (!result) {
				ctx.ui.notify(loopName ? `Loop "${loopName}" not found` : "No active Ralph loop", "warning");
				return;
			}
			result.state.maxIterations = maxIterations;
			saveState(ctx, result.state);
			recordLoopEvent(ctx, result.state.name, "set_max_iterations", `Set max iterations to ${maxIterations}`, result.state.iteration, {
				maxIterations,
			});
			updateUI(ctx);
			ctx.ui.notify(`Updated ${result.state.name}: max iterations = ${maxIterations}`, "info");
		});

		registerPlanCommand("set-iteration", "Set the current iteration value", (rest, ctx) => {
			const [value, ...loopParts] = rest.trim().split(/\s+/).filter(Boolean);
			const iteration = Number.parseInt(value ?? "", 10);
			if (!value || Number.isNaN(iteration) || iteration < 0) {
				ctx.ui.notify("Usage: /ralph set-iteration <N>=0+ [loop]", "warning");
				return;
			}
			const loopName = loopParts[0];
			const result = getPlanState(ctx, loopName);
			if (!result) {
				ctx.ui.notify(loopName ? `Loop "${loopName}" not found` : "No active Ralph loop", "warning");
				return;
			}
			result.state.iteration = iteration;
			result.state.lastDoneReminderAt = 0;
			saveState(ctx, result.state);
			recordLoopEvent(ctx, result.state.name, "set_iteration", `Set iteration to ${iteration}`, result.state.iteration, {
				iteration,
			});
			updateUI(ctx);
			ctx.ui.notify(`Updated ${result.state.name}: iteration = ${iteration}`, "info");
		});

		registerPlanCommand("set-session-strategy", "Update a loop's next-iteration session strategy", (rest, ctx) => {
			const [value, ...loopParts] = rest.trim().split(/\s+/).filter(Boolean);
			const sessionStrategy = parseSessionStrategy(value);
			if (!value || (value !== "followUp" && value !== "newSession")) {
				ctx.ui.notify("Usage: /ralph set-session-strategy <followUp|newSession> [loop]", "warning");
				return;
			}
			const loopName = loopParts[0];
			const result = getPlanState(ctx, loopName);
			if (!result) {
				ctx.ui.notify(loopName ? `Loop "${loopName}" not found` : "No active Ralph loop", "warning");
				return;
			}
			result.state.sessionStrategy = sessionStrategy;
			saveState(ctx, result.state);
			recordLoopEvent(ctx, result.state.name, "set_session_strategy", `Set session strategy to ${sessionStrategy}`, result.state.iteration, {
				sessionStrategy,
			});
			updateUI(ctx);
			ctx.ui.notify(`Updated ${result.state.name}: session strategy = ${sessionStrategy}`, "info");
		});

	const HELP = `Ralph Wiggum - Long-running development loops

Commands:
  /ralph start <name|path> [options]  Start a new loop
  /ralph stop                         Pause current loop
  /ralph resume [name]                Resume a paused loop
  /ralph status                       Show all loops
	/ralph show-plan [loop]             Show structured plan summary
	/ralph list-tasks [loop] [--status STATUS]  Show structured tasks
	/ralph task <done|block> <task-id> [loop]   Quick task update
	/ralph set-max-iterations <N> [loop]   Update max iterations for a loop
	/ralph set-iteration <N> [loop]         Set the current iteration value (0+)
	/ralph set-session-strategy <followUp|newSession> [loop]   Update next-iteration session strategy
  /ralph cancel <name>                Delete loop state
  /ralph archive <name>               Move loop to archive
  /ralph clean [--all]                Clean completed loops
  /ralph list --archived              Show archived loops
  /ralph nuke [--yes]                 Delete all Ralph database data
  /ralph-stop                         Stop active loop (idle only)

Options:
  --items-per-iteration N  Suggest N items per turn (prompt hint)
  --reflect-every N        Reflect every N iterations
  --max-iterations N       Stop after N iterations (default 50)
  --session-strategy MODE  Next-iteration dispatch: followUp or newSession
  --session-strategy-failure MODE  Compatibility-only; currently unused

To stop: press ESC to interrupt, then run /ralph-stop when idle`;

	pi.registerCommand("ralph", {
		description: "Ralph Wiggum - long-running development loops",
		handler: async (args, ctx) => {
			const [cmd] = args.trim().split(/\s+/);
			const handler = commands[cmd];
			if (handler) await handler(args.slice(cmd.length).trim(), ctx);
			else ctx.ui.notify(HELP, "info");
		},
	});

	pi.registerCommand("ralph-stop", {
		description: "Stop active Ralph loop (idle only)",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				if (ctx.hasUI) ctx.ui.notify("Agent is busy. Press ESC to interrupt, then run /ralph-stop.", "warning");
				return;
			}
			let state = resolveLoopState(ctx, currentLoop ?? undefined);
			if (!state) {
				const selected = loadSelectedLoopName(ctx);
				if (!selected) {
					if (ctx.hasUI) ctx.ui.notify("No active Ralph loop", "warning");
					return;
				}
				state = resolveLoopState(ctx, selected);
			}
			if (!state) {
				if (ctx.hasUI) ctx.ui.notify("No active Ralph loop", "warning");
				return;
			}
			if (state.status !== "active") {
				if (ctx.hasUI) ctx.ui.notify(`Loop "${state.name}" is not active`, "warning");
				return;
			}
			stopLoop(ctx, state, `Stopped Ralph loop: ${state.name} (iteration ${state.iteration})`);
		},
	});

	pi.registerTool({
		name: "ralph_get_plan",
		label: "Get Ralph Plan",
		description: "Return a compact summary of the active loop or a named loop.",
		promptSnippet: "Inspect Ralph's compact plan summary without loading bulky plan state into context.",
		promptGuidelines: [
			"Use this only when the runtime prompt and ralph_list_tasks do not provide enough context.",
			"Use ralph_list_tasks with a status filter when you only need task ids and titles.",
		],
		parameters: Type.Object({
			loopName: Type.Optional(Type.String({ description: "Optional loop name. Defaults to the active loop." })),
			status: Type.Optional(Type.String({ description: "Optional task status filter: todo, in_progress, blocked, done, cancelled." })),
			maxTasks: Type.Optional(Type.Number({ description: "Maximum matching task summaries to include. Default 12, max 50." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = getPlanState(ctx, params.loopName);
			if (!result) return { content: [{ type: "text", text: "Ralph loop not found." }], details: {} };
			return {
				content: [
					{
						type: "text",
						text: buildCompactPlanResponse(result.plan, {
							status: parseTaskStatus(params.status) ?? undefined,
							maxTasks: params.maxTasks,
							currentTaskId: result.state.currentTaskId,
						}),
					},
				],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "ralph_list_tasks",
		label: "List Ralph Tasks",
		description: "List ordered tasks for the active loop or a named loop.",
		promptSnippet: "Get a compact view of Ralph tasks and statuses.",
		promptGuidelines: ["Use this to identify the next tasks to work on without reading bulky plan state."],
		parameters: Type.Object({
			loopName: Type.Optional(Type.String({ description: "Optional loop name. Defaults to the active loop." })),
			status: Type.Optional(Type.String({ description: "Optional status filter: todo, in_progress, blocked, done, cancelled." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = getPlanState(ctx, params.loopName);
			if (!result) return { content: [{ type: "text", text: "Ralph loop not found." }], details: {} };
			const status = parseTaskStatus(params.status);
			return { content: [{ type: "text", text: buildPlanPreview(result.plan, status ?? undefined) }], details: {} };
		},
	});

	pi.registerTool({
		name: "ralph_add_task",
		label: "Add Ralph Task",
		description: "Add a task to the structured Ralph plan.",
		promptSnippet: "Create newly discovered Ralph work items.",
		promptGuidelines: ["Use this when new tasks emerge during iteration so plan state stays canonical."],
		parameters: Type.Object({
			title: Type.String({ description: "Short task title." }),
			details: Type.Optional(Type.String({ description: "Optional task details." })),
			loopName: Type.Optional(Type.String({ description: "Optional loop name. Defaults to the active loop." })),
			position: Type.Optional(Type.Number({ description: "Optional 1-based insertion position." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = getPlanState(ctx, params.loopName);
			if (!result) return { content: [{ type: "text", text: "Ralph loop not found." }], details: {} };
			const task: RalphTask = {
				id: nextTaskId(result.plan),
				title: params.title.trim(),
				status: "todo",
				order: result.plan.tasks.length + 1,
				details: params.details?.trim() || undefined,
				evidence: [],
				notes: [],
			};
			if (params.position && params.position > 0 && params.position <= result.plan.tasks.length) {
				result.plan.tasks.splice(params.position - 1, 0, task);
			} else {
				result.plan.tasks.push(task);
			}
			addVerification(result.plan, `Task ${task.id} added: ${task.title}`);
			savePlan(ctx, result.plan, !!result.state.archivedAt);
			return { content: [{ type: "text", text: `Added ${task.id}: ${task.title}` }], details: {} };
		},
	});

	pi.registerTool({
		name: "ralph_update_task",
		label: "Update Ralph Task",
		description: "Update a task in the structured Ralph plan by stable id.",
		promptSnippet: "Mutate Ralph task state safely through the database.",
		promptGuidelines: ["Use this to update task status, details, notes, or evidence after making progress."],
		parameters: Type.Object({
			taskId: Type.String({ description: "Stable Ralph task id." }),
			loopName: Type.Optional(Type.String({ description: "Optional loop name. Defaults to the active loop." })),
			status: Type.Optional(Type.String({ description: "Optional new status: todo, in_progress, blocked, done, cancelled." })),
			title: Type.Optional(Type.String({ description: "Optional replacement title." })),
			details: Type.Optional(Type.String({ description: "Optional replacement details." })),
			note: Type.Optional(Type.String({ description: "Optional note to append to the task." })),
			evidence: Type.Optional(Type.String({ description: "Optional evidence entry to append to the task." })),
			position: Type.Optional(Type.Number({ description: "Optional 1-based reorder position." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = getPlanState(ctx, params.loopName);
			if (!result) return { content: [{ type: "text", text: "Ralph loop not found." }], details: {} };
			const task = findTask(result.plan, params.taskId);
			if (!task) return { content: [{ type: "text", text: `Task "${params.taskId}" not found.` }], details: {} };
			if (params.status !== undefined) {
				const status = parseTaskStatus(params.status);
				if (!status) return { content: [{ type: "text", text: `Invalid task status: ${params.status}` }], details: {} };
				task.status = status;
			}
			if (params.title !== undefined) task.title = params.title.trim() || task.title;
			if (params.details !== undefined) task.details = params.details.trim() || undefined;
			if (params.note?.trim()) task.notes.push(params.note.trim());
			if (params.evidence?.trim()) {
				task.evidence.push(params.evidence.trim());
				addVerification(result.plan, `${task.id}: ${params.evidence.trim()}`);
			}
			if (params.position && params.position > 0) {
				const withoutTask = result.plan.tasks.filter((item) => item.id !== task.id);
				const index = Math.min(params.position - 1, withoutTask.length);
				withoutTask.splice(index, 0, task);
				result.plan.tasks = withoutTask;
			}
			if (params.status === "in_progress") {
				result.state.currentTaskId = task.id;
			} else if ((params.status === "done" || params.status === "cancelled" || params.status === "blocked") && result.state.currentTaskId === task.id) {
				result.state.currentTaskId = selectNextTask(result.plan, null, task.id)?.id ?? null;
			}
			saveState(ctx, result.state);
			savePlan(ctx, result.plan, !!result.state.archivedAt);
			return { content: [{ type: "text", text: `Updated ${task.id}: ${task.title} [${task.status}]` }], details: {} };
		},
	});

	pi.registerTool({
		name: "ralph_add_note",
		label: "Add Ralph Note",
		description: "Append a timestamped loop-level note to the structured Ralph plan.",
		promptSnippet: "Record narrative progress, blockers, or decisions in canonical Ralph state.",
		promptGuidelines: ["Use this for freeform notes that do not belong on a specific task."],
		parameters: Type.Object({
			text: Type.String({ description: "Loop-level note text." }),
			loopName: Type.Optional(Type.String({ description: "Optional loop name. Defaults to the active loop." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = getPlanState(ctx, params.loopName);
			if (!result) return { content: [{ type: "text", text: "Ralph loop not found." }], details: {} };
			result.plan.notes.push({ at: nowIso(), text: params.text.trim() });
			savePlan(ctx, result.plan, !!result.state.archivedAt);
			return { content: [{ type: "text", text: "Added Ralph note." }], details: {} };
		},
	});

	pi.registerTool({
		name: "ralph_record_reflection",
		label: "Record Ralph Reflection",
		description: "Append a structured reflection entry for the current Ralph iteration.",
		promptSnippet: "Persist Ralph reflection checkpoints in canonical state.",
		promptGuidelines: ["Use this during reflection iterations instead of writing directly to the database."],
		parameters: Type.Object({
			text: Type.String({ description: "Reflection text." }),
			loopName: Type.Optional(Type.String({ description: "Optional loop name. Defaults to the active loop." })),
			iteration: Type.Optional(Type.Number({ description: "Optional iteration override. Defaults to the loop's current iteration." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = getPlanState(ctx, params.loopName);
			if (!result) return { content: [{ type: "text", text: "Ralph loop not found." }], details: {} };
			result.plan.reflections.push({
				at: nowIso(),
				iteration: params.iteration ?? result.state.iteration,
				text: params.text.trim(),
			});
			savePlan(ctx, result.plan, !!result.state.archivedAt);
			return { content: [{ type: "text", text: "Recorded Ralph reflection." }], details: {} };
		},
	});

	pi.registerTool({
		name: "ralph_done",
		label: "Ralph Iteration Done",
		description: "Signal that you've completed this iteration of the Ralph loop. Call this after making progress to get the next iteration prompt.",
		promptSnippet: "Advance an active Ralph loop after completing the current iteration.",
		promptGuidelines: [
			"Call this after making real iteration progress so Ralph can queue the next prompt.",
			"Use Ralph plan tools to record task updates before calling this tool.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const state = resolveLoopState(ctx);
			if (!state) return { content: [{ type: "text", text: "No active Ralph loop." }], details: {} };
			if (!state || state.status !== "active") return { content: [{ type: "text", text: "Ralph loop is not active." }], details: {} };
			if (ctx.hasPendingMessages()) {
				return { content: [{ type: "text", text: "Pending messages already queued. Skipping ralph_done." }], details: {} };
			}
			state.iteration++;
			recordLoopEvent(ctx, state.name, "ralph_done", "Iteration advanced", state.iteration, { sessionStrategy: state.sessionStrategy });
			if (state.maxIterations > 0 && state.iteration > state.maxIterations) {
				completeLoop(
					ctx,
					state,
					`───────────────────────────────────────────────────────────────────────
⚠️ RALPH LOOP STOPPED: ${state.name} | Max iterations (${state.maxIterations}) reached
───────────────────────────────────────────────────────────────────────`,
				);
				return { content: [{ type: "text", text: "Max iterations reached. Loop stopped." }], details: {} };
			}
			const iterationData = getIterationContent(ctx, state);
			if (!iterationData) {
				pauseLoop(ctx, state);
				return { content: [{ type: "text", text: "Error: Could not read Ralph plan state from the database." }], details: {} };
			}
			const { content, needsReflection } = iterationData;
			if (needsReflection) state.lastReflectionAt = state.iteration;
			saveState(ctx, state);
			updateUI(ctx);
			const checkpointResult = checkpointLoopState(ctx, state);
			if (!checkpointResult.ok) {
				pauseLoop(ctx, state, `Paused Ralph loop: ${state.name}. ${checkpointResult.message}`);
				return { content: [{ type: "text", text: `Error: ${checkpointResult.message}` }], details: {} };
			}
			if (checkpointResult.skipped && ctx.hasUI) {
				ctx.ui.notify(checkpointResult.message, "info");
			}
			const graphifyResult = runGraphifyUpdate(ctx);
			if (!graphifyResult.ok && graphifyResult.message && ctx.hasUI) {
				ctx.ui.notify(graphifyResult.message, graphifyResult.message.includes("skipped") ? "info" : "warning");
			}
			if (state.sessionStrategy === "newSession") {
				state.pendingSessionReset = true;
				saveState(ctx, state);
				return {
					content: [
						{
							type: "text",
							text: `Iteration ${state.iteration - 1} complete. Next iteration queued with fresh provider context.`,
						},
					],
					details: {},
				};
			}
			dispatchNextIterationFollowUp(ctx, state, content, needsReflection);
			return { content: [{ type: "text", text: `Iteration ${state.iteration - 1} complete. Next iteration queued.` }], details: {} };
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const state = resolveLoopState(ctx);
		if (!state || state.status !== "active") return;
		const iterStr = `${state.iteration}${state.maxIterations > 0 ? `/${state.maxIterations}` : ""}`;
		let instructions = "You are in a Ralph loop working from the current Ralph database state.\n";
		const overlay = loadRalphOverlay(ctx);
		if (overlay) instructions += `\n## RALPH.md\n${overlay}\n`;
		instructions += `- Momentum: take the smallest useful step, keep planning brief, and switch back to tools as soon as you can.\n`;
		if (state.itemsPerIteration > 0) instructions += `- Work on ~${state.itemsPerIteration} task items this iteration\n`;
		instructions += `- Start from the Next Task in the runtime prompt and move directly to the next concrete action.\n`;
		instructions += `- If you need more context, use Graphify first for repo navigation and exact file/symbol lookup, then use compact Ralph tools for loop state.\n`;
		instructions += `- Record task state and evidence concisely, then call ralph_done when the iteration is finished.`;
		return {
			systemPrompt: event.systemPrompt + `\n[RALPH LOOP - ${state.name} - Iteration ${iterStr}]\n\n${instructions}`,
		};
	});

	pi.on("context", async (event, ctx) => {
		const state = resolveLoopState(ctx);
		if (!state || state.status !== "active" || !state.pendingSessionReset) return;
		const resetMessage = lastResetPromptMessage(event.messages);
		if (!resetMessage) return;
		state.pendingSessionReset = false;
		saveState(ctx, state);
		return { messages: [resetMessage] };
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const state = resolveLoopState(ctx);
		if (!state || state.status !== "active") return;
		state.resumeGeneration = (state.resumeGeneration ?? 0) + 1;
		state.pendingSessionReset = true;
		saveState(ctx, state);
		recordLoopEvent(ctx, state.name, "session_before_compact", "Pi is compacting the session", state.iteration, {
			reason: event?.reason ?? null,
			willRetry: event?.willRetry ?? null,
			resumeGeneration: state.resumeGeneration,
			lastResumeDispatchedGeneration: state.lastResumeDispatchedGeneration ?? 0,
			pendingSessionReset: state.pendingSessionReset ?? false,
		});
	});

	pi.on("agent_end", async (event, ctx) => {
		let state = resolveLoopState(ctx);
		if (!state || state.status !== "active") return;
		const lastAssistant = [...event.messages].reverse().find((m) => m.role === "assistant");
		const naturalStop = isNaturalAssistantStop(lastAssistant);
		const hasPendingMessages = ctx.hasPendingMessages();
		const text =
			lastAssistant && Array.isArray(lastAssistant.content)
				? lastAssistant.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n")
				: "";
		recordLoopEvent(ctx, state.name, "agent_end_observed", "Pi ended the assistant turn", state.iteration, {
			naturalStop,
			hasPendingMessages,
			pendingSessionReset: state.pendingSessionReset ?? false,
			resumeGeneration: state.resumeGeneration ?? 0,
			lastResumeDispatchedGeneration: state.lastResumeDispatchedGeneration ?? 0,
			lastAssistantStopReason: lastAssistant?.stopReason ?? null,
		});
		const plan = ensurePlan(ctx, state);
		if (isPlanComplete(plan)) {
			completeLoop(
				ctx,
				state,
				`───────────────────────────────────────────────────────────────────────
✅ RALPH LOOP COMPLETE: ${state.name} | ${state.iteration} iterations
───────────────────────────────────────────────────────────────────────`,
			);
			return;
		}
		if (state.maxIterations > 0 && state.iteration >= state.maxIterations) {
			completeLoop(
				ctx,
				state,
				`───────────────────────────────────────────────────────────────────────
⚠️ RALPH LOOP STOPPED: ${state.name} | Max iterations (${state.maxIterations}) reached
───────────────────────────────────────────────────────────────────────`,
			);
			return;
		}
		if (state.pendingSessionReset && maybeDispatchCompactionResume(ctx, state, "agent_end")) {
			state = loadState(ctx, state.name);
			if (!state || state.status !== "active") return;
			await dispatchNextIterationFreshContext(ctx, state);
			return;
		}

		if (!naturalStop) return;

		if (!ctx.hasPendingMessages() && state.lastDoneReminderAt !== state.iteration) {
			state.lastDoneReminderAt = state.iteration;
			saveState(ctx, state);
			const fakeToolCall = FAKE_RALPH_DONE_PATTERN.test(text);
			pi.sendUserMessage(
				fakeToolCall
					? `You wrote text that looks like a ralph_done tool call, but Pi did not execute it. If this iteration is done, call the actual ralph_done tool now using the tool interface. Do not write XML, <invoke>, or placeholder text. If the loop is complete, Ralph state will stop it.`
					: `You are still in Ralph loop "${state.name}" at iteration ${state.iteration}. If you are done with the tasks for this iteration, call the actual ralph_done tool now using the tool interface. If the loop is complete, Ralph state will stop it. Otherwise, continue working on the current iteration and use Ralph tools to update canonical state.`,
				{ deliverAs: "followUp" },
			);
		}
	});

	pi.on("session_start", async (event, ctx) => {
		if (!currentLoop && shouldRestoreLoopOnSessionStart((event as { reason?: unknown })?.reason)) {
			const selected = loadSelectedLoopName(ctx);
			if (selected) currentLoop = selected;
		}
		const state = resolveLoopState(ctx);
		if (state && state.status === "active" && state.pendingSessionReset) {
			const dispatched = maybeDispatchCompactionResume(ctx, state, "session_start");
			if (dispatched) {
				const reloaded = loadState(ctx, state.name);
				if (reloaded && reloaded.status === "active") {
					await dispatchNextIterationFreshContext(ctx, reloaded);
				}
			}
		}
		updateUI(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const state = resolveLoopState(ctx);
		if (state) saveState(ctx, state);
	});
}
