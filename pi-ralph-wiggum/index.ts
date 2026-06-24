/**
 * Ralph Wiggum - Long-running agent loops for iterative development.
 * Port of Geoffrey Huntley's approach.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const RALPH_DIR = ".ralph";
const COMPLETE_MARKER = "<promise>COMPLETE</promise>";
const SESSION_RESET_MARKER = "Previous Ralph loop transcript intentionally discarded. Continue from current task state only.";
const FAKE_RALPH_DONE_PATTERN = /<(?:invoke|tool_use|tool|function_call)\b[^>]*(?:name=["']ralph_done["']|ralph_done)[\s\S]*?<\/(?:invoke|tool_use|tool|function_call)>|<ralph_done\b[^>]*\/?>/i;
const PROMPT_PLAN_MAX_CHARS = 5000;
const PROMPT_FIELD_MAX_CHARS = 500;
const PROMPT_SUMMARY_MAX_CHARS = 700;
const PROMPT_MAX_GOALS = 5;
const PROMPT_MAX_TASK_NOTES = 1;
const PROMPT_MAX_TASK_EVIDENCE = 1;

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
	sessionStrategy: SessionStrategy;
	sessionStrategyFailure: SessionStrategyFailure;
	pendingSessionReset?: boolean;
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
		raw.sessionStrategy = parseSessionStrategy(raw.sessionStrategy);
		raw.sessionStrategyFailure = parseSessionStrategyFailure(raw.sessionStrategyFailure);
		raw.pendingSessionReset = raw.pendingSessionReset === true;
		return raw as LoopState;
	}

	function loadState(ctx: ExtensionContext, name: string, archived = false): LoopState | null {
		const content = tryRead(getPath(ctx, name, ".state.json", archived));
		return content ? migrateState(JSON.parse(content)) : null;
	}

	function saveState(ctx: ExtensionContext, state: LoopState, archived = false): void {
		state.active = state.status === "active";
		const filePath = getPath(ctx, state.name, ".state.json", archived);
		ensureDir(filePath);
		fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
	}

	function listLoops(ctx: ExtensionContext, archived = false): LoopState[] {
		const dir = archived ? archiveDir(ctx) : ralphDir(ctx);
		if (!fs.existsSync(dir)) return [];
		return fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".state.json"))
			.map((f) => {
				const content = tryRead(path.join(dir, f));
				return content ? migrateState(JSON.parse(content)) : null;
			})
			.filter((s): s is LoopState => s !== null);
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
		const content = tryRead(getPath(ctx, name, ".plan.json", archived));
		return content ? migratePlan(JSON.parse(content), name) : null;
	}

	function savePlan(ctx: ExtensionContext, plan: RalphPlan, archived = false): void {
		plan.tasks = plan.tasks.sort((a, b) => a.order - b.order).map((task, index) => ({ ...task, order: index + 1 }));
		plan.meta.updatedAt = nowIso();
		const filePath = getPath(ctx, plan.loopName, ".plan.json", archived);
		ensureDir(filePath);
		fs.writeFileSync(filePath, JSON.stringify(plan, null, 2), "utf-8");
	}

	function planToText(plan: RalphPlan): string {
		const total = plan.tasks.length;
		const done = plan.tasks.filter((task) => task.status === "done").length;
		const blocked = plan.tasks.filter((task) => task.status === "blocked").length;
		const inProgress = plan.tasks.filter((task) => task.status === "in_progress").length;
		const sections = [`# ${plan.title}`];

		if (plan.summary.trim()) sections.push(plan.summary.trim());
		sections.push(
			`Generated by Ralph. Canonical task state lives in \`.plan.json\`; use Ralph tools and commands to update it.`,
			`Progress: ${done}/${total} done${inProgress > 0 ? `, ${inProgress} in progress` : ""}${blocked > 0 ? `, ${blocked} blocked` : ""}.`,
		);

		if (plan.goals.length > 0) {
			sections.push("## Goals", ...plan.goals.map((goal) => `- ${goal}`));
		}

		sections.push(
			"## Tasks",
			...(plan.tasks.length > 0
				? plan.tasks.map((task) => {
						const lines = [`- [${task.status === "done" ? "x" : " "}] \`${task.id}\` ${task.title} (${TASK_STATUS_LABELS[task.status]})`];
						if (task.details?.trim()) lines.push(`  Details: ${task.details.trim()}`);
						if (task.evidence.length > 0) lines.push(`  Evidence: ${task.evidence.join(" | ")}`);
						if (task.notes.length > 0) lines.push(`  Notes: ${task.notes.join(" | ")}`);
						return lines.join("\n");
					})
				: ["- No tasks recorded."]),
		);

		if (plan.verification.length > 0) {
			sections.push("## Verification", ...plan.verification.map((entry) => `- [${entry.at}] ${entry.text}`));
		}

		if (plan.notes.length > 0) {
			sections.push("## Notes", ...plan.notes.map((note) => `- [${note.at}] ${note.text}`));
		}

		if (plan.reflections.length > 0) {
			sections.push(
				"## Reflections",
				...plan.reflections.map((entry) => `- [${entry.at}] Iteration ${entry.iteration}: ${entry.text}`),
			);
		}

		return sections.join("\n\n");
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
		return `${text.slice(0, PROMPT_PLAN_MAX_CHARS)}\n\n[Prompt plan truncated by ${text.length - PROMPT_PLAN_MAX_CHARS} chars. Use ralph_get_plan, ralph_list_tasks, or the .plan.json state for full history.]`;
	}

	function selectNextTask(plan: RalphPlan): RalphTask | null {
		return (
			plan.tasks.find((task) => task.status === "in_progress") ??
			plan.tasks.find((task) => task.status === "todo") ??
			plan.tasks.find((task) => task.status === "blocked") ??
			null
		);
	}

	function planToPromptText(plan: RalphPlan): string {
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
			`Minimal runtime view. Full canonical state remains in \`.ralph/${plan.loopName}.plan.json\`; use Ralph tools only when you need more than the next task.`,
			`Tasks: ${plan.tasks.length} total, ${counts.done} done, ${counts.in_progress} in progress, ${counts.blocked} blocked, ${counts.todo} todo, ${counts.cancelled} cancelled.`,
		);

		if (plan.goals.length > 0) {
			const goals = plan.goals.slice(0, PROMPT_MAX_GOALS).map((goal) => `- ${truncateForPrompt(goal, 260)}`);
			if (plan.goals.length > goals.length) goals.push(`- ${plan.goals.length - goals.length} additional goals omitted from prompt.`);
			sections.push("## Goals", ...goals);
		}

		const nextTask = selectNextTask(plan);
		sections.push(
			"## Next Task",
			nextTask
				? formatPromptTask(nextTask)
				: "- No active task found. If all work is complete, respond with the completion marker.",
		);

		sections.push(
			"## How To Proceed",
			"- Start with the next task above.",
			"- If the next task is ambiguous, call ralph_get_plan or ralph_list_tasks instead of relying on old prompt history.",
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
		const lines = tasks.map((task) => `- ${task.id} [${task.status}] ${task.title}`);
		return [summarizePlan(plan), "", ...(lines.length > 0 ? lines : ["No matching tasks."])].join("\n");
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
			summary = `Imported legacy Ralph plan for ${title}. Review notes and tasks for preserved context.`;
		}

		if (tasks.length === 0) {
			tasks.push({
				id: "task-1",
				title: "Review imported legacy plan",
				status: "todo",
				order: 1,
				details: "Legacy markdown could not be cleanly mapped to structured tasks.",
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

	function writePlanSnapshot(ctx: ExtensionContext, state: LoopState, plan: RalphPlan): string {
		const snapshotPath = path.resolve(ctx.cwd, state.taskFile);
		ensureDir(snapshotPath);
		fs.writeFileSync(snapshotPath, planToText(plan), "utf-8");
		return snapshotPath;
	}

	function ensurePlan(ctx: ExtensionContext, state: LoopState, sourceContent?: string): RalphPlan {
		const existingPlan = loadPlan(ctx, state.name);
		if (existingPlan) {
			writePlanSnapshot(ctx, state, existingPlan);
			return existingPlan;
		}

		const rawContent = sourceContent ?? tryRead(path.resolve(ctx.cwd, state.taskFile)) ?? DEFAULT_TEMPLATE;
		const plan = parseLegacyMarkdownPlan(rawContent, state.name);
		savePlan(ctx, plan);
		writePlanSnapshot(ctx, state, plan);
		return plan;
	}

	function savePlanAndSnapshot(ctx: ExtensionContext, state: LoopState, plan: RalphPlan): void {
		savePlan(ctx, plan);
		writePlanSnapshot(ctx, state, plan);
	}

	function getPlanState(ctx: ExtensionContext, loopName?: string): { state: LoopState; plan: RalphPlan } | null {
		const name = loopName ?? currentLoop;
		if (!name) return null;
		const state = loadState(ctx, name);
		if (!state) return null;
		const plan = ensurePlan(ctx, state);
		return { state, plan };
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

	function formatLoop(l: LoopState): string {
		const status = `${STATUS_ICONS[l.status]} ${l.status}`;
		const iter = l.maxIterations > 0 ? `${l.iteration}/${l.maxIterations}` : `${l.iteration}`;
		return `${l.name}: ${status} (iteration ${iter})`;
	}

	function updateUI(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const state = currentLoop ? loadState(ctx, currentLoop) : null;
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
			` · 🔁 ${state.name} · ${STATUS_ICONS[state.status]} ${state.status} · 🔢 ${state.iteration}${maxStr} · 📄 ${state.taskFile}${reflection} · Esc pause · msg resume · /ralph-stop stop`,
		);
		ctx.ui.setStatus("ralph", `${title}${status}`);
		ctx.ui.setWidget("ralph", undefined);
	}

	function buildPrompt(state: LoopState, taskContent: string, isReflection: boolean): string {
		const maxStr = state.maxIterations > 0 ? `/${state.maxIterations}` : "";
		const header = `───────────────────────────────────────────────────────────────────────
🔄 RALPH LOOP: ${state.name} | Iteration ${state.iteration}${maxStr}${isReflection ? " | 🪞 REFLECTION" : ""}
───────────────────────────────────────────────────────────────────────`;

		const parts = [header, ""];
		if (isReflection) parts.push(state.reflectInstructions, "\n---\n");
		parts.push(`## Current Plan Runtime View (compact; generated from ${state.taskFile})\n\n${taskContent}\n\n---`);
		parts.push(`\n## Instructions\n`);
		parts.push("User controls: ESC pauses the assistant. Send a message to resume. Run /ralph-stop when idle to stop the loop.\n");
		parts.push(`You are in a Ralph loop (iteration ${state.iteration}${state.maxIterations > 0 ? ` of ${state.maxIterations}` : ""}).\n`);
		if (state.itemsPerIteration > 0) {
			parts.push(`**THIS ITERATION: Process approximately ${state.itemsPerIteration} task items, then call the actual ralph_done tool.**\n`);
			parts.push(`1. Start from the single Next Task in the runtime view, then inspect additional tasks only if you need up to ~${state.itemsPerIteration} items for this iteration.`);
		} else {
			parts.push("1. Start from the single Next Task in the runtime view.");
		}
		parts.push("2. To figure out what to do next: read the Next Task id/title/details first. If that is insufficient, call ralph_get_plan for full context or ralph_list_tasks to list pending tasks; do not read the generated markdown snapshot just to discover task state.");
		parts.push("3. Before doing task work, mark the task in_progress with ralph_update_task if it is not already in progress.");
		parts.push("4. Do the work using the available project tools. If a project tool reports that setup is required, such as setting the project cwd, do that setup once before retrying the tool.");
		parts.push("5. When a task is complete, call ralph_update_task with status done and concise evidence describing what changed and how you verified it. If blocked, use status blocked with a blocker note. If partially done, leave it in_progress and add a note/evidence.");
		parts.push("6. Treat Ralph state as canonical: use ralph_update_task, ralph_add_task, ralph_add_note, ralph_record_reflection, and related Ralph tools. Treat generated snapshot files as read-only output; do not edit them directly.");
		parts.push(`7. Treat ${state.taskFile} as generated output; do not edit it directly.`);
		parts.push(`8. When FULLY COMPLETE, respond with: ${COMPLETE_MARKER}`);
		parts.push("9. Otherwise, call the actual ralph_done tool to proceed to next iteration. Do not write an XML tag or textual placeholder such as <invoke name=\"ralph_done\"></invoke>.");
		return parts.join("\n");
	}

	function buildResetPrompt(state: LoopState, taskContent: string, isReflection: boolean): string {
		return `${SESSION_RESET_MARKER}\n\n${buildPrompt(state, taskContent, isReflection)}`;
	}

	function getIterationContent(ctx: ExtensionContext, state: LoopState): { content: string; needsReflection: boolean } | null {
		const plan = ensurePlan(ctx, state);
		const content = planToPromptText(plan);
		const needsReflection = state.reflectEvery > 0 && (state.iteration - 1) % state.reflectEvery === 0;
		return { content, needsReflection };
	}

	function dispatchNextIterationFollowUp(state: LoopState, taskContent: string, needsReflection: boolean): void {
		pi.sendUserMessage(buildPrompt(state, taskContent, needsReflection), { deliverAs: "followUp" });
	}

	function dispatchNextIterationResetFollowUp(state: LoopState, taskContent: string, needsReflection: boolean): void {
		pi.sendUserMessage(buildResetPrompt(state, taskContent, needsReflection), { deliverAs: "followUp" });
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
			pauseLoop(ctx, state, `Paused Ralph loop: ${state.name}. Could not read plan file: ${state.taskFile}`);
			return;
		}
		const { content, needsReflection } = iterationData;
		state.pendingSessionReset = true;
		saveState(ctx, state);
		dispatchNextIterationResetFollowUp(state, content, needsReflection);
	}

	function pauseLoop(ctx: ExtensionContext, state: LoopState, message?: string): void {
		state.status = "paused";
		state.active = false;
		state.pendingSessionReset = false;
		saveState(ctx, state);
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

	function renderPlanCommand(ctx: ExtensionContext, loopName?: string): string | null {
		const result = getPlanState(ctx, loopName);
		if (!result) return null;
		savePlanAndSnapshot(ctx, result.state, result.plan);
		return result.state.taskFile;
	}

	function registerPlanCommand(name: string, _description: string, handler: (rest: string, ctx: any) => void | Promise<void>): void {
		commands[name] = handler;
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
			const taskFile = isPath ? args.name : path.join(RALPH_DIR, `${loopName}.md`);
			const existing = loadState(ctx, loopName);
			if (existing?.status === "active") {
				ctx.ui.notify(`Loop "${loopName}" is already active. Use /ralph resume ${loopName}`, "warning");
				return;
			}

			const fullPath = path.resolve(ctx.cwd, taskFile);
			if (!fs.existsSync(fullPath)) {
				ensureDir(fullPath);
				fs.writeFileSync(fullPath, DEFAULT_TEMPLATE, "utf-8");
				ctx.ui.notify(`Created task file: ${taskFile}`, "info");
			}

			const state: LoopState = {
				name: loopName,
				taskFile,
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
				sessionStrategy: args.sessionStrategy,
				sessionStrategyFailure: args.sessionStrategyFailure,
				pendingSessionReset: false,
			};

			saveState(ctx, state);
			const initialPlan = ensurePlan(ctx, state);
			savePlanAndSnapshot(ctx, state, initialPlan);
			currentLoop = loopName;
			updateUI(ctx);
			if (state.sessionStrategy === "newSession") {
				await dispatchNextIterationFreshContext(ctx, state);
				return;
			}
			dispatchNextIterationFollowUp(state, planToPromptText(initialPlan), false);
		},

		stop(_rest, ctx) {
			if (!currentLoop) {
				const active = listLoops(ctx).find((l) => l.status === "active");
				if (active) pauseLoop(ctx, active, `Paused Ralph loop: ${active.name} (iteration ${active.iteration})`);
				else ctx.ui.notify("No active Ralph loop", "warning");
				return;
			}
			const state = loadState(ctx, currentLoop);
			if (state) pauseLoop(ctx, state, `Paused Ralph loop: ${currentLoop} (iteration ${state.iteration})`);
		},

		async resume(rest, ctx) {
			const loopName = rest.trim();
			if (!loopName) {
				ctx.ui.notify("Usage: /ralph resume <name>", "warning");
				return;
			}
			const state = loadState(ctx, loopName);
			if (!state) {
				ctx.ui.notify(`Loop "${loopName}" not found`, "error");
				return;
			}
			if (state.status === "completed") {
				ctx.ui.notify(`Loop "${loopName}" is completed. Use /ralph start ${loopName} to restart`, "warning");
				return;
			}
			if (currentLoop && currentLoop !== loopName) {
				const curr = loadState(ctx, currentLoop);
				if (curr) pauseLoop(ctx, curr);
			}

			state.status = "active";
			state.active = true;
			state.iteration++;
			saveState(ctx, state);
			const plan = ensurePlan(ctx, state);
			currentLoop = loopName;
			updateUI(ctx);
			ctx.ui.notify(`Resumed: ${loopName} (iteration ${state.iteration})`, "info");

			const needsReflection = state.reflectEvery > 0 && state.iteration > 1 && (state.iteration - 1) % state.reflectEvery === 0;
			if (state.sessionStrategy === "newSession") {
				await dispatchNextIterationFreshContext(ctx, state);
				return;
			}
			dispatchNextIterationFollowUp(state, planToPromptText(plan), needsReflection);
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
			tryDelete(getPath(ctx, loopName, ".state.json"));
			tryDelete(getPath(ctx, loopName, ".plan.json"));
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

			const srcState = getPath(ctx, loopName, ".state.json");
			const dstState = getPath(ctx, loopName, ".state.json", true);
			ensureDir(dstState);
			if (fs.existsSync(srcState)) fs.renameSync(srcState, dstState);

			const srcPlan = getPath(ctx, loopName, ".plan.json");
			const dstPlan = getPath(ctx, loopName, ".plan.json", true);
			ensureDir(dstPlan);
			if (fs.existsSync(srcPlan)) fs.renameSync(srcPlan, dstPlan);

			const srcTask = path.resolve(ctx.cwd, state.taskFile);
			if (srcTask.startsWith(ralphDir(ctx)) && !srcTask.startsWith(archiveDir(ctx))) {
				const dstTask = getPath(ctx, loopName, ".md", true);
				if (fs.existsSync(srcTask)) fs.renameSync(srcTask, dstTask);
			}

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
				tryDelete(getPath(ctx, loop.name, ".state.json"));
				tryDelete(getPath(ctx, loop.name, ".plan.json"));
				if (all) tryDelete(getPath(ctx, loop.name, ".md"));
				if (currentLoop === loop.name) currentLoop = null;
			}
			const suffix = all ? " (all files)" : " (state + plan)";
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
			const warning = "This deletes all .ralph state, plan, snapshot, and archive files.";
			const run = () => {
				const dir = ralphDir(ctx);
				if (!fs.existsSync(dir)) {
					if (ctx.hasUI) ctx.ui.notify("No .ralph directory found.", "info");
					return;
				}
				currentLoop = null;
				const ok = tryRemoveDir(dir);
				if (ctx.hasUI) ctx.ui.notify(ok ? "Removed .ralph directory." : "Failed to remove .ralph directory.", ok ? "info" : "error");
				updateUI(ctx);
			};
			if (!force) {
				if (ctx.hasUI) {
					void ctx.ui.confirm("Delete all Ralph loop files?", warning).then((confirmed) => {
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

	registerPlanCommand("render-plan", "Regenerate markdown snapshot", (rest, ctx) => {
		const loopName = rest.trim() || undefined;
		const renderedPath = renderPlanCommand(ctx, loopName);
		if (!renderedPath) {
			ctx.ui.notify(loopName ? `Loop "${loopName}" not found` : "No active Ralph loop", "warning");
			return;
		}
		ctx.ui.notify(`Rendered plan snapshot: ${renderedPath}`, "info");
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
		savePlanAndSnapshot(ctx, result.state, result.plan);
		ctx.ui.notify(`Updated ${task.id}: ${task.title} -> ${task.status}`, "info");
	});

	const HELP = `Ralph Wiggum - Long-running development loops

Commands:
  /ralph start <name|path> [options]  Start a new loop
  /ralph stop                         Pause current loop
  /ralph resume <name>                Resume a paused loop
  /ralph status                       Show all loops
  /ralph show-plan [loop]             Show structured plan summary
  /ralph list-tasks [loop] [--status STATUS]  Show structured tasks
  /ralph task <done|block> <task-id> [loop]   Quick task update
  /ralph render-plan [loop]           Regenerate markdown snapshot
  /ralph cancel <name>                Delete loop state
  /ralph archive <name>               Move loop to archive
  /ralph clean [--all]                Clean completed loops
  /ralph list --archived              Show archived loops
  /ralph nuke [--yes]                 Delete all .ralph data
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
			let state = currentLoop ? loadState(ctx, currentLoop) : null;
			if (!state) {
				const active = listLoops(ctx).find((l) => l.status === "active");
				if (!active) {
					if (ctx.hasUI) ctx.ui.notify("No active Ralph loop", "warning");
					return;
				}
				state = active;
			}
			if (state.status !== "active") {
				if (ctx.hasUI) ctx.ui.notify(`Loop "${state.name}" is not active`, "warning");
				return;
			}
			stopLoop(ctx, state, `Stopped Ralph loop: ${state.name} (iteration ${state.iteration})`);
		},
	});

	pi.registerTool({
		name: "ralph_start",
		label: "Start Ralph Loop",
		description: "Start a long-running development loop. Imports markdown into structured Ralph plan state.",
		promptSnippet: "Start a persistent multi-iteration development loop with structured task state.",
		promptGuidelines: [
			"Use this tool when the user explicitly wants an iterative loop, autonomous repeated passes, or paced multi-step execution.",
			"After starting a loop, use Ralph plan tools to inspect and update progress; do not edit the generated markdown snapshot directly.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Loop name (e.g., 'refactor-auth')" }),
			taskContent: Type.String({ description: "Legacy markdown task content to import into structured plan state" }),
			itemsPerIteration: Type.Optional(Type.Number({ description: "Suggest N items per turn (0 = no limit)" })),
			reflectEvery: Type.Optional(Type.Number({ description: "Reflect every N iterations" })),
			maxIterations: Type.Optional(Type.Number({ description: "Max iterations (default: 50)", default: 50 })),
			sessionStrategy: Type.Optional(Type.String({ description: "How to dispatch the next iteration: followUp or newSession" })),
			sessionStrategyFailure: Type.Optional(Type.String({ description: "Compatibility-only; currently unused" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const loopName = sanitize(params.name);
			const taskFile = path.join(RALPH_DIR, `${loopName}.md`);
			if (loadState(ctx, loopName)?.status === "active") {
				return { content: [{ type: "text", text: `Loop "${loopName}" already active.` }], details: {} };
			}
			const state: LoopState = {
				name: loopName,
				taskFile,
				iteration: 1,
				maxIterations: params.maxIterations ?? 50,
				itemsPerIteration: params.itemsPerIteration ?? 0,
				reflectEvery: params.reflectEvery ?? 0,
				reflectInstructions: DEFAULT_REFLECT_INSTRUCTIONS,
				active: true,
				status: "active",
				startedAt: nowIso(),
				lastReflectionAt: 0,
				lastDoneReminderAt: 0,
				sessionStrategy: parseSessionStrategy(params.sessionStrategy),
				sessionStrategyFailure: parseSessionStrategyFailure(params.sessionStrategyFailure),
				pendingSessionReset: false,
			};
			saveState(ctx, state);
			const plan = parseLegacyMarkdownPlan(params.taskContent, loopName);
			savePlanAndSnapshot(ctx, state, plan);
			currentLoop = loopName;
			updateUI(ctx);
			if (state.sessionStrategy === "newSession") {
				state.pendingSessionReset = true;
				saveState(ctx, state);
				return {
					content: [
						{
							type: "text",
							text: `Started loop "${loopName}" with ${plan.tasks.length} structured task(s). First iteration queued with fresh provider context.`,
						},
					],
					details: {},
				};
			}
			dispatchNextIterationFollowUp(state, planToPromptText(plan), false);
			return {
				content: [{ type: "text", text: `Started loop "${loopName}" with ${plan.tasks.length} structured task(s).` }],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "ralph_get_plan",
		label: "Get Ralph Plan",
		description: "Return the canonical structured plan for the active loop or a named loop.",
		promptSnippet: "Inspect Ralph's authoritative structured plan state.",
		promptGuidelines: ["Use this before planning work when you need the current task state, goals, notes, or verification."],
		parameters: Type.Object({
			loopName: Type.Optional(Type.String({ description: "Optional loop name. Defaults to the active loop." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = getPlanState(ctx, params.loopName);
			if (!result) return { content: [{ type: "text", text: "Ralph loop not found." }], details: {} };
			return { content: [{ type: "text", text: JSON.stringify(result.plan, null, 2) }], details: {} };
		},
	});

	pi.registerTool({
		name: "ralph_list_tasks",
		label: "List Ralph Tasks",
		description: "List ordered tasks for the active loop or a named loop.",
		promptSnippet: "Get a compact view of Ralph tasks and statuses.",
		promptGuidelines: ["Use this to identify the next tasks to work on without reading the full plan payload."],
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
			savePlanAndSnapshot(ctx, result.state, result.plan);
			return { content: [{ type: "text", text: `Added ${task.id}: ${task.title}` }], details: {} };
		},
	});

	pi.registerTool({
		name: "ralph_update_task",
		label: "Update Ralph Task",
		description: "Update a task in the structured Ralph plan by stable id.",
		promptSnippet: "Mutate Ralph task state safely without editing markdown directly.",
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
			savePlanAndSnapshot(ctx, result.state, result.plan);
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
			savePlanAndSnapshot(ctx, result.state, result.plan);
			return { content: [{ type: "text", text: "Added Ralph note." }], details: {} };
		},
	});

	pi.registerTool({
		name: "ralph_record_reflection",
		label: "Record Ralph Reflection",
		description: "Append a structured reflection entry for the current Ralph iteration.",
		promptSnippet: "Persist Ralph reflection checkpoints in canonical state.",
		promptGuidelines: ["Use this during reflection iterations instead of editing a markdown reflection section."],
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
			savePlanAndSnapshot(ctx, result.state, result.plan);
			return { content: [{ type: "text", text: "Recorded Ralph reflection." }], details: {} };
		},
	});

	pi.registerTool({
		name: "ralph_render_plan",
		label: "Render Ralph Plan",
		description: "Regenerate the markdown snapshot from canonical Ralph JSON state.",
		promptSnippet: "Refresh the human-readable Ralph snapshot file.",
		promptGuidelines: ["Use this for explicit admin/repair workflows; normal plan mutations render automatically."],
		parameters: Type.Object({
			loopName: Type.Optional(Type.String({ description: "Optional loop name. Defaults to the active loop." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const renderedPath = renderPlanCommand(ctx, params.loopName);
			if (!renderedPath) return { content: [{ type: "text", text: "Ralph loop not found." }], details: {} };
			return { content: [{ type: "text", text: `Rendered snapshot: ${renderedPath}` }], details: {} };
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
			if (!currentLoop) return { content: [{ type: "text", text: "No active Ralph loop." }], details: {} };
			const state = loadState(ctx, currentLoop);
			if (!state || state.status !== "active") return { content: [{ type: "text", text: "Ralph loop is not active." }], details: {} };
			if (ctx.hasPendingMessages()) {
				return { content: [{ type: "text", text: "Pending messages already queued. Skipping ralph_done." }], details: {} };
			}
			state.iteration++;
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
				return { content: [{ type: "text", text: `Error: Could not read plan snapshot: ${state.taskFile}` }], details: {} };
			}
			const { content, needsReflection } = iterationData;
			if (needsReflection) state.lastReflectionAt = state.iteration;
			saveState(ctx, state);
			updateUI(ctx);
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
			dispatchNextIterationFollowUp(state, content, needsReflection);
			return { content: [{ type: "text", text: `Iteration ${state.iteration - 1} complete. Next iteration queued.` }], details: {} };
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!currentLoop) return;
		const state = loadState(ctx, currentLoop);
		if (!state || state.status !== "active") return;
		const iterStr = `${state.iteration}${state.maxIterations > 0 ? `/${state.maxIterations}` : ""}`;
		let instructions = `You are in a Ralph loop working on generated plan snapshot: ${state.taskFile}\n`;
		if (state.itemsPerIteration > 0) instructions += `- Work on ~${state.itemsPerIteration} task items this iteration\n`;
		instructions += `- Start from the Next Task in the runtime prompt; call ralph_get_plan or ralph_list_tasks only when you need more task context\n`;
		instructions += `- Mark active work in_progress, done, blocked, or cancelled with ralph_update_task\n`;
		instructions += `- Record concise notes/evidence/reflections in structured Ralph state; do not edit generated markdown snapshots directly\n`;
		instructions += `- When FULLY COMPLETE: ${COMPLETE_MARKER}\n`;
		instructions += `- Otherwise, call the actual ralph_done tool to proceed to next iteration. Do not write an XML tag or textual placeholder such as <invoke name="ralph_done"></invoke>.`;
		return {
			systemPrompt: event.systemPrompt + `\n[RALPH LOOP - ${state.name} - Iteration ${iterStr}]\n\n${instructions}`,
		};
	});

	pi.on("context", async (event, ctx) => {
		if (!currentLoop) return;
		const state = loadState(ctx, currentLoop);
		if (!state || state.status !== "active" || !state.pendingSessionReset) return;
		const resetMessage = lastResetPromptMessage(event.messages);
		if (!resetMessage) return;
		state.pendingSessionReset = false;
		saveState(ctx, state);
		return { messages: [resetMessage] };
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!currentLoop) return;
		let state = loadState(ctx, currentLoop);
		if (!state || state.status !== "active") return;
		const lastAssistant = [...event.messages].reverse().find((m) => m.role === "assistant");
		const naturalStop = isNaturalAssistantStop(lastAssistant);
		const text =
			lastAssistant && Array.isArray(lastAssistant.content)
				? lastAssistant.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n")
				: "";
		if (naturalStop && text.includes(COMPLETE_MARKER)) {
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
		if (state.pendingSessionReset) {
			state.pendingSessionReset = false;
			saveState(ctx, state);
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
					? `You wrote text that looks like a ralph_done tool call, but Pi did not execute it. If this iteration is done, call the actual ralph_done tool now using the tool interface. Do not write XML, <invoke>, or placeholder text. If the whole loop is complete, respond with ${COMPLETE_MARKER}.`
					: `You are still in Ralph loop "${state.name}" at iteration ${state.iteration}. If you are done with the tasks for this iteration, call the actual ralph_done tool now using the tool interface. If the whole loop is complete, respond with ${COMPLETE_MARKER}. Otherwise, continue working on the current iteration and update ${state.taskFile}.`,
				{ deliverAs: "followUp" },
			);
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		const active = listLoops(ctx).filter((l) => l.status === "active");
		if (!currentLoop && active.length > 0) {
			const mostRecent = active.reduce((best, candidate) => {
				const bestMtime = safeMtimeMs(getPath(ctx, best.name, ".state.json"));
				const candidateMtime = safeMtimeMs(getPath(ctx, candidate.name, ".state.json"));
				return candidateMtime > bestMtime ? candidate : best;
			});
			currentLoop = mostRecent.name;
		}
		if (active.length > 0 && ctx.hasUI) {
			const lines = active.map((l) => `  • ${l.name} (iteration ${l.iteration}${l.maxIterations > 0 ? `/${l.maxIterations}` : ""})`);
			ctx.ui.notify(`Active Ralph loops:\n${lines.join("\n")}\n\nUse /ralph resume <name> to continue`, "info");
		}
		updateUI(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (currentLoop) {
			const state = loadState(ctx, currentLoop);
			if (state) saveState(ctx, state);
		}
	});
}
