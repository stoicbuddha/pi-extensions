import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Type } from "@sinclair/typebox";

const STORE_DIR = ".ralph";
const STORE_FILE = "ralph.sqlite";
const META_CURRENT_LOOP_NAME = "current_loop_name";
const FAKE_RALPH_DONE_PATTERN = /<(?:invoke|tool_use|tool|function_call)\b[^>]*(?:name=["']ralph_done["']|ralph_done)[\s\S]*?<\/(?:invoke|tool_use|tool|function_call)>|<ralph_done\b[^>]*\/?>/i;

const DEFAULT_REFLECT_INSTRUCTIONS = `REFLECTION CHECKPOINT

Pause and reflect on your progress:
1. What has been accomplished so far?
2. What's working well?
3. What's not working or blocking progress?
4. Should the approach be adjusted?
5. What are the next priorities?

Record your reflection with Ralph tools, then continue working.`;
const PROMPT_MAX_CHARS = 7000;
const HANDOFF_PROMPT_MAX_CHARS = 18000;
const HANDOFF_SUMMARY_MAX_CHARS = 8000;
const HANDOFF_RATIONALE_MAX_CHARS = 3200;
const HANDOFF_STEP_MAX_CHARS = 420;
const HANDOFF_MAX_STEPS = 10;
const HANDOFF_STATE_MAX_ITEMS = 8;
const HANDOFF_STATE_TEXT_MAX_CHARS = 420;
const PROMPT_FIELD_MAX_CHARS = 400;
const PROMPT_TASK_TITLE_MAX_CHARS = 220;
const PROMPT_TASK_WINDOW = 3;
const GRAPHIFY_QUERY_LIMIT = 3;
const GRAPHIFY_HINT_LIMIT = 8;
const GRAPHIFY_CONTEXT_ITEM_LIMIT = 6;
const GRAPHIFY_QUERY_BUDGET = 700;
const GRAPHIFY_QUERY_NOTE_MAX_CHARS = 220;
const RALPH_CONTEXT_START = "<!-- RALPH_LOOP_CONTEXT_START -->";
const RALPH_CONTEXT_END = "<!-- RALPH_LOOP_CONTEXT_END -->";
let latestSessionControlCtx = null;
let latestLoopHint = null;
const sessionLoopHints = new Map();
const RALPH_DEBUG_LOG = "/tmp/pi-ralph-loop-detector.log";

function nowIso() {
  return new Date().toISOString();
}

function debugLog(message) {
  const line = typeof message === "string" ? message : String(message);
  try {
    fs.appendFileSync(RALPH_DEBUG_LOG, `${line}\n`, "utf8");
  } catch {
    // Ignore logging failures; they must never affect loop execution.
  }
}

function rememberSessionControlCtx(ctx) {
  if (!ctx || typeof ctx.newSession !== "function") return;
  latestSessionControlCtx = ctx;
}

function getSessionControlCtx(ctx) {
  if (ctx && typeof ctx.newSession === "function") return ctx;
  if (latestSessionControlCtx && typeof latestSessionControlCtx.newSession === "function") {
    return latestSessionControlCtx;
  }
  return ctx;
}

function getSessionHintKey(ctx) {
  const sessionFile = ctx?.sessionManager?.getSessionFile?.();
  return typeof sessionFile === "string" && sessionFile ? sessionFile : null;
}

function rememberLoopHint(ctx, loopName) {
  if (typeof loopName !== "string" || !loopName.trim()) return;
  latestLoopHint = loopName;
  const key = getSessionHintKey(ctx);
  if (key) sessionLoopHints.set(key, loopName);
}

function getLoopHint(ctx) {
  const key = getSessionHintKey(ctx);
  if (key && sessionLoopHints.has(key)) {
    return sessionLoopHints.get(key) ?? null;
  }
  return latestLoopHint;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function storePath(ctx) {
  return path.join(ctx.cwd, STORE_DIR, STORE_FILE);
}

function loadRalphOverlay(ctx) {
  const overlayPath = path.resolve(ctx.cwd, "RALPH.md");
  if (!fs.existsSync(overlayPath)) return null;
  const content = fs.readFileSync(overlayPath, "utf-8");
  const trimmed = content.trim();
  return trimmed || null;
}

function ensureStoreDir(ctx) {
  fs.mkdirSync(path.dirname(storePath(ctx)), { recursive: true });
}

function schemaSql() {
  return `
CREATE TABLE IF NOT EXISTS schema_meta (
\tkey TEXT PRIMARY KEY,
\tvalue TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ralph_meta (
\tkey TEXT PRIMARY KEY,
\tvalue TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS loops (
\tid TEXT PRIMARY KEY,
\tname TEXT NOT NULL UNIQUE,
\ttask_file TEXT NOT NULL,
\tstatus TEXT NOT NULL,
\titeration INTEGER NOT NULL,
\tmax_iterations INTEGER NOT NULL,
\titems_per_iteration INTEGER NOT NULL,
\treflect_every INTEGER NOT NULL,
\treflect_instructions TEXT NOT NULL,
\tsession_strategy TEXT NOT NULL,
\tsession_strategy_failure TEXT NOT NULL,
\tpending_session_reset INTEGER NOT NULL DEFAULT 0,
\tlast_reflection_at INTEGER NOT NULL DEFAULT 0,
\tlast_done_reminder_at INTEGER NOT NULL DEFAULT 0,
\tresume_generation INTEGER NOT NULL DEFAULT 0,
\tlast_resume_dispatched_generation INTEGER NOT NULL DEFAULT 0,
\tpending_handoff INTEGER NOT NULL DEFAULT 0,
\tpending_handoff_reason TEXT,
\tpending_handoff_prompt TEXT,
\tpending_handoff_created_at TEXT,
\tpending_handoff_generation INTEGER NOT NULL DEFAULT 0,
\tlast_handoff_dispatched_generation INTEGER NOT NULL DEFAULT 0,
\tpending_handoff_command_queued INTEGER NOT NULL DEFAULT 0,
\tcurrent_task_id TEXT,
\tstarted_at TEXT NOT NULL,
\tcompleted_at TEXT,
\tcreated_at TEXT NOT NULL,
\tupdated_at TEXT NOT NULL,
\tarchived_at TEXT
);

CREATE TABLE IF NOT EXISTS plans (
\tloop_id TEXT PRIMARY KEY REFERENCES loops(id) ON DELETE CASCADE,
\ttitle TEXT NOT NULL,
\tsummary TEXT NOT NULL,
\tnext_task_number INTEGER NOT NULL,
\timported_from_markdown INTEGER NOT NULL DEFAULT 0,
\tcreated_at TEXT NOT NULL,
\tupdated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plan_goals (
\tid INTEGER PRIMARY KEY AUTOINCREMENT,
\tloop_id TEXT NOT NULL REFERENCES loops(id) ON DELETE CASCADE,
\tgoal TEXT NOT NULL,
\torder_index INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
\tid TEXT PRIMARY KEY,
\tloop_id TEXT NOT NULL REFERENCES loops(id) ON DELETE CASCADE,
\ttask_key TEXT NOT NULL,
\ttitle TEXT NOT NULL,
\tstatus TEXT NOT NULL,
\torder_index INTEGER NOT NULL,
\tdetails TEXT,
\tmeta_json TEXT,
\tcreated_at TEXT NOT NULL,
\tupdated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_entries (
\tid INTEGER PRIMARY KEY AUTOINCREMENT,
\tloop_id TEXT NOT NULL REFERENCES loops(id) ON DELETE CASCADE,
\ttask_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
\tkind TEXT NOT NULL,
\tbody TEXT NOT NULL,
\titeration INTEGER,
\tcreated_at TEXT NOT NULL,
\tmeta_json TEXT
);

CREATE TABLE IF NOT EXISTS loop_entries (
\tid INTEGER PRIMARY KEY AUTOINCREMENT,
\tloop_id TEXT NOT NULL REFERENCES loops(id) ON DELETE CASCADE,
\tkind TEXT NOT NULL,
\tbody TEXT NOT NULL,
\titeration INTEGER,
\tcreated_at TEXT NOT NULL,
\tmeta_json TEXT
);
`;
}

function ensureLoopColumns(db) {
  const columns = new Set(
    db.prepare("PRAGMA table_info(loops)").all().map((row) => row.name),
  );
  const additions = [
    ["pending_handoff", "pending_handoff INTEGER NOT NULL DEFAULT 0"],
    ["pending_handoff_reason", "pending_handoff_reason TEXT"],
    ["pending_handoff_prompt", "pending_handoff_prompt TEXT"],
    ["pending_handoff_created_at", "pending_handoff_created_at TEXT"],
    ["pending_handoff_generation", "pending_handoff_generation INTEGER NOT NULL DEFAULT 0"],
    ["last_handoff_dispatched_generation", "last_handoff_dispatched_generation INTEGER NOT NULL DEFAULT 0"],
    ["pending_handoff_command_queued", "pending_handoff_command_queued INTEGER NOT NULL DEFAULT 0"],
  ];

  for (const [name, sql] of additions) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE loops ADD COLUMN ${sql};`);
    }
  }
}

function ensureTaskColumns(db) {
  const columns = new Set(
    db.prepare("PRAGMA table_info(tasks)").all().map((row) => row.name),
  );
  if (!columns.has("meta_json")) {
    db.exec("ALTER TABLE tasks ADD COLUMN meta_json TEXT;");
  }
}

function openDb(ctx) {
  const db = new DatabaseSync(storePath(ctx));
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(schemaSql());
  ensureLoopColumns(db);
  ensureTaskColumns(db);
  db.exec(`INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('schema_version', '1');`);
  return db;
}

function parseJsonObject(value) {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function cleanString(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function cleanStringArray(values, limit = GRAPHIFY_HINT_LIMIT) {
  const list = Array.isArray(values) ? values : typeof values === "string" ? [values] : [];
  const seen = new Set();
  const cleaned = [];
  for (const item of list) {
    const text = cleanString(item).replace(/\s+/g, " ");
    if (!text || seen.has(text)) continue;
    seen.add(text);
    cleaned.push(text);
    if (cleaned.length >= limit) break;
  }
  return cleaned;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return undefined;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeVerificationTarget(value) {
  return cleanStringArray(value, 6);
}

function normalizeTaskContract(input) {
  const source = input && typeof input === "object" ? input : null;
  if (!source) return null;
  const purpose = cleanString(firstDefined(source.purpose, source.goal, source.objective));
  const requiredCodeChanges = cleanStringArray(firstDefined(
    source.requiredCodeChanges,
    source.required_code_changes,
    source.codeChanges,
  ), 6);
  const verificationTarget = normalizeVerificationTarget(firstDefined(
    source.verificationTarget,
    source.verification_target,
    source.verification,
  ));
  if (!purpose && requiredCodeChanges.length === 0 && verificationTarget.length === 0) {
    return null;
  }
  return {
    purpose: purpose || null,
    requiredCodeChanges,
    verificationTarget,
  };
}

function normalizeGraphifyQuery(input) {
  const source = input && typeof input === "object" ? input : null;
  if (!source) return null;
  const question = cleanString(firstDefined(source.question, source.query));
  if (!question) return null;
  const rawMode = cleanString(firstDefined(source.mode, source.traversal)).toLowerCase();
  const mode = rawMode === "dfs" ? "dfs" : "bfs";
  const contexts = cleanStringArray(firstDefined(source.contexts, source.context, source.filters), 4);
  const expected = cleanString(firstDefined(source.expected, source.expect, source.notes));
  const budgetRaw = Number(firstDefined(source.budget, source.tokenBudget));
  const budget = Number.isFinite(budgetRaw)
    ? Math.max(200, Math.min(1400, Math.trunc(budgetRaw)))
    : GRAPHIFY_QUERY_BUDGET;
  return { question, mode, contexts, expected: expected || null, budget };
}

function normalizeGraphifyPlan(input, hints = null) {
  const source = input && typeof input === "object" ? input : null;
  const hintSource = hints && typeof hints === "object" ? hints : source;
  if (!source && !hintSource) return null;
  const likelyPaths = cleanStringArray(firstDefined(
    hintSource?.likelyPaths,
    hintSource?.likely_paths,
    hintSource?.likelyFiles,
    hintSource?.likely_files,
    hintSource?.files,
    hintSource?.paths,
    source?.expectedTargets,
    source?.expected_targets,
  ));
  const likelySymbols = cleanStringArray(firstDefined(
    hintSource?.likelySymbols,
    hintSource?.likely_symbols,
    hintSource?.symbols,
  ));
  const likelySubsystems = cleanStringArray(firstDefined(
    hintSource?.likelySubsystems,
    hintSource?.likely_subsystems,
    hintSource?.subsystems,
    hintSource?.modules,
    hintSource?.relatedModules,
    hintSource?.related_modules,
  ));
  const queries = (Array.isArray(source?.queries) ? source.queries : [])
    .map((query) => normalizeGraphifyQuery(query))
    .filter(Boolean)
    .slice(0, GRAPHIFY_QUERY_LIMIT);

  if (likelyPaths.length === 0 && likelySymbols.length === 0 && likelySubsystems.length === 0 && queries.length === 0) {
    return null;
  }

  return {
    likelyPaths,
    likelySymbols,
    likelySubsystems,
    queries,
  };
}

function normalizeGraphifyContext(input) {
  const source = input && typeof input === "object" ? input : null;
  if (!source) return null;
  const summary = source.summary && typeof source.summary === "object" ? source.summary : {};
  return {
    status: cleanString(source.status) || "error",
    generatedAt: cleanString(source.generatedAt || source.generated_at) || null,
    lastAttemptIteration: Number.isFinite(source.lastAttemptIteration) ? source.lastAttemptIteration : null,
    planFingerprint: cleanString(source.planFingerprint || source.plan_fingerprint) || "",
    graphPath: cleanString(source.graphPath || source.graph_path) || null,
    error: cleanString(source.error) || null,
    summary: {
      likelyFiles: cleanStringArray(summary.likelyFiles || summary.files),
      likelySymbols: cleanStringArray(summary.likelySymbols || summary.symbols),
      likelyCallSites: cleanStringArray(summary.likelyCallSites || summary.callSites || summary.calls),
      relatedArtifacts: cleanStringArray(summary.relatedArtifacts || summary.related || summary.modules),
      queryNotes: cleanStringArray(summary.queryNotes || summary.notes, GRAPHIFY_CONTEXT_ITEM_LIMIT),
    },
  };
}

function normalizeTaskMetadata(input) {
  const source = input && typeof input === "object" ? input : null;
  if (!source) return null;
  const contract = normalizeTaskContract(source.contract ?? source);
  const graphifyPlan = normalizeGraphifyPlan(source.graphifyPlan ?? source.graphify_plan, source.discoveryHints ?? source.discovery_hints ?? source);
  const graphifyContext = normalizeGraphifyContext(source.graphifyContext ?? source.graphify_context);
  if (!contract && !graphifyPlan && !graphifyContext) return null;
  return {
    contract,
    graphifyPlan,
    graphifyContext,
  };
}

function blankStore() {
  return {
    selectedLoopName: null,
    loops: [],
  };
}

function hydrateLoop(db, row) {
  const plan = db.prepare(`SELECT * FROM plans WHERE loop_id = ?`).get(row.id) ?? null;
  const goals = db.prepare(`SELECT goal FROM plan_goals WHERE loop_id = ? ORDER BY order_index ASC`).all(row.id).map((item) => item.goal);
  const tasks = db.prepare(`SELECT * FROM tasks WHERE loop_id = ? ORDER BY order_index ASC`).all(row.id).map((taskRow) => {
    const entries = db.prepare(`SELECT kind, body FROM task_entries WHERE loop_id = ? AND task_id = ? ORDER BY created_at ASC, id ASC`).all(row.id, taskRow.id);
    return {
      id: taskRow.id,
      taskKey: taskRow.task_key,
      title: taskRow.title,
      status: taskRow.status,
      order: taskRow.order_index,
      details: taskRow.details ?? "",
      createdAt: taskRow.created_at,
      updatedAt: taskRow.updated_at,
      metadata: normalizeTaskMetadata(parseJsonObject(taskRow.meta_json)),
      notes: entries.filter((entry) => entry.kind === "note").map((entry) => entry.body),
      evidence: entries.filter((entry) => entry.kind === "evidence").map((entry) => entry.body),
    };
  });
  const loopEntries = db.prepare(`SELECT kind, body, iteration, created_at FROM loop_entries WHERE loop_id = ? ORDER BY created_at ASC, id ASC`).all(row.id);

  return {
    id: row.id,
    name: row.name,
    taskFile: row.task_file,
    title: plan?.title ?? row.name,
    summary: plan?.summary ?? "",
    goals,
    nextTaskNumber: plan?.next_task_number ?? tasks.length + 1,
    importedFromMarkdown: Boolean(plan?.imported_from_markdown),
    status: row.status,
    iteration: row.iteration,
    maxIterations: row.max_iterations,
    itemsPerIteration: row.items_per_iteration,
    reflectEvery: row.reflect_every,
    reflectInstructions: row.reflect_instructions,
    active: row.status === "active",
    startedAt: row.started_at,
    completedAt: row.completed_at,
    lastReflectionAt: row.last_reflection_at,
    lastDoneReminderAt: row.last_done_reminder_at,
    resumeGeneration: row.resume_generation,
    lastResumeDispatchedGeneration: row.last_resume_dispatched_generation,
    pendingHandoff: Boolean(row.pending_handoff),
    pendingHandoffReason: row.pending_handoff_reason ?? null,
    pendingHandoffPrompt: row.pending_handoff_prompt ?? null,
    pendingHandoffCreatedAt: row.pending_handoff_created_at ?? null,
    pendingHandoffGeneration: row.pending_handoff_generation ?? 0,
    lastHandoffDispatchedGeneration: row.last_handoff_dispatched_generation ?? 0,
    pendingHandoffCommandQueued: Boolean(row.pending_handoff_command_queued),
    currentTaskId: row.current_task_id ?? null,
    sessionStrategy: row.session_strategy,
    sessionStrategyFailure: row.session_strategy_failure,
    pendingSessionReset: Boolean(row.pending_session_reset),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? null,
    tasks,
    notes: loopEntries.filter((entry) => entry.kind === "note").map((entry) => ({ at: entry.created_at, text: entry.body })),
    reflections: loopEntries.filter((entry) => entry.kind === "reflection").map((entry) => ({ at: entry.created_at, iteration: entry.iteration ?? 0, text: entry.body })),
    verification: loopEntries.filter((entry) => entry.kind === "verification").map((entry) => ({ at: entry.created_at, text: entry.body })),
  };
}

function loadStore(ctx) {
  if (!ctx?.cwd) return blankStore();
  try {
    const db = openDb(ctx);
    const selectedLoopName =
      db.prepare(`SELECT value FROM ralph_meta WHERE key = ?`).get(META_CURRENT_LOOP_NAME)?.value
      ?? db.prepare(`SELECT name FROM loops WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1`).get()?.name
      ?? null;
    const loopRows = db.prepare(`SELECT * FROM loops ORDER BY updated_at DESC, name DESC`).all();
    const loops = loopRows.map((row) => hydrateLoop(db, row));
    return { selectedLoopName, loops };
  } catch {
    /* ignore malformed store */
  }
  return blankStore();
}

function saveStore(ctx, store) {
  if (!ctx?.cwd) return;
  ensureStoreDir(ctx);
  const db = openDb(ctx);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM task_entries;");
    db.exec("DELETE FROM loop_entries;");
    db.exec("DELETE FROM tasks;");
    db.exec("DELETE FROM plan_goals;");
    db.exec("DELETE FROM plans;");
    db.exec("DELETE FROM loops;");
    db.exec(`DELETE FROM ralph_meta WHERE key = '${META_CURRENT_LOOP_NAME}';`);

    const insertLoop = db.prepare(`
      INSERT INTO loops (
        id, name, task_file, status, iteration, max_iterations, items_per_iteration, reflect_every,
        reflect_instructions, session_strategy, session_strategy_failure, pending_session_reset,
        last_reflection_at, last_done_reminder_at, resume_generation, last_resume_dispatched_generation,
        pending_handoff, pending_handoff_reason, pending_handoff_prompt, pending_handoff_created_at,
        pending_handoff_generation, last_handoff_dispatched_generation, pending_handoff_command_queued,
        current_task_id, started_at, completed_at, created_at, updated_at, archived_at
      ) VALUES (
        @id, @name, @task_file, @status, @iteration, @max_iterations, @items_per_iteration, @reflect_every,
        @reflect_instructions, @session_strategy, @session_strategy_failure, @pending_session_reset,
        @last_reflection_at, @last_done_reminder_at, @resume_generation, @last_resume_dispatched_generation,
        @pending_handoff, @pending_handoff_reason, @pending_handoff_prompt, @pending_handoff_created_at,
        @pending_handoff_generation, @last_handoff_dispatched_generation, @pending_handoff_command_queued,
        @current_task_id, @started_at, @completed_at, @created_at, @updated_at, @archived_at
      )
    `);
    const insertPlan = db.prepare(`
      INSERT INTO plans (loop_id, title, summary, next_task_number, imported_from_markdown, created_at, updated_at)
      VALUES (@loop_id, @title, @summary, @next_task_number, @imported_from_markdown, @created_at, @updated_at)
    `);
    const insertGoal = db.prepare(`INSERT INTO plan_goals (loop_id, goal, order_index) VALUES (?, ?, ?)`);
    const insertTask = db.prepare(`
      INSERT INTO tasks (id, loop_id, task_key, title, status, order_index, details, meta_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertTaskEntry = db.prepare(`
      INSERT INTO task_entries (loop_id, task_id, kind, body, iteration, created_at, meta_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertLoopEntry = db.prepare(`
      INSERT INTO loop_entries (loop_id, kind, body, iteration, created_at, meta_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const loop of store.loops) {
      const loopId = loop.name;
      const createdAt = loop.createdAt ?? loop.startedAt ?? nowIso();
      const updatedAt = loop.updatedAt ?? createdAt;
      insertLoop.run({
        id: loopId,
        name: loop.name,
        task_file: loop.taskFile ?? `.ralph/${loop.name}.md`,
        status: loop.status ?? "active",
        iteration: loop.iteration ?? 1,
        max_iterations: loop.maxIterations ?? 50,
        items_per_iteration: loop.itemsPerIteration ?? 0,
        reflect_every: loop.reflectEvery ?? 0,
        reflect_instructions: loop.reflectInstructions ?? DEFAULT_REFLECT_INSTRUCTIONS,
        session_strategy: loop.sessionStrategy ?? "followUp",
        session_strategy_failure: loop.sessionStrategyFailure ?? "followUp",
        pending_session_reset: loop.pendingSessionReset ? 1 : 0,
        last_reflection_at: loop.lastReflectionAt ?? 0,
        last_done_reminder_at: loop.lastDoneReminderAt ?? 0,
        resume_generation: loop.resumeGeneration ?? 0,
        last_resume_dispatched_generation: loop.lastResumeDispatchedGeneration ?? 0,
        pending_handoff: loop.pendingHandoff ? 1 : 0,
        pending_handoff_reason: loop.pendingHandoffReason ?? null,
        pending_handoff_prompt: loop.pendingHandoffPrompt ?? null,
        pending_handoff_created_at: loop.pendingHandoffCreatedAt ?? null,
        pending_handoff_generation: loop.pendingHandoffGeneration ?? 0,
        last_handoff_dispatched_generation: loop.lastHandoffDispatchedGeneration ?? 0,
        pending_handoff_command_queued: loop.pendingHandoffCommandQueued ? 1 : 0,
        current_task_id: loop.currentTaskId ?? null,
        started_at: loop.startedAt ?? createdAt,
        completed_at: loop.completedAt ?? null,
        created_at: createdAt,
        updated_at: updatedAt,
        archived_at: loop.archivedAt ?? null,
      });

      insertPlan.run({
        loop_id: loopId,
        title: loop.title ?? loop.name,
        summary: loop.summary ?? "",
        next_task_number: loop.nextTaskNumber ?? (Array.isArray(loop.tasks) ? loop.tasks.length + 1 : 1),
        imported_from_markdown: loop.importedFromMarkdown ? 1 : 0,
        created_at: loop.planCreatedAt ?? createdAt,
        updated_at: loop.planUpdatedAt ?? updatedAt,
      });

      for (const [index, goal] of (loop.goals ?? []).entries()) {
        insertGoal.run(loopId, goal, index + 1);
      }

      for (const [index, task] of (loop.tasks ?? []).entries()) {
        const taskId = task.id ?? `${loopId}:task-${index + 1}`;
        const taskKey = task.taskKey ?? taskId.split(":").pop() ?? taskId;
        const taskCreatedAt = task.createdAt ?? createdAt;
        const taskUpdatedAt = task.updatedAt ?? updatedAt;
        insertTask.run(
          taskId,
          loopId,
          taskKey,
          task.title ?? taskId,
          task.status ?? "todo",
          task.order ?? index + 1,
          task.details ?? null,
          JSON.stringify(normalizeTaskMetadata(task.metadata) ?? null),
          taskCreatedAt,
          taskUpdatedAt,
        );
        for (const note of task.notes ?? []) {
          insertTaskEntry.run(loopId, taskId, "note", note, null, taskUpdatedAt, null);
        }
        for (const evidence of task.evidence ?? []) {
          insertTaskEntry.run(loopId, taskId, "evidence", evidence, null, taskUpdatedAt, null);
        }
      }

      for (const note of loop.notes ?? []) {
        insertLoopEntry.run(loopId, "note", note.text, null, note.at ?? createdAt, null);
      }
      for (const reflection of loop.reflections ?? []) {
        insertLoopEntry.run(loopId, "reflection", reflection.text, reflection.iteration ?? null, reflection.at ?? createdAt, null);
      }
      for (const verification of loop.verification ?? []) {
        insertLoopEntry.run(loopId, "verification", verification.text, null, verification.at ?? createdAt, null);
      }
    }

    if (store.selectedLoopName) {
      db.prepare(`INSERT INTO ralph_meta(key, value) VALUES (?, ?)`).run(META_CURRENT_LOOP_NAME, store.selectedLoopName);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function getLoop(store, name) {
  if (!name) {
    return store.loops.find((loop) => loop.name === store.selectedLoopName && loop.status === "active")
      ?? store.loops.find((loop) => loop.status === "active")
      ?? store.loops[0]
      ?? null;
  }
  return store.loops.find((loop) => loop.name === name) ?? null;
}

function persistLoop(ctx, store, loop) {
  loop.updatedAt = nowIso();
  const index = store.loops.findIndex((item) => item.name === loop.name);
  if (index >= 0) store.loops[index] = loop;
  else store.loops.push(loop);
  store.selectedLoopName = loop.name;
  rememberLoopHint(ctx, loop.name);
  saveStore(ctx, store);
}

function parseTasksFromText(text, loopName) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const tasks = [];
  for (const line of lines) {
    const bullet = line.match(/^(?:[-*]|\d+\.)\s+(.*)$/);
    if (bullet) {
      tasks.push(bullet[1].trim());
      continue;
    }
    if (line.startsWith("#")) continue;
    tasks.push(line);
  }

  if (tasks.length === 0) {
    tasks.push(loopName);
  }

  return tasks.map((title, index) => ({
    id: `${loopName}:${String(index + 1).padStart(3, "0")}`,
    title,
    status: "todo",
    order: index + 1,
    details: "",
    metadata: null,
    evidence: [],
    notes: [],
  }));
}

function createLoop(name, args = {}) {
  const tasks = parseTasksFromText(args.taskContent ?? "", name);
  return {
    id: name,
    name,
    status: "active",
    iteration: 1,
    maxIterations: Number.isFinite(args.maxIterations) ? args.maxIterations : 50,
    itemsPerIteration: Number.isFinite(args.itemsPerIteration) ? args.itemsPerIteration : 0,
    reflectEvery: Number.isFinite(args.reflectEvery) ? args.reflectEvery : 0,
    reflectInstructions: args.reflectInstructions ?? DEFAULT_REFLECT_INSTRUCTIONS,
    sessionStrategy: args.sessionStrategy === "followUp" ? "followUp" : "newSession",
    sessionStrategyFailure: args.sessionStrategyFailure === "stopAndAlert" ? "stopAndAlert" : "followUp",
    startedAt: nowIso(),
    completedAt: null,
    archivedAt: null,
    currentTaskId: tasks[0]?.id ?? null,
    pendingHandoff: false,
    pendingHandoffReason: null,
    pendingHandoffPrompt: null,
    pendingHandoffCreatedAt: null,
    pendingHandoffGeneration: 0,
    lastHandoffDispatchedGeneration: 0,
    pendingHandoffCommandQueued: false,
    taskFile: "",
    title: name,
    summary: "",
    goals: [],
    nextTaskNumber: tasks.length + 1,
    importedFromMarkdown: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    tasks,
    notes: [],
    reflections: [],
    verification: [],
  };
}

function findTask(loop, taskId) {
  return loop?.tasks?.find((task) => task.id === taskId) ?? null;
}

function truncateForPrompt(text, maxChars = PROMPT_FIELD_MAX_CHARS) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}... [truncated ${normalized.length - maxChars} chars]`;
}

function addVerification(loop, text) {
  loop.verification.push({ at: nowIso(), text });
}

function runGitCommand(ctx, args) {
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

function isNothingToCommit(output) {
  return /nothing to commit|working tree clean/i.test(output);
}

function buildGitCheckpointMessage(loop) {
  const completedIteration = Math.max(1, loop.iteration - 1);
  return `ralph: ${loop.name} iteration ${completedIteration} checkpoint`;
}

function checkpointLoopState(ctx, loop) {
  const addResult = runGitCommand(ctx, ["add", "."]);
  if (!addResult.ok) {
    return {
      ok: false,
      skipped: false,
      message: `git add . failed: ${[addResult.stderr, addResult.stdout].filter(Boolean).join("\n").trim() || `exit ${addResult.status ?? "unknown"}`}`,
    };
  }

  const commitMessage = buildGitCheckpointMessage(loop);
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

function runGraphifyUpdate(ctx) {
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

function summarizeLoop(loop) {
  const status = loop.status === "active" ? "▶" : loop.status === "paused" ? "⏸" : "✓";
  const taskCount = Array.isArray(loop.tasks) ? loop.tasks.length : 0;
  const current = loop.currentTaskId ? ` · ${loop.currentTaskId}` : "";
  return `${status} ${loop.name} · ${loop.status} · iteration ${loop.iteration}/${loop.maxIterations}${current} · tasks ${taskCount}`;
}

function buildPlanPreview(loop, statusFilter) {
  const tasks = Array.isArray(loop.tasks) ? loop.tasks : [];
  const filtered = statusFilter ? tasks.filter((task) => task.status === statusFilter) : tasks;
  const header = [`Loop: ${loop.name}`, `Status: ${loop.status}`, `Iteration: ${loop.iteration}/${loop.maxIterations}`, `Tasks: ${tasks.length}`];
  const body = filtered.length
    ? filtered.map((task) => `  [${task.status}] ${task.id} ${task.title}${task.details ? ` — ${task.details}` : ""}`).join("\n")
    : "  No matching tasks.";
  return `${header.join("\n")}\n${body}`;
}

function buildCompactPlanResponse(loop, options = {}) {
  const filtered = options.status ? loop.tasks.filter((task) => task.status === options.status) : loop.tasks;
  const maxTasks = Number.isFinite(options.maxTasks) ? Math.max(1, Math.min(50, options.maxTasks)) : 12;
  const lines = [
    `Loop: ${loop.name}`,
    `Status: ${loop.status}`,
    `Iteration: ${loop.iteration}/${loop.maxIterations}`,
    `Next unfinished task: ${selectNextTask(loop)?.id ?? "none"}`,
  ];

  for (const task of filtered.slice(0, maxTasks)) {
    lines.push(`- [${task.status}] ${task.id} ${task.title}`);
  }

  if (filtered.length > maxTasks) {
    lines.push(`... ${filtered.length - maxTasks} more task(s)`);
  }

  return lines.join("\n");
}

function selectNextTask(loop) {
  if (!Array.isArray(loop.tasks) || loop.tasks.length === 0) return null;
  return loop.tasks.find((task) => task.status !== "done" && task.status !== "blocked") ?? null;
}

function selectActiveTask(loop) {
  return findTask(loop, loop?.currentTaskId) ?? selectNextTask(loop);
}

function formatInlineList(items) {
  return items.map((item) => `\`${truncateForPrompt(item, 120)}\``).join(", ");
}

function extractPathCandidates(text) {
  const matches = String(text ?? "").match(/\b(?:[\w.-]+\/)+[\w./-]+\b/g) ?? [];
  return cleanStringArray(matches, GRAPHIFY_CONTEXT_ITEM_LIMIT * 2);
}

function extractSymbolCandidates(text) {
  const matches = String(text ?? "").match(/\b[A-Za-z_]\w*(?:::[A-Za-z_]\w*)+\b|\b[A-Za-z_]\w+\([^)]*\)/g) ?? [];
  return cleanStringArray(matches, GRAPHIFY_CONTEXT_ITEM_LIMIT * 2);
}

function extractContextLines(text, matcher, limit = GRAPHIFY_CONTEXT_ITEM_LIMIT) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[*-]\s*/, ""))
    .filter((line) => line && matcher.test(line))
    .map((line) => truncateForPrompt(line, GRAPHIFY_QUERY_NOTE_MAX_CHARS))
    .filter(Boolean)
    .slice(0, limit);
}

function runGraphifyQuery(ctx, query, graphPath) {
  const args = ["query", query.question, "--budget", String(query.budget ?? GRAPHIFY_QUERY_BUDGET), "--graph", graphPath];
  if (query.mode === "dfs") args.splice(2, 0, "--dfs");
  for (const context of query.contexts ?? []) {
    args.push("--context", context);
  }
  const result = spawnSync("graphify", args, {
    cwd: ctx.cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  if (result.status === 0) {
    return { ok: true, output: stdout };
  }
  const message = [stderr, stdout].filter(Boolean).join("\n").trim() || `exit ${result.status ?? "unknown"}`;
  if (/graph file not found/i.test(message)) {
    return { ok: false, message: "graphify graph not found; skipped preplanned graph context." };
  }
  if (/ENOENT|not found|command not found/i.test(message)) {
    return { ok: false, message: "graphify not available; skipped preplanned graph context." };
  }
  return { ok: false, message: `graphify query failed: ${message}` };
}

function buildGraphifyContextSummary(plan, results) {
  const combinedText = results.map((item) => item.output).join("\n");
  const likelyFiles = cleanStringArray([
    ...(plan.likelyPaths ?? []),
    ...extractPathCandidates(combinedText),
  ], GRAPHIFY_CONTEXT_ITEM_LIMIT);
  const likelySymbols = cleanStringArray([
    ...(plan.likelySymbols ?? []),
    ...extractSymbolCandidates(combinedText),
  ], GRAPHIFY_CONTEXT_ITEM_LIMIT);
  const likelyCallSites = cleanStringArray(extractContextLines(
    combinedText,
    /\b(call|calls|called by|handler|route|endpoint|invoke|dispatch|wires?)\b/i,
  ), GRAPHIFY_CONTEXT_ITEM_LIMIT);
  const relatedArtifacts = cleanStringArray([
    ...(plan.likelySubsystems ?? []),
    ...extractContextLines(combinedText, /\b(module|subsystem|template|test|route|handler|service|repo|controller)\b/i),
  ], GRAPHIFY_CONTEXT_ITEM_LIMIT);
  const queryNotes = cleanStringArray(results.flatMap((result) => {
    const noteLines = String(result.output ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^[*-]\s*/, ""))
      .filter((line) => line && !/^question[:\s]/i.test(line))
      .slice(0, 2)
      .map((line) => truncateForPrompt(`${result.question}: ${line}`, GRAPHIFY_QUERY_NOTE_MAX_CHARS));
    return noteLines;
  }), GRAPHIFY_CONTEXT_ITEM_LIMIT);

  return {
    likelyFiles,
    likelySymbols,
    likelyCallSites,
    relatedArtifacts,
    queryNotes,
  };
}

function ensureTaskGraphifyContext(ctx, store, loop, task) {
  const metadata = normalizeTaskMetadata(task?.metadata);
  const graphifyPlan = metadata?.graphifyPlan ?? null;
  if (!task || !graphifyPlan || !Array.isArray(graphifyPlan.queries) || graphifyPlan.queries.length === 0) {
    return { task, context: metadata?.graphifyContext ?? null };
  }

  const planFingerprint = stableStringify(graphifyPlan);
  const currentContext = normalizeGraphifyContext(metadata?.graphifyContext);
  if (currentContext?.status === "ready" && currentContext.planFingerprint === planFingerprint) {
    task.metadata = { ...metadata, graphifyContext: currentContext };
    return { task, context: currentContext };
  }
  if (currentContext?.planFingerprint === planFingerprint && currentContext.lastAttemptIteration === loop.iteration) {
    task.metadata = { ...metadata, graphifyContext: currentContext };
    return { task, context: currentContext.status === "ready" ? currentContext : null };
  }

  const graphPath = path.join(ctx.cwd, "graphify-out", "graph.json");
  if (!fs.existsSync(graphPath)) {
    const errorContext = {
      status: "error",
      generatedAt: nowIso(),
      lastAttemptIteration: loop.iteration,
      planFingerprint,
      graphPath,
      error: "graphify graph not found; skipped preplanned graph context.",
      summary: { likelyFiles: [], likelySymbols: [], likelyCallSites: [], relatedArtifacts: [], queryNotes: [] },
    };
    task.metadata = { ...metadata, graphifyPlan, graphifyContext: errorContext };
    persistLoop(ctx, store, loop);
    return { task, context: null };
  }

  const results = [];
  for (const query of graphifyPlan.queries) {
    const queryResult = runGraphifyQuery(ctx, query, graphPath);
    if (!queryResult.ok) {
      const errorContext = {
        status: "error",
        generatedAt: nowIso(),
        lastAttemptIteration: loop.iteration,
        planFingerprint,
        graphPath,
        error: queryResult.message,
        summary: { likelyFiles: [], likelySymbols: [], likelyCallSites: [], relatedArtifacts: [], queryNotes: [] },
      };
      task.metadata = { ...metadata, graphifyPlan, graphifyContext: errorContext };
      persistLoop(ctx, store, loop);
      return { task, context: null };
    }
    results.push({ question: query.question, output: queryResult.output, expected: query.expected ?? null });
  }

  const readyContext = {
    status: "ready",
    generatedAt: nowIso(),
    lastAttemptIteration: loop.iteration,
    planFingerprint,
    graphPath,
    error: null,
    summary: buildGraphifyContextSummary(graphifyPlan, results),
  };
  task.metadata = { ...metadata, graphifyPlan, graphifyContext: readyContext };
  persistLoop(ctx, store, loop);
  return { task, context: readyContext };
}

function formatPromptTask(task) {
  const lines = [`- [${task.status === "done" ? "x" : " "}] \`${task.id}\` ${truncateForPrompt(task.title, PROMPT_TASK_TITLE_MAX_CHARS)} (${String(task.status).toUpperCase()})`];
  if (task.details?.trim()) lines.push(`  Details: ${truncateForPrompt(task.details)}`);
  if (Array.isArray(task.evidence) && task.evidence.length > 0) {
    const evidence = task.evidence.slice(-1).map((item) => truncateForPrompt(item, 260)).filter(Boolean);
    if (evidence.length > 0) lines.push(`  Recent evidence: ${evidence.join(" | ")}${task.evidence.length > evidence.length ? ` (+${task.evidence.length - evidence.length} older)` : ""}`);
  }
  if (Array.isArray(task.notes) && task.notes.length > 0) {
    const notes = task.notes.slice(-1).map((item) => truncateForPrompt(item, 260)).filter(Boolean);
    if (notes.length > 0) lines.push(`  Recent notes: ${notes.join(" | ")}${task.notes.length > notes.length ? ` (+${task.notes.length - notes.length} older)` : ""}`);
  }
  return lines.join("\n");
}

function summarizeTaskCounts(tasks) {
  const counts = { todo: 0, in_progress: 0, blocked: 0, done: 0, cancelled: 0 };
  for (const task of tasks) {
    if (task && typeof task.status === "string" && Object.prototype.hasOwnProperty.call(counts, task.status)) {
      counts[task.status] += 1;
    }
  }
  return counts;
}

function buildContractPromptLines(task) {
  const contract = normalizeTaskMetadata(task?.metadata)?.contract;
  if (!contract) return ["- No explicit task contract recorded."];
  const lines = [];
  if (contract.purpose) lines.push(`- Purpose: ${truncateForPrompt(contract.purpose, 260)}`);
  if (contract.requiredCodeChanges.length > 0) {
    lines.push(`- Required code changes: ${contract.requiredCodeChanges.map((item) => truncateForPrompt(item, 140)).join(" | ")}`);
  }
  return lines.length > 0 ? lines : ["- No explicit task contract recorded."];
}

function buildVerificationPromptLines(task) {
  const contract = normalizeTaskMetadata(task?.metadata)?.contract;
  if (!contract || contract.verificationTarget.length === 0) {
    return ["- No exact verification target recorded."];
  }
  return contract.verificationTarget.map((item) => `- ${truncateForPrompt(item, 220)}`);
}

function buildGraphContextPromptLines(task) {
  const context = normalizeTaskMetadata(task?.metadata)?.graphifyContext;
  if (!context || context.status !== "ready") return [];
  const lines = [
    "## Relevant Graph Context",
    "Use this task-scoped Graphify context first. Only broaden repo search if it is missing, stale, or contradicted.",
  ];
  if (context.summary.likelyFiles.length > 0) {
    lines.push(`- Likely files: ${formatInlineList(context.summary.likelyFiles)}`);
  }
  if (context.summary.likelySymbols.length > 0) {
    lines.push(`- Likely symbols: ${formatInlineList(context.summary.likelySymbols)}`);
  }
  if (context.summary.likelyCallSites.length > 0) {
    lines.push(`- Likely call sites: ${context.summary.likelyCallSites.map((item) => truncateForPrompt(item, 120)).join(" | ")}`);
  }
  if (context.summary.relatedArtifacts.length > 0) {
    lines.push(`- Related modules/routes/templates/tests: ${formatInlineList(context.summary.relatedArtifacts)}`);
  }
  if (context.summary.queryNotes.length > 0) {
    lines.push(`- Query notes: ${context.summary.queryNotes.map((item) => truncateForPrompt(item, 140)).join(" | ")}`);
  }
  return lines;
}

function buildIterationPrompt(loop, task, overlay = null) {
  const currentTask = task ?? selectActiveTask(loop);
  const maxStr = loop.maxIterations > 0 ? `/${loop.maxIterations}` : "";
  const currentTaskCount = Array.isArray(loop.tasks) ? loop.tasks.length : 0;
  const counts = summarizeTaskCounts(Array.isArray(loop.tasks) ? loop.tasks : []);
  const lines = [
    "───────────────────────────────────────────────────────────────────────",
    `🔄 RALPH LOOP: ${loop.name} | Iteration ${loop.iteration}${maxStr}${loop.reflectEvery > 0 ? " | 🪞 REFLECTION" : ""}`,
    "───────────────────────────────────────────────────────────────────────",
    "",
    `Tasks: ${currentTaskCount} total, ${counts.done} done, ${counts.in_progress} in progress, ${counts.blocked} blocked, ${counts.todo} todo, ${counts.cancelled} cancelled.`,
  ];

  if (loop.title?.trim()) lines.push(`# ${truncateForPrompt(loop.title, PROMPT_TASK_TITLE_MAX_CHARS)}`);
  if (loop.summary?.trim()) lines.push(truncateForPrompt(loop.summary, 500));

  lines.push(
    "",
    "## Current Task",
    currentTask ? formatPromptTask(currentTask) : "- No active task found. If all work is complete, call `ralph_done` or stop the loop.",
    "",
    "## Verification Target",
    ...buildVerificationPromptLines(currentTask),
    "",
    "## Active Task Contract",
    ...buildContractPromptLines(currentTask),
  );

  const graphContextLines = buildGraphContextPromptLines(currentTask);
  if (graphContextLines.length > 0) {
    lines.push("", ...graphContextLines);
  }

  lines.push(
    "",
    "## Runtime Rules",
    "- Start with the current task and verification target. Avoid broad re-planning.",
    graphContextLines.length > 0
      ? "- Use the injected Graphify context first. Do not invent a wide discovery plan unless that context is missing or contradicted."
      : "- If structure is unclear, use Graphify query or explain before broad manual exploration.",
    "- Use Ralph tools to keep task status, evidence, notes, and contract state canonical.",
    "- When exact compiler, API, or framework failures block progress, research the exact issue before guessing.",
    "- If two attempts on the same exact issue produce no new evidence, change approach or delegate.",
    loop.itemsPerIteration > 0
      ? `- Complete about ${loop.itemsPerIteration} task item(s) this iteration, then call the actual \`ralph_done\` tool.`
      : "- Take the smallest validating next step, then call the actual `ralph_done` tool when this iteration is complete.",
    "- User controls: ESC pauses the assistant. Run `/ralph-stop` only when idle.",
  );

  if (overlay) {
    lines.push(
      "",
      "## Workspace Overlay",
      "`./RALPH.md` was found. Its full contents will be injected into hidden system context for this turn.",
      truncateForPrompt(overlay, 900),
    );
  }

  const prompt = lines.join("\n");
  if (prompt.length <= PROMPT_MAX_CHARS) return prompt;
  return `${prompt.slice(0, PROMPT_MAX_CHARS)}\n\n[Prompt truncated by ${prompt.length - PROMPT_MAX_CHARS} chars. Use Ralph or Graphify tools for additional context.]`;
}

function buildResetPrompt(loop, task, overlay = null) {
  return buildIterationPrompt(loop, task, overlay);
}

function trimHandoffSection(text, maxChars) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) return "";
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 25)).trimEnd()}\n[Section truncated for handoff.]`;
}

function isQueuedCompactionHandoffPrompt(prompt) {
  const text = typeof prompt === "string" ? prompt : "";
  return text.includes("A Ralph compaction handoff is queued for loop")
    && text.includes("Call the `ralph_handoff` tool immediately.");
}

function logPromptDispatch(loop, mode, prompt) {
  const promptChars = typeof prompt === "string" ? prompt.length : 0;
  debugLog(`[ralph] prompt dispatch mode=${mode} loop=${loop?.name ?? "unknown"} iteration=${loop?.iteration ?? "?"} chars=${promptChars}`);
}

function logHandoffStage(loop, stage, details = {}) {
  const loopName = loop?.name ?? "unknown";
  const iteration = loop?.iteration ?? "?";
  const generation = loop?.pendingHandoffGeneration ?? "?";
  const detailText = Object.entries(details)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
  const suffix = detailText ? ` ${detailText}` : "";
  debugLog(`[ralph] handoff stage=${stage} loop=${loopName} iteration=${iteration} generation=${generation}${suffix}`);
}

function stripManagedRalphContext(systemPrompt) {
  if (typeof systemPrompt !== "string" || !systemPrompt) return "";
  const managedBlock = new RegExp(`${escapeRegExp(RALPH_CONTEXT_START)}[\\s\\S]*?${escapeRegExp(RALPH_CONTEXT_END)}\\s*`, "g");
  return systemPrompt.replace(managedBlock, "").trimEnd();
}

function buildManagedRalphSystemPrompt(loop, overlay = null) {
  const iterStr = `${loop.iteration}${loop.maxIterations > 0 ? `/${loop.maxIterations}` : ""}`;
  const instructions = [
    `You are in a Ralph loop named "${loop.name}" at iteration ${iterStr}.`,
    ...(overlay ? ["", "## RALPH.md", overlay] : []),
    "Use /ralph tools to inspect and update canonical loop state.",
    "After making progress, call ralph_done to queue the next iteration.",
  ].join("\n");
  return `${RALPH_CONTEXT_START}
[RALPH LOOP - ${loop.name} - Iteration ${iterStr}]

${instructions}
${RALPH_CONTEXT_END}`;
}

async function deliverIterationPrompt(target, prompt) {
  if (target && typeof target.sendMessage === "function") {
    await target.sendMessage(
      {
        customType: "ralph-iteration",
        content: prompt,
        display: true,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
    return true;
  }

  if (target && typeof target.sendUserMessage === "function") {
    await target.sendUserMessage(prompt, { deliverAs: "followUp" });
    return true;
  }

  return false;
}

async function deliverFreshSessionPrompt(target, prompt) {
  if (target && typeof target.sendUserMessage === "function") {
    debugLog(`[ralph] handoff stage=replacement-sendUserMessage promptChars=${typeof prompt === "string" ? prompt.length : 0}`);
    await target.sendUserMessage(prompt, { deliverAs: "followUp" });
    return true;
  }
  debugLog(`[ralph] handoff stage=replacement-sendUserMessage-unavailable fallback=true`);
  return deliverIterationPrompt(target, prompt);
}

async function dispatchFreshContextPrompt(pi, ctx, loop, prompt, mode = "fresh", onDispatched = null) {
  const controlCtx = getSessionControlCtx(ctx);
  const canNewSession = Boolean(controlCtx && typeof controlCtx.newSession === "function");
  rememberLoopHint(ctx, loop?.name);
  let attemptedSessionReplacement = false;
  if (typeof ctx.newSession !== "function") {
    logHandoffStage(loop, `${mode}-ctx-no-newSession`, { controlCtxHasNewSession: canNewSession });
  }

  if (!canNewSession) {
    logHandoffStage(loop, `${mode}-no-newSession`);
    logPromptDispatch(loop, `${mode}/followUp-fallback`, prompt);
    if (await deliverIterationPrompt(ctx, prompt)) {
      if (typeof onDispatched === "function") {
        await onDispatched(ctx);
      }
      return true;
    }
    if (await deliverIterationPrompt(pi, prompt)) {
      if (typeof onDispatched === "function") {
        await onDispatched(ctx);
      }
      return true;
    }
    return false;
  }

  try {
    attemptedSessionReplacement = true;
    logHandoffStage(loop, `${mode}-newSession-start`, { promptChars: typeof prompt === "string" ? prompt.length : 0 });
    logPromptDispatch(loop, `${mode}/newSession`, prompt);
    const parentSession = controlCtx.sessionManager?.getSessionFile?.() ?? ctx.sessionManager?.getSessionFile?.() ?? undefined;
    const result = await controlCtx.newSession({
      parentSession,
      withSession: async (replacementCtx) => {
        rememberSessionControlCtx(replacementCtx);
        rememberLoopHint(replacementCtx, loop?.name);
        logHandoffStage(loop, `${mode}-withSession-enter`, { parentSession });
        await deliverFreshSessionPrompt(replacementCtx, prompt);
        logHandoffStage(loop, `${mode}-withSession-delivered`);
        if (typeof onDispatched === "function") {
          await onDispatched(replacementCtx);
          logHandoffStage(loop, `${mode}-withSession-finalized`);
        }
      },
    });
    logHandoffStage(loop, `${mode}-newSession-result`, { cancelled: Boolean(result?.cancelled) });
    if (!result?.cancelled) {
      return true;
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logHandoffStage(loop, `${mode}-newSession-error`, { error: detail });
  }

  if (attemptedSessionReplacement) {
    logHandoffStage(loop, `${mode}-post-newSession-no-fallback`);
    return false;
  }

  logHandoffStage(loop, `${mode}-followUp-fallback-start`);
  logPromptDispatch(loop, `${mode}/followUp`, prompt);
  if (await deliverIterationPrompt(ctx, prompt)) {
    if (typeof onDispatched === "function") {
      await onDispatched(ctx);
    }
    return true;
  }

  if (await deliverIterationPrompt(pi, prompt)) {
    if (typeof onDispatched === "function") {
      await onDispatched(ctx);
    }
    return true;
  }

  return false;
}

async function dispatchNextIteration(pi, ctx, loop) {
  if (loop.pendingHandoff) {
    logPromptDispatch(loop, "next/skipped-pending-handoff", "");
    return false;
  }
  rememberLoopHint(ctx, loop?.name);
  const store = loadStore(ctx);
  const currentLoop = getCurrentLoop(store, loop.name) ?? loop;
  const activeTask = selectActiveTask(currentLoop);
  if (activeTask) ensureTaskGraphifyContext(ctx, store, currentLoop, activeTask);
  const prompt = buildIterationPrompt(currentLoop, activeTask, loadRalphOverlay(ctx));

  if (currentLoop.sessionStrategy === "newSession" && typeof ctx.newSession === "function") {
    return dispatchFreshContextPrompt(pi, ctx, currentLoop, prompt, "next");
  }

  logPromptDispatch(currentLoop, "next/followUp", prompt);
  if (await deliverIterationPrompt(ctx, prompt)) {
    return true;
  }

  if (await deliverIterationPrompt(pi, prompt)) {
    return true;
  }

  return false;
}

async function dispatchFreshIteration(pi, ctx, loop) {
  if (loop.pendingHandoff) {
    logPromptDispatch(loop, "fresh/skipped-pending-handoff", "");
    return false;
  }
  rememberLoopHint(ctx, loop?.name);
  const store = loadStore(ctx);
  const currentLoop = getCurrentLoop(store, loop.name) ?? loop;
  const activeTask = selectActiveTask(currentLoop);
  if (activeTask) ensureTaskGraphifyContext(ctx, store, currentLoop, activeTask);
  const prompt = buildResetPrompt(currentLoop, activeTask, loadRalphOverlay(ctx));
  return dispatchFreshContextPrompt(pi, ctx, currentLoop, prompt, "fresh");
}

function buildCompactionHandoffMessage(loop, handoffPrompt) {
  const basePrompt = buildResetPrompt(loop, selectActiveTask(loop), null);
  const rawHandoff = String(handoffPrompt ?? "").trim();
  const summaryMatch = rawHandoff.match(/## Handoff Summary\s*([\s\S]*?)(?:\n## |\s*$)/);
  const rationaleMatch = rawHandoff.match(/## Why Fresh Context Was Needed\s*([\s\S]*?)(?:\n## |\s*$)/);
  const nextStepsMatch = rawHandoff.match(/## Next Steps\s*([\s\S]*?)(?:\n## |\s*$)/);
  const intro = rawHandoff
    .replace(/## Handoff Summary[\s\S]*$/m, "")
    .trim();
  const summary = trimHandoffSection(summaryMatch?.[1] ?? "", HANDOFF_SUMMARY_MAX_CHARS);
  const rationale = trimHandoffSection(rationaleMatch?.[1] ?? "", HANDOFF_RATIONALE_MAX_CHARS);
  const steps = String(nextStepsMatch?.[1] ?? "")
    .split("\n")
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean)
    .slice(0, HANDOFF_MAX_STEPS)
    .map((step) => `- ${trimHandoffSection(step, HANDOFF_STEP_MAX_CHARS)}`);
  const openTasks = Array.isArray(loop.tasks)
    ? loop.tasks.filter((task) => task && task.status !== "done" && task.status !== "blocked" && task.status !== "cancelled")
    : [];
  const completedTasks = Array.isArray(loop.tasks)
    ? loop.tasks.filter((task) => task && task.status === "done")
    : [];
  const recentVerification = Array.isArray(loop.verification) ? loop.verification.slice(-HANDOFF_STATE_MAX_ITEMS) : [];
  const recentNotes = Array.isArray(loop.notes) ? loop.notes.slice(-Math.min(5, HANDOFF_STATE_MAX_ITEMS)) : [];
  const recentReflections = Array.isArray(loop.reflections) ? loop.reflections.slice(-Math.min(3, HANDOFF_STATE_MAX_ITEMS)) : [];

  const extraLines = [
    "",
    "## Compaction Handoff",
    intro,
  ];
  extraLines.push(
    "",
    "## Ralph State Snapshot",
    `- Loop: ${loop.name}`,
    `- Iteration: ${loop.iteration}${loop.maxIterations > 0 ? `/${loop.maxIterations}` : ""}`,
    `- Status: ${loop.status}`,
    `- Suspected goal: ${trimHandoffSection(String(loop.summary ?? loop.title ?? "").trim(), HANDOFF_STATE_TEXT_MAX_CHARS) || "unknown"}`,
  );
  if (openTasks.length > 0) {
    extraLines.push("", "## Open Tasks");
    for (const task of openTasks.slice(0, HANDOFF_STATE_MAX_ITEMS)) {
      extraLines.push(`- ${task.id}: ${trimHandoffSection(String(task.title ?? "").trim(), HANDOFF_STATE_TEXT_MAX_CHARS)}`);
      if (task.details?.trim()) {
        extraLines.push(`  Details: ${trimHandoffSection(task.details, HANDOFF_STATE_TEXT_MAX_CHARS)}`);
      }
    }
  }
  if (completedTasks.length > 0) {
    extraLines.push("", "## Recently Completed Tasks");
    for (const task of completedTasks.slice(-HANDOFF_STATE_MAX_ITEMS)) {
      extraLines.push(`- ${task.id}: ${trimHandoffSection(String(task.title ?? "").trim(), HANDOFF_STATE_TEXT_MAX_CHARS)}`);
    }
  }
  if (recentVerification.length > 0) {
    extraLines.push("", "## Recent Verification");
    for (const item of recentVerification) {
      extraLines.push(`- ${trimHandoffSection(String(item?.text ?? "").trim(), HANDOFF_STATE_TEXT_MAX_CHARS)}`);
    }
  }
  if (recentNotes.length > 0) {
    extraLines.push("", "## Recent Notes");
    for (const item of recentNotes) {
      extraLines.push(`- ${trimHandoffSection(String(item?.text ?? "").trim(), HANDOFF_STATE_TEXT_MAX_CHARS)}`);
    }
  }
  if (recentReflections.length > 0) {
    extraLines.push("", "## Recent Reflections");
    for (const item of recentReflections) {
      extraLines.push(`- ${trimHandoffSection(String(item?.text ?? "").trim(), HANDOFF_STATE_TEXT_MAX_CHARS)}`);
    }
  }
  if (summary) extraLines.push("", "## Handoff Summary", summary);
  if (rationale) extraLines.push("", "## Why Fresh Context Was Needed", rationale);
  if (steps.length > 0) extraLines.push("", "## Next Steps", ...steps);
  extraLines.push(
    "",
    "Continue from this fresh context rather than relying on the old transcript.",
    "Use Ralph canonical state as the source of truth.",
    "Take the smallest validating next step and avoid repeating the same failed action.",
  );

  const prompt = `${basePrompt}${extraLines.join("\n")}`;
  if (prompt.length <= HANDOFF_PROMPT_MAX_CHARS) return prompt;
  return `${prompt.slice(0, HANDOFF_PROMPT_MAX_CHARS)}\n\n[Handoff prompt still exceeded the safety cap. Use Ralph tools for the remaining context.]`;
}

function getPendingHandoffLoop(store, loopName) {
  const loop = getCurrentLoop(store, loopName);
  if (!loop || !loop.pendingHandoff || !loop.pendingHandoffPrompt) return null;
  return loop;
}

export function getPendingRalphHandoff(ctx, loopName) {
  const store = loadStore(ctx);
  const loop = getPendingHandoffLoop(store, loopName);
  if (!loop) return null;
  return {
    loop,
    prompt: loop.pendingHandoffPrompt,
    reason: loop.pendingHandoffReason ?? null,
    generation: loop.pendingHandoffGeneration ?? 0,
    commandQueued: Boolean(loop.pendingHandoffCommandQueued),
  };
}

export function ensurePendingRalphHandoff(ctx, loopName, handoffPrompt, reason = "compaction") {
  const store = loadStore(ctx);
  const loop = getCurrentLoop(store, loopName);
  if (!loop) return null;

  if (
    loop.pendingHandoff &&
    loop.pendingHandoffReason === reason &&
    typeof loop.pendingHandoffPrompt === "string" &&
    loop.pendingHandoffPrompt.trim()
  ) {
    return {
      loop,
      generation: loop.pendingHandoffGeneration ?? 0,
      commandQueued: Boolean(loop.pendingHandoffCommandQueued),
    };
  }

  loop.pendingHandoff = true;
  loop.pendingHandoffReason = reason;
  loop.pendingHandoffPrompt = String(handoffPrompt ?? "").trim();
  loop.pendingHandoffCreatedAt = nowIso();
  loop.pendingHandoffGeneration = (loop.pendingHandoffGeneration ?? 0) + 1;
  loop.pendingHandoffCommandQueued = false;
  addVerification(loop, `Queued fresh-context handoff (${reason})`);
  persistLoop(ctx, store, loop);
  logHandoffStage(loop, "persisted", { reason, promptChars: loop.pendingHandoffPrompt.length });

  return {
    loop,
    generation: loop.pendingHandoffGeneration,
    commandQueued: false,
  };
}

export function markPendingRalphHandoffQueued(ctx, loopName, queued = true) {
  const store = loadStore(ctx);
  const loop = getCurrentLoop(store, loopName);
  if (!loop) return false;
  if (!loop.pendingHandoff) return false;
  loop.pendingHandoffCommandQueued = Boolean(queued);
  persistLoop(ctx, store, loop);
  logHandoffStage(loop, "command-queued", { queued: Boolean(queued) });
  return true;
}

export function updatePendingRalphHandoffPrompt(ctx, loopName, handoffPrompt, reason) {
  const store = loadStore(ctx);
  const loop = getCurrentLoop(store, loopName);
  if (!loop || !loop.pendingHandoff) return null;
  loop.pendingHandoffPrompt = String(handoffPrompt ?? "").trim();
  if (typeof reason === "string" && reason.trim()) {
    loop.pendingHandoffReason = reason.trim();
  }
  persistLoop(ctx, store, loop);
  logHandoffStage(loop, "prompt-updated", { promptChars: loop.pendingHandoffPrompt.length });
  return {
    loop,
    generation: loop.pendingHandoffGeneration ?? 0,
    commandQueued: Boolean(loop.pendingHandoffCommandQueued),
  };
}

export function clearPendingRalphHandoff(ctx, loopName, options = {}) {
  const store = loadStore(ctx);
  const loop = getCurrentLoop(store, loopName);
  if (!loop) return false;

  if (options.markDispatched && loop.pendingHandoff) {
    loop.lastHandoffDispatchedGeneration = loop.pendingHandoffGeneration ?? 0;
  }

  loop.pendingHandoff = false;
  loop.pendingHandoffReason = null;
  loop.pendingHandoffPrompt = null;
  loop.pendingHandoffCreatedAt = null;
  loop.pendingHandoffCommandQueued = false;
  persistLoop(ctx, store, loop);
  return true;
}

export async function dispatchPendingRalphHandoff(pi, ctx, loopName) {
  const store = loadStore(ctx);
  const loop = getPendingHandoffLoop(store, loopName);
  if (!loop) {
    debugLog(`[ralph] handoff stage=dispatch-missing loop=${loopName ?? "unknown"}`);
    return { dispatched: false, reason: "no_pending_handoff" };
  }
  logHandoffStage(loop, "dispatch-start", { reason: loop.pendingHandoffReason ?? null, commandQueued: Boolean(loop.pendingHandoffCommandQueued) });

  if ((loop.pendingHandoffGeneration ?? 0) <= (loop.lastHandoffDispatchedGeneration ?? 0)) {
    logHandoffStage(loop, "dispatch-already-dispatched", { lastDispatchedGeneration: loop.lastHandoffDispatchedGeneration ?? 0 });
    clearPendingRalphHandoff(ctx, loop.name, { markDispatched: false });
    return { dispatched: false, reason: "already_dispatched" };
  }

  const prompt = buildCompactionHandoffMessage(loop, loop.pendingHandoffPrompt);
  const handoffReason = loop.pendingHandoffReason ?? "unknown";
  const pendingSnapshot = {
    reason: loop.pendingHandoffReason ?? null,
    prompt: loop.pendingHandoffPrompt ?? null,
    createdAt: loop.pendingHandoffCreatedAt ?? null,
    generation: loop.pendingHandoffGeneration ?? 0,
    commandQueued: Boolean(loop.pendingHandoffCommandQueued),
  };
  loop.lastHandoffDispatchedGeneration = pendingSnapshot.generation;
  loop.pendingHandoff = false;
  loop.pendingHandoffReason = null;
  loop.pendingHandoffPrompt = null;
  loop.pendingHandoffCreatedAt = null;
  loop.pendingHandoffCommandQueued = false;
  persistLoop(ctx, store, loop);
  logHandoffStage(loop, "pre-switch-cleared", { lastDispatchedGeneration: loop.lastHandoffDispatchedGeneration ?? 0 });

  let dispatchedLoop = loop;
  const finalizeDispatch = async (targetCtx) => {
    try {
      logHandoffStage(loop, "finalize-start");
      const targetStore = loadStore(targetCtx);
      const targetLoop = getCurrentLoop(targetStore, loop.name);
      if (!targetLoop) {
        logHandoffStage(loop, "finalize-missing-loop");
        return null;
      }

      addVerification(targetLoop, `Fresh-context handoff dispatched (${pendingSnapshot.reason ?? "unknown"})`);
      persistLoop(targetCtx, targetStore, targetLoop);
      logHandoffStage(targetLoop, "finalize-complete", { lastDispatchedGeneration: targetLoop.lastHandoffDispatchedGeneration ?? 0 });
      dispatchedLoop = targetLoop;
      return targetLoop;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logHandoffStage(loop, "finalize-error", { error: detail });
      return null;
    }
  };

  const dispatched = await dispatchFreshContextPrompt(
    pi,
    ctx,
    loop,
    prompt,
    `handoff/${handoffReason}`,
    finalizeDispatch,
  );

  if (!dispatched) {
    loop.pendingHandoff = true;
    loop.pendingHandoffReason = pendingSnapshot.reason;
    loop.pendingHandoffPrompt = pendingSnapshot.prompt;
    loop.pendingHandoffCreatedAt = pendingSnapshot.createdAt;
    loop.pendingHandoffGeneration = pendingSnapshot.generation;
    loop.lastHandoffDispatchedGeneration = Math.max((pendingSnapshot.generation ?? 0) - 1, 0);
    loop.pendingHandoffCommandQueued = false;
    persistLoop(ctx, store, loop);
    logHandoffStage(loop, "dispatch-failed-restored", { restoredGeneration: loop.pendingHandoffGeneration ?? 0 });
    return { dispatched: false, reason: "dispatch_failed", loop };
  }

  logHandoffStage(dispatchedLoop, "dispatch-complete");
  return { dispatched: true, loop: dispatchedLoop };
}

function updateLoopFromArgs(loop, args) {
  if (Number.isFinite(args.maxIterations)) loop.maxIterations = args.maxIterations;
  if (Number.isFinite(args.itemsPerIteration)) loop.itemsPerIteration = args.itemsPerIteration;
  if (Number.isFinite(args.reflectEvery)) loop.reflectEvery = args.reflectEvery;
  if (typeof args.sessionStrategy === "string") loop.sessionStrategy = args.sessionStrategy === "followUp" ? "followUp" : "newSession";
  if (typeof args.sessionStrategyFailure === "string") loop.sessionStrategyFailure = args.sessionStrategyFailure === "stopAndAlert" ? "stopAndAlert" : "followUp";
}

function parseStartArgs(rest) {
  const tokens = String(rest ?? "")
    .match(/(?:[^\s"]+|"[^"]*")+/g)
    ?.map((tok) => tok.replace(/^"|"$/g, "")) ?? [];
  const args = {
    name: "",
    taskContent: "",
    maxIterations: undefined,
    itemsPerIteration: undefined,
    reflectEvery: undefined,
    sessionStrategy: "newSession",
    sessionStrategyFailure: "followUp",
  };
  if (tokens.length > 0) args.name = tokens[0];
  const content = [];
  for (let i = 1; i < tokens.length; i += 1) {
    const tok = tokens[i];
    const next = tokens[i + 1];
    if (tok === "--max-iterations" && next) {
      args.maxIterations = Number.parseInt(next, 10);
      i += 1;
      continue;
    }
    if (tok === "--items-per-iteration" && next) {
      args.itemsPerIteration = Number.parseInt(next, 10);
      i += 1;
      continue;
    }
    if (tok === "--reflect-every" && next) {
      args.reflectEvery = Number.parseInt(next, 10);
      i += 1;
      continue;
    }
    if (tok === "--session-strategy" && next) {
      args.sessionStrategy = next;
      i += 1;
      continue;
    }
    if (tok === "--session-strategy-failure" && next) {
      args.sessionStrategyFailure = next;
      i += 1;
      continue;
    }
    content.push(tok);
  }
  args.taskContent = content.join(" ");
  return args;
}

function parseTaskListArgs(rest) {
  const tokens = String(rest ?? "").split(/\s+/).filter(Boolean);
  const result = { loopName: undefined, status: undefined };
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    const next = tokens[i + 1];
    if (tok === "--status" && next) {
      result.status = next;
      i += 1;
      continue;
    }
    if (!tok.startsWith("--") && !result.loopName) {
      result.loopName = tok;
    }
  }
  return result;
}

function parseTaskUpdateArgs(rest) {
  const tokens = String(rest ?? "").split(/\s+/).filter(Boolean);
  const [action, taskId, ...loopParts] = tokens;
  return {
    action,
    taskId,
    loopName: loopParts[0],
  };
}

function formatHelp() {
  return [
    "Ralph Wiggum - long-running development loops",
    "",
    "Commands:",
    "  /ralph start <name> [options]      Start a new loop",
    "  /ralph stop                        Pause current loop",
    "  /ralph resume [name]               Resume a paused loop",
    "  /ralph status                      Show all loops",
    "  /ralph show-plan [loop]            Show structured plan summary",
    "  /ralph list-tasks [loop] [--status STATUS]  Show structured tasks",
    "  /ralph task <done|block> <task-id> [loop]   Quick task update",
    "  /ralph set-max-iterations <N> [loop]        Update max iterations",
    "  /ralph set-iteration <N> [loop]             Set current iteration",
    "  /ralph set-session-strategy <followUp|newSession> [loop]",
    "  /ralph cancel <name>                Delete loop state",
    "  /ralph archive <name>               Archive loop state",
    "  /ralph clean [--all]                Remove completed loops",
    "  /ralph list [--archived]            Show loops",
    "  /ralph nuke [--yes]                 Delete all Ralph data",
    "  /ralph-stop                         Stop active loop (idle only)",
  ].join("\n");
}

function getCurrentLoop(store, loopName) {
  const loop = getLoop(store, loopName);
  return loop ?? null;
}

function getCurrentLoopWithHint(store, ctx, loopName) {
  const direct = getCurrentLoop(store, loopName);
  if (direct) return direct;
  const hintedLoopName = getLoopHint(ctx);
  if (!hintedLoopName || hintedLoopName === loopName) return direct;
  return getCurrentLoop(store, hintedLoopName);
}

export function getActiveRalphLoop(ctx) {
  const store = loadStore(ctx);
  const loop = getCurrentLoopWithHint(store, ctx);
  if (!loop || loop.status !== "active") return null;
  return loop;
}

export async function maybeDispatchStoppedLoopSteering(ctx, pi, options = {}) {
  const stopReason = typeof options.stopReason === "string" ? options.stopReason : "";
  if (stopReason !== "stop") return false;

  const store = loadStore(ctx);
  const loop = getCurrentLoop(store);
  if (!loop || loop.status !== "active") return false;
  if (loop.pendingHandoff) return false;

  if (typeof ctx?.hasPendingMessages === "function" && ctx.hasPendingMessages()) {
    return false;
  }

  if (loop.lastDoneReminderAt === loop.iteration) {
    return false;
  }

  loop.lastDoneReminderAt = loop.iteration;
  persistLoop(ctx, store, loop);

  const assistantText = typeof options.assistantText === "string" ? options.assistantText : "";
  const message = FAKE_RALPH_DONE_PATTERN.test(assistantText)
    ? "You wrote text that looks like a ralph_done tool call, but Pi did not execute it. If this iteration is done, call the actual ralph_done tool now using the tool interface. Do not write XML, <invoke>, or placeholder text. If the loop is complete, Ralph state will stop it."
    : `You are still in Ralph loop "${loop.name}" at iteration ${loop.iteration}. If you are done with the tasks for this iteration, call the actual ralph_done tool now using the tool interface. If the loop is complete, Ralph state will stop it. Otherwise, continue working on the current iteration and use Ralph tools to update canonical state.`;

  if (typeof pi?.sendUserMessage === "function") {
    await pi.sendUserMessage(message, { deliverAs: "followUp" });
    return true;
  }

  if (typeof ctx?.sendUserMessage === "function") {
    await ctx.sendUserMessage(message, { deliverAs: "followUp" });
    return true;
  }

  return false;
}

function setStatus(loop, status) {
  loop.status = status;
  if (status === "completed") loop.completedAt = nowIso();
}

const TASK_METADATA_PARAMETER = Type.Object({}, { additionalProperties: true });

function mergeTaskMetadata(task, input) {
  const base = normalizeTaskMetadata(task?.metadata) ?? {};
  const next = normalizeTaskMetadata(input);
  if (!next) return Object.keys(base).length > 0 ? base : null;
  return {
    contract: next.contract ?? base.contract ?? null,
    graphifyPlan: next.graphifyPlan ?? base.graphifyPlan ?? null,
    graphifyContext: next.graphifyPlan ? null : next.graphifyContext ?? base.graphifyContext ?? null,
  };
}

function registerCommand(pi, name, handler) {
  pi.registerCommand(name, {
    description: "Ralph loop command",
    handler: async (args, ctx) => {
      rememberSessionControlCtx(ctx);
      return handler(args, ctx);
    },
  });
}

function registerTool(pi, spec) {
  pi.registerTool(spec);
}

async function resumeLoop(pi, ctx, store, loop) {
  setStatus(loop, "active");
  loop.iteration += 1;
  persistLoop(ctx, store, loop);
  if (ctx.hasUI) ctx.ui.notify(`Resumed: ${summarizeLoop(loop)}`, "info");
  if (loop.pendingHandoff) {
    if (ctx.hasUI) ctx.ui.notify(`Pending Ralph handoff preserved for ${loop.name}; skipping in-session iteration dispatch.`, "warning");
    return;
  }
  await dispatchNextIteration(pi, ctx, loop);
}

export function registerRalphSurface(pi) {
  registerCommand(pi, "ralph", async (args, ctx) => {
    const [cmd, ...restParts] = String(args ?? "").trim().split(/\s+/);
    const rest = restParts.join(" ");
    const store = loadStore(ctx);

    if (!cmd) {
      if (ctx.hasUI) ctx.ui.notify(formatHelp(), "info");
      return;
    }

    const active = () => getCurrentLoop(store);

    if (cmd === "start") {
      const parsed = parseStartArgs(rest);
      if (!parsed.name) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /ralph start <name> [--max-iterations N] [--items-per-iteration N] [--reflect-every N] [--session-strategy MODE]", "warning");
        return;
      }
      const existing = getCurrentLoop(store, parsed.name);
      if (existing) {
        updateLoopFromArgs(existing, parsed);
        await resumeLoop(pi, ctx, store, existing);
        return;
      }
      const loop = createLoop(parsed.name, parsed);
      persistLoop(ctx, store, loop);
      if (ctx.hasUI) ctx.ui.notify(`Started: ${summarizeLoop(loop)}`, "info");
      await dispatchNextIteration(pi, ctx, loop);
      return;
    }

    if (cmd === "stop") {
      const loop = active();
      if (!loop) {
        if (ctx.hasUI) ctx.ui.notify("No active Ralph loop", "warning");
        return;
      }
      setStatus(loop, "paused");
      persistLoop(ctx, store, loop);
      if (ctx.hasUI) ctx.ui.notify(`Paused Ralph loop: ${loop.name}`, "info");
      return;
    }

    if (cmd === "resume") {
      const name = rest.trim();
      const loop = getCurrentLoop(store, name || undefined);
      if (!loop) {
        if (ctx.hasUI) ctx.ui.notify(name ? `Loop "${name}" not found` : "No selected Ralph loop found. Use /ralph resume <name>.", "warning");
        return;
      }
      await resumeLoop(pi, ctx, store, loop);
      return;
    }

    if (cmd === "status" || cmd === "list") {
      const archived = rest.trim() === "--archived";
      const loops = store.loops.filter((loop) => Boolean(loop.archivedAt) === archived);
      if (loops.length === 0) {
        if (ctx.hasUI) ctx.ui.notify(archived ? "No archived loops" : "No Ralph loops found.", "info");
        return;
      }
      if (ctx.hasUI) ctx.ui.notify(loops.map((loop) => summarizeLoop(loop)).join("\n"), "info");
      return;
    }

    if (cmd === "show-plan" || cmd === "list-tasks") {
      const parsed = parseTaskListArgs(rest);
      const loop = getCurrentLoop(store, parsed.loopName);
      if (!loop) {
        if (ctx.hasUI) ctx.ui.notify(parsed.loopName ? `Loop "${parsed.loopName}" not found` : "No active Ralph loop", "warning");
        return;
      }
      const text = cmd === "show-plan" ? buildCompactPlanResponse(loop, { status: parsed.status }) : buildPlanPreview(loop, parsed.status);
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      return;
    }

    if (cmd === "task") {
      const parsed = parseTaskUpdateArgs(rest);
      if (!parsed.action || !parsed.taskId || (parsed.action !== "done" && parsed.action !== "block")) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /ralph task <done|block> <task-id> [loop]", "warning");
        return;
      }
      const loop = getCurrentLoop(store, parsed.loopName);
      if (!loop) {
        if (ctx.hasUI) ctx.ui.notify(parsed.loopName ? `Loop "${parsed.loopName}" not found` : "No active Ralph loop", "warning");
        return;
      }
      const task = findTask(loop, parsed.taskId);
      if (!task) {
        if (ctx.hasUI) ctx.ui.notify(`Task "${parsed.taskId}" not found`, "error");
        return;
      }
      task.status = parsed.action === "done" ? "done" : "blocked";
      addVerification(loop, `Task ${task.id} marked ${task.status} via /ralph task.`);
      if (loop.currentTaskId === task.id) {
        loop.currentTaskId = loop.tasks.find((item) => item.id !== task.id && item.status !== "done" && item.status !== "blocked")?.id ?? null;
      }
      persistLoop(ctx, store, loop);
      if (ctx.hasUI) ctx.ui.notify(`Updated ${task.id}: ${task.title} -> ${task.status}`, "info");
      return;
    }

    if (cmd === "set-max-iterations" || cmd === "set-iteration" || cmd === "set-session-strategy") {
      const tokens = rest.split(/\s+/).filter(Boolean);
      const value = tokens[0];
      const loopName = tokens[1];
      const loop = getCurrentLoop(store, loopName);
      if (!loop) {
        if (ctx.hasUI) ctx.ui.notify(loopName ? `Loop "${loopName}" not found` : "No active Ralph loop", "warning");
        return;
      }
      if (cmd === "set-max-iterations") {
        loop.maxIterations = Number.parseInt(value ?? "", 10);
      } else if (cmd === "set-iteration") {
        loop.iteration = Number.parseInt(value ?? "", 10);
      } else {
        loop.sessionStrategy = value === "followUp" ? "followUp" : "newSession";
      }
      persistLoop(ctx, store, loop);
      if (ctx.hasUI) ctx.ui.notify(`Updated ${loop.name}: ${cmd.replace(/-/g, " ")} = ${value}`, "info");
      return;
    }

    if (cmd === "cancel" || cmd === "archive") {
      const name = rest.trim();
      const loop = getCurrentLoop(store, name || undefined);
      if (!loop) {
        if (ctx.hasUI) ctx.ui.notify(name ? `Loop "${name}" not found` : "No active Ralph loop", "warning");
        return;
      }
      if (cmd === "cancel") {
        store.loops = store.loops.filter((item) => item.name !== loop.name);
      } else {
        loop.archivedAt = nowIso();
        loop.status = loop.status === "active" ? "paused" : loop.status;
        persistLoop(ctx, store, loop);
      }
      saveStore(ctx, store);
      if (ctx.hasUI) ctx.ui.notify(`${cmd === "cancel" ? "Cancelled" : "Archived"}: ${loop.name}`, "info");
      return;
    }

    if (cmd === "clean") {
      const all = rest.trim() === "--all";
      const removed = store.loops.filter((loop) => loop.status === "completed" || (all && Boolean(loop.archivedAt)));
      store.loops = store.loops.filter((loop) => !removed.includes(loop));
      saveStore(ctx, store);
      if (ctx.hasUI) ctx.ui.notify(`Cleaned ${removed.length} loop(s)${all ? " (all records)" : ""}.`, "info");
      return;
    }

    if (cmd === "nuke") {
      if (rest.trim() !== "--yes") {
        if (ctx.hasUI) ctx.ui.notify("Run /ralph nuke --yes to confirm.", "warning");
        return;
      }
      const file = storePath(ctx);
      if (fs.existsSync(file)) fs.rmSync(path.dirname(file), { recursive: true, force: true });
      if (ctx.hasUI) ctx.ui.notify("Removed Ralph loop data.", "info");
      return;
    }

    if (ctx.hasUI) ctx.ui.notify(formatHelp(), "info");
  });

  registerCommand(pi, "ralph-stop", async (_args, ctx) => {
    const store = loadStore(ctx);
    const loop = getCurrentLoop(store);
    if (!loop) {
      if (ctx.hasUI) ctx.ui.notify("No active Ralph loop", "warning");
      return;
    }
    if (ctx.isIdle && !ctx.isIdle()) {
      if (ctx.hasUI) ctx.ui.notify("Agent is busy. Press ESC to interrupt, then run /ralph-stop.", "warning");
      return;
    }
    loop.status = "completed";
    loop.completedAt = nowIso();
    persistLoop(ctx, store, loop);
    if (ctx.hasUI) ctx.ui.notify(`Stopped Ralph loop: ${loop.name}`, "info");
  });

  registerCommand(pi, "ralph-handoff-now", async (args, ctx) => {
    const loopName = String(args ?? "").trim() || undefined;
    const pending = getPendingRalphHandoff(ctx, loopName);
    if (!pending) {
      if (ctx.hasUI) ctx.ui.notify(loopName ? `No pending Ralph handoff for "${loopName}".` : "No pending Ralph handoff.", "warning");
      return;
    }

    const result = await dispatchPendingRalphHandoff(pi, ctx, pending.loop.name);
    if (!result.dispatched) {
      if (ctx.hasUI) ctx.ui.notify(`Ralph handoff did not dispatch (${result.reason}).`, "warning");
      return;
    }
  });

  registerTool(pi, {
    name: "ralph_get_plan",
    label: "Get Ralph Plan",
    description: "Return a compact summary of the active loop or a named loop.",
    promptSnippet: "Inspect Ralph's compact plan summary without loading bulky plan state into context.",
    promptGuidelines: ["Use this only when you need a compact plan snapshot."],
    parameters: Type.Object({
      loopName: Type.Optional(Type.String()),
      status: Type.Optional(Type.String()),
      maxTasks: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = loadStore(ctx);
      const loop = getCurrentLoop(store, params.loopName);
      if (!loop) return { content: [{ type: "text", text: "Ralph loop not found." }], details: {} };
      return {
        content: [{ type: "text", text: buildCompactPlanResponse(loop, { status: params.status, maxTasks: params.maxTasks }) }],
        details: { loop },
      };
    },
  });

  registerTool(pi, {
    name: "ralph_list_tasks",
    label: "List Ralph Tasks",
    description: "List ordered tasks for the active loop or a named loop.",
    promptSnippet: "Get a compact view of Ralph tasks and statuses.",
    promptGuidelines: ["Use this to identify the next tasks to work on."],
    parameters: Type.Object({
      loopName: Type.Optional(Type.String()),
      status: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = loadStore(ctx);
      const loop = getCurrentLoop(store, params.loopName);
      if (!loop) return { content: [{ type: "text", text: "Ralph loop not found." }], details: {} };
      return { content: [{ type: "text", text: buildPlanPreview(loop, params.status ?? undefined) }], details: { loop } };
    },
  });

  registerTool(pi, {
    name: "ralph_add_task",
    label: "Add Ralph Task",
    description: "Add a task to the structured Ralph plan.",
    promptSnippet: "Create newly discovered Ralph work items.",
    promptGuidelines: ["Use this when new tasks emerge during iteration so plan state stays canonical."],
    parameters: Type.Object({
      title: Type.String(),
      details: Type.Optional(Type.String()),
      loopName: Type.Optional(Type.String()),
      position: Type.Optional(Type.Number()),
      metadata: Type.Optional(TASK_METADATA_PARAMETER),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = loadStore(ctx);
      const loop = getCurrentLoop(store, params.loopName);
      if (!loop) return { content: [{ type: "text", text: "Ralph loop not found." }], details: {} };
      const task = {
        id: `${loop.name}:${String(loop.tasks.length + 1).padStart(3, "0")}`,
        title: String(params.title).trim(),
        status: "todo",
        order: loop.tasks.length + 1,
        details: params.details?.trim() || "",
        metadata: mergeTaskMetadata(null, params.metadata),
        evidence: [],
        notes: [],
      };
      if (Number.isFinite(params.position) && params.position > 0 && params.position <= loop.tasks.length) {
        loop.tasks.splice(params.position - 1, 0, task);
      } else {
        loop.tasks.push(task);
      }
      addVerification(loop, `Task ${task.id} added: ${task.title}`);
      persistLoop(ctx, store, loop);
      return { content: [{ type: "text", text: `Added ${task.id}: ${task.title}` }], details: { task } };
    },
  });

  registerTool(pi, {
    name: "ralph_update_task",
    label: "Update Ralph Task",
    description: "Update a task in the structured Ralph plan by stable id.",
    promptSnippet: "Mutate Ralph task state safely through local storage.",
    promptGuidelines: ["Use this to update task status, details, notes, or evidence after making progress."],
    parameters: Type.Object({
      taskId: Type.String(),
      loopName: Type.Optional(Type.String()),
      status: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      details: Type.Optional(Type.String()),
      note: Type.Optional(Type.String()),
      evidence: Type.Optional(Type.String()),
      position: Type.Optional(Type.Number()),
      metadata: Type.Optional(TASK_METADATA_PARAMETER),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = loadStore(ctx);
      const loop = getCurrentLoop(store, params.loopName);
      if (!loop) return { content: [{ type: "text", text: "Ralph loop not found." }], details: {} };
      const task = findTask(loop, params.taskId);
      if (!task) return { content: [{ type: "text", text: `Task "${params.taskId}" not found.` }], details: {} };
      if (params.status) task.status = params.status;
      if (params.title !== undefined) task.title = params.title.trim() || task.title;
      if (params.details !== undefined) task.details = params.details.trim();
      if (params.metadata && typeof params.metadata === "object") {
        task.metadata = mergeTaskMetadata(task, params.metadata);
      }
      if (params.note?.trim()) task.notes.push(params.note.trim());
      if (params.evidence?.trim()) {
        task.evidence.push(params.evidence.trim());
        addVerification(loop, `${task.id}: ${params.evidence.trim()}`);
      }
      if (Number.isFinite(params.position) && params.position > 0) {
        const withoutTask = loop.tasks.filter((item) => item.id !== task.id);
        const index = Math.min(params.position - 1, withoutTask.length);
        withoutTask.splice(index, 0, task);
        loop.tasks = withoutTask;
      }
      persistLoop(ctx, store, loop);
      return { content: [{ type: "text", text: `Updated ${task.id}: ${task.title} [${task.status}]` }], details: { task } };
    },
  });

  registerTool(pi, {
    name: "ralph_add_note",
    label: "Add Ralph Note",
    description: "Append a timestamped loop-level note to the structured Ralph plan.",
    promptSnippet: "Record narrative progress, blockers, or decisions in canonical Ralph state.",
    promptGuidelines: ["Use this for freeform notes that do not belong on a specific task."],
    parameters: Type.Object({
      text: Type.String(),
      loopName: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = loadStore(ctx);
      const loop = getCurrentLoop(store, params.loopName);
      if (!loop) return { content: [{ type: "text", text: "Ralph loop not found." }], details: {} };
      loop.notes.push({ at: nowIso(), text: String(params.text).trim() });
      persistLoop(ctx, store, loop);
      return { content: [{ type: "text", text: "Added Ralph note." }], details: {} };
    },
  });

  registerTool(pi, {
    name: "ralph_record_reflection",
    label: "Record Ralph Reflection",
    description: "Append a structured reflection entry for the current Ralph iteration.",
    promptSnippet: "Persist Ralph reflection checkpoints in canonical state.",
    promptGuidelines: ["Use this during reflection iterations instead of writing directly to storage."],
    parameters: Type.Object({
      text: Type.String(),
      loopName: Type.Optional(Type.String()),
      iteration: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = loadStore(ctx);
      const loop = getCurrentLoop(store, params.loopName);
      if (!loop) return { content: [{ type: "text", text: "Ralph loop not found." }], details: {} };
      loop.reflections.push({ at: nowIso(), iteration: Number.isFinite(params.iteration) ? params.iteration : loop.iteration, text: String(params.text).trim() });
      persistLoop(ctx, store, loop);
      return { content: [{ type: "text", text: "Recorded Ralph reflection." }], details: {} };
    },
  });

  registerTool(pi, {
    name: "ralph_handoff",
    label: "Execute Ralph Handoff",
    description: "Use a stored Ralph compaction handoff to continue in a fresh provider context.",
    promptSnippet: "Execute a queued Ralph handoff after compaction or transcript loss.",
    promptGuidelines: ["Use this immediately when the user or system says a Ralph handoff is queued."],
    parameters: Type.Object({
      loopName: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const loopName = typeof params?.loopName === "string" && params.loopName.trim() ? params.loopName.trim() : undefined;
      debugLog(`[ralph] tool ralph_handoff start requestedLoop=${JSON.stringify(loopName ?? null)}`);
      const pending = getPendingRalphHandoff(ctx, loopName);
      if (!pending) {
        debugLog(`[ralph] tool ralph_handoff no-pending requestedLoop=${JSON.stringify(loopName ?? null)}`);
        return { content: [{ type: "text", text: loopName ? `No pending Ralph handoff for "${loopName}".` : "No pending Ralph handoff." }], details: {} };
      }
      debugLog(`[ralph] tool ralph_handoff pending loop=${pending.loop.name} generation=${pending.generation}`);
      const result = await dispatchPendingRalphHandoff(pi, ctx, pending.loop.name);
      if (!result.dispatched) {
        debugLog(`[ralph] tool ralph_handoff failed loop=${pending.loop.name} reason=${result.reason}`);
        return {
          content: [{ type: "text", text: `Ralph handoff did not dispatch (${result.reason}).` }],
          details: { loop: result.loop ?? pending.loop, reason: result.reason },
        };
      }
      debugLog(`[ralph] tool ralph_handoff complete loop=${pending.loop.name}`);
      return {
        content: [{ type: "text", text: `Ralph handoff dispatched for ${pending.loop.name}.` }],
        details: { loop: result.loop ?? pending.loop },
      };
    },
  });

  registerTool(pi, {
    name: "ralph_done",
    label: "Ralph Iteration Done",
    description: "Signal that you've completed this iteration of the Ralph loop.",
    promptSnippet: "Advance an active Ralph loop after completing the current iteration.",
    promptGuidelines: ["Call this after making real iteration progress so Ralph can queue the next prompt."],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const store = loadStore(ctx);
      const loop = getCurrentLoopWithHint(store, ctx);
      if (!loop) return { content: [{ type: "text", text: "No active Ralph loop." }], details: {} };
      if (loop.status !== "active") return { content: [{ type: "text", text: "Ralph loop is not active." }], details: {} };
      rememberLoopHint(ctx, loop.name);
      loop.iteration += 1;
      addVerification(loop, "Iteration advanced via ralph_done");
      if (loop.maxIterations > 0 && loop.iteration > loop.maxIterations) {
        setStatus(loop, "completed");
        saveStore(ctx, store);
        return { content: [{ type: "text", text: "Max iterations reached. Loop stopped." }], details: { loop } };
      }
      persistLoop(ctx, store, loop);
      const checkpointResult = checkpointLoopState(ctx, loop);
      if (!checkpointResult.ok) {
        setStatus(loop, "paused");
        persistLoop(ctx, store, loop);
        if (ctx.hasUI) ctx.ui.notify(`Paused Ralph loop: ${loop.name}. ${checkpointResult.message}`, "warning");
        return { content: [{ type: "text", text: `Error: ${checkpointResult.message}` }], details: { loop } };
      }
      if (checkpointResult.skipped && ctx.hasUI) {
        ctx.ui.notify(checkpointResult.message, "info");
      }
      const graphifyResult = runGraphifyUpdate(ctx);
      if (!graphifyResult.ok && graphifyResult.message && ctx.hasUI) {
        ctx.ui.notify(graphifyResult.message, graphifyResult.message.includes("skipped") ? "info" : "warning");
      }
      if (loop.sessionStrategy === "newSession") {
        const dispatched = await dispatchFreshIteration(pi, ctx, loop);
        if (!dispatched && loop.pendingHandoff) {
          return {
            content: [{ type: "text", text: `Iteration ${loop.iteration - 1} complete. Next iteration will continue via pending Ralph compaction handoff.` }],
            details: { loop },
          };
        }
        if (!dispatched) {
          setStatus(loop, "paused");
          addVerification(loop, "Paused after ralph_done because fresh-context dispatch failed");
          persistLoop(ctx, store, loop);
          if (ctx.hasUI) ctx.ui.notify(`Paused Ralph loop: ${loop.name}. Fresh-context dispatch failed after ralph_done. Resume manually once the handoff path is healthy.`, "warning");
          return {
            content: [{ type: "text", text: `Error: iteration advanced, but fresh-context dispatch failed for loop "${loop.name}". Ralph paused for manual resume.` }],
            details: { loop },
          };
        }
        return {
          content: [{ type: "text", text: `Iteration ${loop.iteration - 1} complete. Next iteration queued with fresh provider context.` }],
          details: { loop },
        };
      }
      const dispatched = await dispatchNextIteration(pi, ctx, loop);
      if (!dispatched) {
        setStatus(loop, "paused");
        addVerification(loop, "Paused after ralph_done because follow-up dispatch failed");
        persistLoop(ctx, store, loop);
        if (ctx.hasUI) ctx.ui.notify(`Paused Ralph loop: ${loop.name}. Follow-up dispatch failed after ralph_done. Resume manually once the queue path is healthy.`, "warning");
        return {
          content: [{ type: "text", text: `Error: iteration advanced, but follow-up dispatch failed for loop "${loop.name}". Ralph paused for manual resume.` }],
          details: { loop },
        };
      }
      return { content: [{ type: "text", text: `Iteration ${loop.iteration - 1} complete. Next iteration queued.` }], details: { loop } };
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const store = loadStore(ctx);
    const loop = getCurrentLoopWithHint(store, ctx);
    if (!loop || loop.status !== "active") return;
    rememberLoopHint(ctx, loop.name);
    const basePrompt = typeof event?.systemPrompt === "string" ? event.systemPrompt : "";
    const userPrompt = typeof event?.prompt === "string" ? event.prompt : "";
    const overlay = loadRalphOverlay(ctx);
    const cleanBasePrompt = stripManagedRalphContext(basePrompt);
    if (isQueuedCompactionHandoffPrompt(userPrompt)) {
      debugLog(
        `[ralph] before_agent_start handoff-tool-turn loop=${loop.name} iteration=${loop.iteration} baseChars=${basePrompt.length} cleanBaseChars=${cleanBasePrompt.length}`
      );
      return {
        systemPrompt: cleanBasePrompt,
      };
    }
    const managedPrompt = buildManagedRalphSystemPrompt(loop, overlay);
    debugLog(
      `[ralph] before_agent_start loop=${loop.name} iteration=${loop.iteration} baseChars=${basePrompt.length} cleanBaseChars=${cleanBasePrompt.length} managedChars=${managedPrompt.length} overlayChars=${overlay ? overlay.length : 0}`
    );
    return {
      systemPrompt: cleanBasePrompt ? `${cleanBasePrompt}\n${managedPrompt}` : managedPrompt,
    };
  });
}
