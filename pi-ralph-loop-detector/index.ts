import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";

import { LoopDetector } from "./src/index.js";
import { evaluateLoopWithSubagent, evaluateRecoverySummaryWithSubagent } from "./src/subagent-bridge.js";
import { buildRecoveryPrompt, summarizeRecovery } from "./routing.js";
import {
	clearPendingRalphHandoff,
	dispatchPendingRalphHandoff,
	ensurePendingRalphHandoff,
	getActiveRalphLoop,
	getPendingRalphHandoff,
	markPendingRalphHandoffQueued,
	maybeDispatchStoppedLoopSteering,
	registerRalphSurface,
	updatePendingRalphHandoffPrompt,
} from "./ralph-tools.js";

type LoopEvent =
	| {
		type: "assistant_message";
		content: string;
		timestamp?: string;
		id?: string;
	}
	| {
		type: "tool_call";
		toolName: string;
		args?: Record<string, unknown>;
		timestamp?: string;
		id?: string;
	}
	| {
		type: "tool_result";
		toolName: string;
		args?: Record<string, unknown>;
		ok: boolean;
		progress?: boolean;
		result?: unknown;
		timestamp?: string;
		id?: string;
	};

type LoopOutcome = Awaited<ReturnType<LoopDetector["handleEvent"]>>;
type JudgeAction = "continue" | "stop" | "steer";
type JudgeBridge = (evidence: unknown) => Promise<{
	confidence: number;
	action: JudgeAction;
	steer_message?: string;
	reason?: string;
	offendingTool?: string | null;
}>;

interface RuntimeState {
	detector: LoopDetector;
	events: LoopEvent[];
	inputHistory: string[];
	debugEvents: Array<{ at: string; stage: string; payload: unknown }>;
	enabled: boolean;
	debugEnabled: boolean;
	lastDebugFlushedIndex: number;
	hostContext: any | null;
	halted: boolean;
	haltReason: string | null;
	lastOutcome: LoopOutcome;
	lastRecoveryPrompt: string | null;
	lastRecoveryAnalysis: RecoveryAnalysis | null;
	lastRecoveryAgents: string[];
	judgeConfidenceThreshold: number;
	activeLoopName: string | null;
	lastResetAt: string;
	pendingRecoveryOutcome: NonNullable<LoopOutcome> | null;
	handoffToolTurnActive: boolean;
	handoffToolTurnLoopName: string | null;
	handoffToolTurnPromptChars: number;
	handoffToolTurnSeenAt: string | null;
	handoffToolTurnProviderResponded: boolean;
	handoffToolTurnToolCalled: boolean;
}

interface RecoveryAnalysis {
	summary: string;
	nextSteps: string[];
	rationale?: string;
	suspectedGoal?: string;
	offendingTool?: string | null;
}

const RALPH_DEBUG_LOG = "/tmp/pi-ralph-loop-detector.log";

function debugLog(message: string): void {
	try {
		fs.appendFileSync(RALPH_DEBUG_LOG, `${message}\n`, "utf8");
	} catch {
		// Ignore logging failures; they must never affect runtime behavior.
	}
}

const COMPACTION_HANDOFF_TOOL_PROMPT = (loopName: string) =>
	[
		`A Ralph compaction handoff is queued for loop "${loopName}".`,
		"Call the `ralph_handoff` tool immediately.",
		"Do not continue normal work in this session before calling that tool.",
	].join("\n");

function isCompactionHandoffToolPrompt(prompt: string): boolean {
	return typeof prompt === "string"
		&& prompt.includes("A Ralph compaction handoff is queued for loop")
		&& prompt.includes("Call the `ralph_handoff` tool immediately.");
}

function parseCompactionHandoffLoopName(prompt: string): string | null {
	if (typeof prompt !== "string") return null;
	const match = prompt.match(/A Ralph compaction handoff is queued for loop "([^"]+)"/);
	return match?.[1] ?? null;
}

function isStaleExtensionContextError(error: unknown): boolean {
	const detail = error instanceof Error ? error.message : String(error);
	return detail.includes("This extension ctx is stale after session replacement or reload.");
}

function safeGetActiveRalphLoop(ctx: any) {
	try {
		return getActiveRalphLoop(ctx);
	} catch (error) {
		if (isStaleExtensionContextError(error)) {
			debugLog("[ralph] ignored stale extension ctx while reading active Ralph loop");
			return null;
		}
		throw error;
	}
}

const MAX_RUNTIME_EVENTS = 64;
const MAX_INPUT_HISTORY = 6;
const DEFAULT_JUDGE_TIMEOUT_MS = null;
const DEFAULT_JUDGE_CONFIDENCE_THRESHOLD = 0.7;
const MAX_INPUT_CHARS = 2000;
const MAX_DEBUG_EVENTS = 120;
const MAX_DEBUG_TEXT = 600;
const MAX_JUDGE_REASONING_MESSAGES = 6;
const MAX_JUDGE_REASONING_CHARS = 1200;
const MAX_JUDGE_TEXT_MESSAGES = 4;
const RALPH_DETECTOR_CONFIG = {
	sameTool: {
		minRepeats: 3,
	},
	intentMismatch: {
		mismatchThreshold: 2,
	},
	failureRepetition: {
		minFailures: 2,
	},
	assistantRepetition: {
		minRepeats: 3,
		minNormalizedChars: 90,
	},
	cycleRepetition: {
		minRepeats: 2,
	},
	classes: {
		read: {
			sameToolRepeats: 3,
			sameCycleRepeats: 2,
		},
		cleanup: {
			sameToolRepeats: 2,
			sameCycleRepeats: 2,
		},
		validate: {
			sameToolRepeats: 3,
			sameCycleRepeats: 2,
		},
		unknown: {
			sameToolRepeats: 3,
			sameCycleRepeats: 2,
		},
		write: {
			sameToolRepeats: 2,
			sameCycleRepeats: 2,
		},
	},
};

function createRuntimeState(config: Record<string, unknown> = {}, judgeBridge?: JudgeBridge): RuntimeState {
	const state = {
		detector: null as unknown as LoopDetector,
		events: [],
		inputHistory: [],
		debugEvents: [],
		enabled: config.enabled !== false,
		debugEnabled: Boolean(config.debug),
		lastDebugFlushedIndex: 0,
		hostContext: null,
		halted: false,
		haltReason: null,
		lastOutcome: null,
		lastRecoveryPrompt: null,
		lastRecoveryAnalysis: null,
		lastRecoveryAgents: [],
		judgeConfidenceThreshold: normalizeJudgeConfidenceThreshold(config.judgeConfidenceThreshold) ?? DEFAULT_JUDGE_CONFIDENCE_THRESHOLD,
		activeLoopName: null,
		lastResetAt: new Date().toISOString(),
		pendingRecoveryOutcome: null,
		handoffToolTurnActive: false,
		handoffToolTurnLoopName: null,
		handoffToolTurnPromptChars: 0,
		handoffToolTurnSeenAt: null,
		handoffToolTurnProviderResponded: false,
		handoffToolTurnToolCalled: false,
	} as RuntimeState;

	const judge = typeof judgeBridge === "function" ? (evidence: unknown) => judgeBridge(evidence) : undefined;
	const debug = (entry: { stage: string; payload: unknown }) => {
		state.debugEvents.push({
			at: new Date().toISOString(),
			stage: entry.stage,
			payload: entry.payload,
		});
		if (state.debugEvents.length > MAX_DEBUG_EVENTS) {
			state.debugEvents.splice(0, state.debugEvents.length - MAX_DEBUG_EVENTS);
			state.lastDebugFlushedIndex = Math.max(0, state.lastDebugFlushedIndex - 1);
		}
	};
	state.detector = new LoopDetector({
		...RALPH_DETECTOR_CONFIG,
		...config,
		judge,
		debug,
	});

	return state;
}

function normalizeJudgeConfidenceThreshold(value: unknown): number | null {
	const threshold = Number(value);
	if (!Number.isFinite(threshold)) return null;
	if (threshold < 0) return 0;
	if (threshold > 1) return 1;
	return threshold;
}

function resolveJudgeDisposition(outcome: NonNullable<LoopOutcome>, confidenceThreshold: number): {
	action: "continue" | "stop" | "steer";
	confidence: number;
	reason: string;
} {
	const action = outcome.review?.action ?? outcome.judgeOutcome?.action ?? "continue";
	const confidence = normalizeJudgeConfidence(outcome.review?.confidence ?? outcome.judgeOutcome?.confidence);
	const reason = outcome.review?.message ?? outcome.judgeOutcome?.reason ?? "";

	if (action === "continue") {
		return { action: "continue", confidence, reason };
	}

	if (isJudgeFallbackReason(reason)) {
		return { action: action === "steer" ? "steer" : "stop", confidence, reason };
	}

	if (confidence < confidenceThreshold) {
		return {
			action: "continue",
			confidence,
			reason: reason || "judge confidence below threshold",
		};
	}

	return {
		action: action === "steer" ? "steer" : "stop",
		confidence,
		reason,
	};
}

function normalizeJudgeConfidence(value: unknown): number {
	const confidence = Number(value);
	if (!Number.isFinite(confidence)) return 0;
	if (confidence < 0) return 0;
	if (confidence > 1) return 1;
	return confidence;
}

function isJudgeFallbackReason(reason: string): boolean {
	return /^(subagent response|loop judge unavailable)/i.test(reason.trim());
}

function loadProjectConfig(ctx: any): Record<string, unknown> {
	const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : "";
	if (!cwd) return {};

	for (const filename of [".pi-ralph-loop-detector.json", ".pi-loop-detector.json"]) {
		const configPath = path.join(cwd, filename);
		if (!fs.existsSync(configPath)) continue;
		try {
			const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
			if (ctx.hasUI) ctx.ui.notify(`${filename} must contain a JSON object; using defaults.`, "warning");
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI) ctx.ui.notify(`Failed to read ${filename}; using defaults: ${detail}`, "warning");
		}
	}

	return {};
}

function safeLoadProjectConfig(ctx: any): Record<string, unknown> {
	try {
		return loadProjectConfig(ctx);
	} catch (error) {
		if (isStaleExtensionContextError(error)) {
			debugLog("[ralph] ignored stale extension ctx while reading Ralph project config");
			return {};
		}
		throw error;
	}
}

function summarizeOutcome(outcome: LoopOutcome): string {
	return summarizeRecovery(outcome);
}

function formatDebugEntry(entry: { at: string; stage: string; payload: unknown }): string {
	let payloadText: string;
	if (typeof entry.payload === "string") {
		payloadText = entry.payload;
	} else {
		try {
			payloadText = JSON.stringify(entry.payload);
		} catch {
			payloadText = String(entry.payload);
		}
	}
	if (payloadText.length > MAX_DEBUG_TEXT) {
		payloadText = `${payloadText.slice(0, MAX_DEBUG_TEXT)}…`;
	}
	return `[${entry.at}] ${entry.stage} ${payloadText}`;
}

function flushDebugLogs(state: RuntimeState, ctx: any): void {
	if (!state.debugEnabled || !ctx?.hasUI) return;
	const entries = state.debugEvents.slice(state.lastDebugFlushedIndex);
	if (entries.length === 0) return;
	state.lastDebugFlushedIndex = state.debugEvents.length;
	const lines = entries.slice(-10).map((entry) => formatDebugEntry(entry));
	ctx.ui.notify(`Loop detector debug\n${lines.join("\n")}`, "info");
}

function recordRuntimeEvent(state: RuntimeState, event: LoopEvent): void {
	state.events.push(event);
	if (state.events.length > MAX_RUNTIME_EVENTS) {
		state.events.splice(0, state.events.length - MAX_RUNTIME_EVENTS);
	}
}

function recordInput(state: RuntimeState, text: string): void {
	const normalized = truncateText(text.trim(), MAX_INPUT_CHARS);
	if (!normalized) return;
	state.inputHistory.push(normalized);
	if (state.inputHistory.length > MAX_INPUT_HISTORY) {
		state.inputHistory.splice(0, state.inputHistory.length - MAX_INPUT_HISTORY);
	}
}

function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]`;
}

function extractText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value
			.map((item) => {
				if (typeof item === "string") return item;
				if (item && typeof item === "object" && "text" in item && typeof (item as { text?: unknown }).text === "string") {
					return (item as { text: string }).text;
				}
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	if (value && typeof value === "object") {
		const candidate = value as { text?: unknown; content?: unknown; message?: unknown };
		if (typeof candidate.text === "string") return candidate.text;
		if (candidate.content !== undefined) return extractText(candidate.content);
		if (candidate.message !== undefined) return extractText(candidate.message);
	}
	return "";
}

function getToolArgs(event: any): Record<string, unknown> {
	if (event?.args && typeof event.args === "object") return event.args as Record<string, unknown>;
	if (event?.input && typeof event.input === "object") return event.input as Record<string, unknown>;
	return {};
}

function inferResultPayload(event: any): unknown {
	return event?.result ?? event?.output ?? event?.content ?? event?.details;
}

function inferToolResultStatus(event: any): { ok: boolean; progress: boolean | undefined } {
	const payload = inferResultPayload(event);
	const payloadText = extractText(payload);
	const explicitOk =
		typeof event?.ok === "boolean"
			? event.ok
			: typeof event?.success === "boolean"
				? event.success
				: typeof event?.isError === "boolean"
					? !event.isError
					: undefined;
	const exitCode = typeof event?.exit_code === "number" ? event.exit_code : typeof event?.exitCode === "number" ? event.exitCode : undefined;
	const explicitProgress = typeof event?.progress === "boolean" ? event.progress : undefined;
	const textualError = typeof payloadText === "string" && /"ok"\s*:\s*false|\bmissing_cwd\b|\binvalid_arguments\b|\berror\b|DO THIS FIRST/i.test(payloadText);

	let ok: boolean;
	if (explicitOk !== undefined) {
		ok = explicitOk;
	} else if (typeof exitCode === "number") {
		ok = exitCode === 0;
	} else if (
		(payload && typeof payload === "object" && ((payload as Record<string, unknown>).error != null || (payload as Record<string, unknown>).errors != null)) ||
		textualError
	) {
		ok = false;
	} else {
		ok = true;
	}

	const progress = explicitProgress !== undefined ? explicitProgress : ok ? true : false;
	return { ok, progress };
}

function normalizeToolCallEvent(event: any): LoopEvent | null {
	const toolName = typeof event?.toolName === "string" ? event.toolName : typeof event?.name === "string" ? event.name : "";
	if (!toolName) return null;
	return {
		type: "tool_call",
		toolName,
		args: getToolArgs(event),
		timestamp: typeof event?.timestamp === "string" ? event.timestamp : undefined,
		id: typeof event?.id === "string" ? event.id : undefined,
	};
}

function normalizeToolResultEvent(event: any): LoopEvent | null {
	const toolName = typeof event?.toolName === "string" ? event.toolName : typeof event?.name === "string" ? event.name : "";
	if (!toolName) return null;
	const status = inferToolResultStatus(event);
	return {
		type: "tool_result",
		toolName,
		args: getToolArgs(event),
		ok: status.ok,
		progress: status.progress,
		result: inferResultPayload(event),
		timestamp: typeof event?.timestamp === "string" ? event.timestamp : undefined,
		id: typeof event?.id === "string" ? event.id : undefined,
	};
}

function getLatestAssistantMessage(event: any): string {
	const messages = Array.isArray(event?.messages) ? event.messages : [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		const text = extractText(message?.content);
		if (text.trim()) return text.trim();
	}
	return "";
}

function getLatestAssistantEntry(event: any): any | null {
	const messages = Array.isArray(event?.messages) ? event.messages : [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role === "assistant") return message;
	}
	return null;
}

function collectJudgeSessionContext(ctx: any): {
	recentAssistantThinking: Array<{ timestamp?: string; thinking: string }>;
	recentAssistantText: Array<{ timestamp?: string; text: string }>;
	recentUserText: Array<{ timestamp?: string; text: string }>;
} {
	const branch = Array.isArray(ctx?.sessionManager?.getBranch?.()) ? ctx.sessionManager.getBranch() : [];
	const recentAssistantThinking: Array<{ timestamp?: string; thinking: string }> = [];
	const recentAssistantText: Array<{ timestamp?: string; text: string }> = [];
	const recentUserText: Array<{ timestamp?: string; text: string }> = [];

	for (let i = branch.length - 1; i >= 0; i -= 1) {
		const entry = branch[i];
		if (entry?.type !== "message" || !entry.message) continue;
		const message = entry.message;
		const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined;

		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (
					block?.type === "thinking" &&
					typeof block.thinking === "string" &&
					block.thinking.trim() &&
					recentAssistantThinking.length < MAX_JUDGE_REASONING_MESSAGES
				) {
					recentAssistantThinking.push({
						timestamp,
						thinking: truncateText(block.thinking.trim(), MAX_JUDGE_REASONING_CHARS),
					});
				}
				if (
					block?.type === "text" &&
					typeof block.text === "string" &&
					block.text.trim() &&
					recentAssistantText.length < MAX_JUDGE_TEXT_MESSAGES
				) {
					recentAssistantText.push({
						timestamp,
						text: truncateText(block.text.trim(), MAX_JUDGE_REASONING_CHARS),
					});
				}
			}
		}

		if (message.role === "user") {
			const text = extractText(message.content).trim();
			if (text && recentUserText.length < MAX_JUDGE_TEXT_MESSAGES) {
				recentUserText.push({
					timestamp,
					text: truncateText(text, MAX_JUDGE_REASONING_CHARS),
				});
			}
		}

		if (
			recentAssistantThinking.length >= MAX_JUDGE_REASONING_MESSAGES &&
			recentAssistantText.length >= MAX_JUDGE_TEXT_MESSAGES &&
			recentUserText.length >= MAX_JUDGE_TEXT_MESSAGES
		) {
			break;
		}
	}

	return {
		recentAssistantThinking: recentAssistantThinking.reverse(),
		recentAssistantText: recentAssistantText.reverse(),
		recentUserText: recentUserText.reverse(),
	};
}

function enrichJudgeEvidence(evidence: unknown, ctx: any): unknown {
	if (!ctx?.sessionManager) return evidence;
	const sessionContext = collectJudgeSessionContext(ctx);
	return {
		...(evidence && typeof evidence === "object" ? evidence : {}),
		sessionContext,
	};
}

function createJudgeBridge(pi: ExtensionAPI, getContext?: () => any): JudgeBridge {
	return async (evidence) => {
		const ctx = typeof getContext === "function" ? getContext() : null;
		const enrichedEvidence = enrichJudgeEvidence(evidence, ctx);
		return evaluateLoopWithSubagent(pi, enrichedEvidence, { timeoutMs: DEFAULT_JUDGE_TIMEOUT_MS });
	};
}

async function deliverRecoveryPrompt(target: any, prompt: string): Promise<boolean> {
	if (target && typeof target.sendMessage === "function") {
		await target.sendMessage(
			{
				customType: "ralph-recovery",
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

async function analyzeRecovery(pi: ExtensionAPI, state: RuntimeState, ctx: any, outcome: NonNullable<LoopOutcome>): Promise<RecoveryAnalysis | null> {
	try {
		const analysis = await evaluateRecoverySummaryWithSubagent(
			pi,
			enrichJudgeEvidence(outcome, ctx),
			{ timeoutMs: DEFAULT_JUDGE_TIMEOUT_MS },
		);
		state.lastRecoveryAnalysis = analysis;
		return analysis;
	} catch (error) {
		state.lastRecoveryAnalysis = null;
		if (ctx.hasUI) {
			const detail = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Ralph recovery analysis unavailable; using fallback handoff. ${detail}`, "warning");
		}
		return null;
	}
}

async function dispatchFreshRecoveryPrompt(ctx: any, pi: ExtensionAPI, prompt: string): Promise<boolean> {
	if (typeof ctx?.newSession === "function") {
		try {
			const parentSession = ctx.sessionManager?.getSessionFile?.() ?? undefined;
			const result = await ctx.newSession({
				parentSession,
				withSession: async (replacementCtx: any) => {
					await deliverRecoveryPrompt(replacementCtx, prompt);
				},
			});
			if (!result?.cancelled) {
				return true;
			}
		} catch {
			// Fall through to the supported follow-up path.
		}
	}

	if (await deliverRecoveryPrompt(ctx, prompt)) {
		return true;
	}

	if (await deliverRecoveryPrompt(pi, prompt)) {
		return true;
	}

	return false;
}

async function buildRecoveryContext(state: RuntimeState, outcome: NonNullable<LoopOutcome>, ctx: any, pi: ExtensionAPI): Promise<{ prompt: string }> {
	const analysis = await analyzeRecovery(pi, state, ctx, outcome);
	const prompt = buildRecoveryPrompt(outcome, {
		title: `Ralph recovery after ${outcome?.trigger?.kind ?? "loop"}`,
		analysis: analysis ?? undefined,
	});
	state.lastRecoveryPrompt = prompt;
	state.lastRecoveryAgents = [];
	state.lastRecoveryAnalysis = analysis;
	return { prompt };
}

function summarizeCompactionMessages(messages: any[], maxMessages = 6): Array<{ role: string; text: string }> {
	if (!Array.isArray(messages) || messages.length === 0) return [];
	const summarized = [];
	for (let i = Math.max(0, messages.length - maxMessages); i < messages.length; i += 1) {
		const message = messages[i];
		const role = typeof message?.role === "string" ? message.role : "unknown";
		const text = truncateText(extractText(message?.content).trim(), 1200);
		if (!text) continue;
		summarized.push({ role, text });
	}
	return summarized;
}

function summarizeLoopTasks(loop: any, maxTasks = 8): Array<{ id: string; title: string; status: string; details: string; evidence: string[]; notes: string[] }> {
	if (!Array.isArray(loop?.tasks)) return [];
	return loop.tasks.slice(0, maxTasks).map((task: any) => ({
		id: String(task?.id ?? ""),
		title: truncateText(String(task?.title ?? "").trim(), 220),
		status: String(task?.status ?? "unknown"),
		details: truncateText(String(task?.details ?? "").trim(), 420),
		evidence: Array.isArray(task?.evidence)
			? task.evidence.slice(-2).map((item: unknown) => truncateText(String(item ?? "").trim(), 320)).filter(Boolean)
			: [],
		notes: Array.isArray(task?.notes)
			? task.notes.slice(-2).map((item: unknown) => truncateText(String(item ?? "").trim(), 320)).filter(Boolean)
			: [],
	}));
}

function summarizeTaskCounts(loop: any): { todo: number; in_progress: number; blocked: number; done: number; cancelled: number } {
	const counts = { todo: 0, in_progress: 0, blocked: 0, done: 0, cancelled: 0 };
	if (!Array.isArray(loop?.tasks)) return counts;
	for (const task of loop.tasks) {
		const status = typeof task?.status === "string" ? task.status : "";
		if (Object.prototype.hasOwnProperty.call(counts, status)) {
			counts[status as keyof typeof counts] += 1;
		}
	}
	return counts;
}

function summarizeTaskMetadata(task: any): null | {
	contract: null | {
		purpose: string | null;
		requiredCodeChanges: string[];
		verificationTarget: string[];
	};
	graphifyPlan: null | {
		likelyPaths: string[];
		likelySymbols: string[];
		likelySubsystems: string[];
		queries: Array<{ question: string; expected: string | null }>;
	};
	graphifyContext: null | {
		status: string;
		error: string | null;
		summary: {
			likelyFiles: string[];
			likelySymbols: string[];
			likelyCallSites: string[];
			relatedArtifacts: string[];
			queryNotes: string[];
		};
	};
} {
	const metadata = task?.metadata && typeof task.metadata === "object" ? task.metadata : null;
	if (!metadata) return null;
	const contract = metadata.contract && typeof metadata.contract === "object"
		? {
			purpose: typeof metadata.contract.purpose === "string" && metadata.contract.purpose.trim()
				? truncateText(metadata.contract.purpose.trim(), 260)
				: null,
			requiredCodeChanges: Array.isArray(metadata.contract.requiredCodeChanges)
				? metadata.contract.requiredCodeChanges.map((item: unknown) => truncateText(String(item ?? "").trim(), 160)).filter(Boolean).slice(0, 5)
				: [],
			verificationTarget: Array.isArray(metadata.contract.verificationTarget)
				? metadata.contract.verificationTarget.map((item: unknown) => truncateText(String(item ?? "").trim(), 180)).filter(Boolean).slice(0, 5)
				: [],
		}
		: null;
	const graphifyPlan = metadata.graphifyPlan && typeof metadata.graphifyPlan === "object"
		? {
			likelyPaths: Array.isArray(metadata.graphifyPlan.likelyPaths)
				? metadata.graphifyPlan.likelyPaths.map((item: unknown) => truncateText(String(item ?? "").trim(), 160)).filter(Boolean).slice(0, 6)
				: [],
			likelySymbols: Array.isArray(metadata.graphifyPlan.likelySymbols)
				? metadata.graphifyPlan.likelySymbols.map((item: unknown) => truncateText(String(item ?? "").trim(), 160)).filter(Boolean).slice(0, 6)
				: [],
			likelySubsystems: Array.isArray(metadata.graphifyPlan.likelySubsystems)
				? metadata.graphifyPlan.likelySubsystems.map((item: unknown) => truncateText(String(item ?? "").trim(), 160)).filter(Boolean).slice(0, 6)
				: [],
			queries: Array.isArray(metadata.graphifyPlan.queries)
				? metadata.graphifyPlan.queries.map((query: any) => ({
					question: truncateText(String(query?.question ?? "").trim(), 220),
					expected: typeof query?.expected === "string" && query.expected.trim() ? truncateText(query.expected.trim(), 180) : null,
				})).filter((query: any) => query.question).slice(0, 4)
				: [],
		}
		: null;
	const contextSummary = metadata.graphifyContext?.summary && typeof metadata.graphifyContext.summary === "object"
		? metadata.graphifyContext.summary
		: {};
	const graphifyContext = metadata.graphifyContext && typeof metadata.graphifyContext === "object"
		? {
			status: typeof metadata.graphifyContext.status === "string" ? metadata.graphifyContext.status : "unknown",
			error: typeof metadata.graphifyContext.error === "string" && metadata.graphifyContext.error.trim()
				? truncateText(metadata.graphifyContext.error.trim(), 220)
				: null,
			summary: {
				likelyFiles: Array.isArray(contextSummary.likelyFiles)
					? contextSummary.likelyFiles.map((item: unknown) => truncateText(String(item ?? "").trim(), 180)).filter(Boolean).slice(0, 6)
					: [],
				likelySymbols: Array.isArray(contextSummary.likelySymbols)
					? contextSummary.likelySymbols.map((item: unknown) => truncateText(String(item ?? "").trim(), 180)).filter(Boolean).slice(0, 6)
					: [],
				likelyCallSites: Array.isArray(contextSummary.likelyCallSites)
					? contextSummary.likelyCallSites.map((item: unknown) => truncateText(String(item ?? "").trim(), 180)).filter(Boolean).slice(0, 6)
					: [],
				relatedArtifacts: Array.isArray(contextSummary.relatedArtifacts)
					? contextSummary.relatedArtifacts.map((item: unknown) => truncateText(String(item ?? "").trim(), 180)).filter(Boolean).slice(0, 6)
					: [],
				queryNotes: Array.isArray(contextSummary.queryNotes)
					? contextSummary.queryNotes.map((item: unknown) => truncateText(String(item ?? "").trim(), 220)).filter(Boolean).slice(0, 6)
					: [],
			},
		}
		: null;
	if (!contract && !graphifyPlan && !graphifyContext) return null;
	return { contract, graphifyPlan, graphifyContext };
}

function summarizeTaskForHandoff(task: any): null | {
	id: string;
	title: string;
	status: string;
	details: string;
	evidence: string[];
	notes: string[];
	metadata: ReturnType<typeof summarizeTaskMetadata>;
} {
	if (!task || typeof task !== "object") return null;
	return {
		id: String(task?.id ?? ""),
		title: truncateText(String(task?.title ?? "").trim(), 220),
		status: String(task?.status ?? "unknown"),
		details: truncateText(String(task?.details ?? "").trim(), 420),
		evidence: Array.isArray(task?.evidence)
			? task.evidence.slice(-4).map((item: unknown) => truncateText(String(item ?? "").trim(), 360)).filter(Boolean)
			: [],
		notes: Array.isArray(task?.notes)
			? task.notes.slice(-4).map((item: unknown) => truncateText(String(item ?? "").trim(), 360)).filter(Boolean)
			: [],
		metadata: summarizeTaskMetadata(task),
	};
}

function selectCompactionActiveTask(loop: any): any | null {
	if (!Array.isArray(loop?.tasks)) return null;
	return loop.tasks.find((task: any) => task && task.status !== "done" && task.status !== "blocked" && task.status !== "cancelled") ?? loop.tasks[0] ?? null;
}

function buildCompactionSummarizerInputFromSlice(loop: any, slice: {
	customInstructions?: string | null;
	tokensBefore?: number | null;
	previousSummary?: string | null;
	recentMessages?: any[];
	turnPrefixMessages?: any[];
}): unknown {
	const activeTask = selectCompactionActiveTask(loop);
	const taskCounts = summarizeTaskCounts(loop);
	const openTasks = Array.isArray(loop?.tasks)
		? loop.tasks.filter((task: any) => task && task.status !== "done" && task.status !== "cancelled").slice(0, 10).map((task: any) => summarizeTaskForHandoff(task))
		: [];
	const recentlyCompletedTasks = Array.isArray(loop?.tasks)
		? loop.tasks.filter((task: any) => task && task.status === "done").slice(-6).map((task: any) => summarizeTaskForHandoff(task))
		: [];
	return {
		task: "ralph_compaction_handoff_summary",
		version: 1,
		loop: {
			name: loop.name,
			status: loop.status,
			iteration: loop.iteration,
			maxIterations: loop.maxIterations,
			title: loop.title ?? loop.name,
			summary: truncateText(String(loop.summary ?? "").trim(), 1200),
			goals: Array.isArray(loop.goals) ? loop.goals.slice(0, 5) : [],
			taskCounts,
			currentTask: summarizeTaskForHandoff(activeTask),
			tasks: summarizeLoopTasks(loop, 8),
			openTasks,
			recentlyCompletedTasks,
			recentNotes: Array.isArray(loop.notes)
				? loop.notes.slice(-5).map((item: any) => ({
					at: item?.at,
					text: truncateText(String(item?.text ?? "").trim(), 360),
				}))
				: [],
			recentReflections: Array.isArray(loop.reflections)
				? loop.reflections.slice(-3).map((item: any) => ({
					at: item?.at,
					iteration: item?.iteration ?? null,
					text: truncateText(String(item?.text ?? "").trim(), 420),
				}))
				: [],
			recentVerification: Array.isArray(loop.verification)
				? loop.verification.slice(-10).map((item: any) => ({
					at: item?.at,
					text: truncateText(String(item?.text ?? "").trim(), 320),
				}))
				: [],
		},
		slice: {
			customInstructions:
				typeof slice?.customInstructions === "string" && slice.customInstructions.trim()
					? truncateText(slice.customInstructions.trim(), 800)
					: null,
			tokensBefore: slice?.tokensBefore ?? null,
			previousSummary:
				typeof slice?.previousSummary === "string" && slice.previousSummary.trim()
					? truncateText(slice.previousSummary.trim(), 2500)
					: null,
			recentMessages: summarizeCompactionMessages(slice?.recentMessages ?? [], 16),
			turnPrefixMessages: summarizeCompactionMessages(slice?.turnPrefixMessages ?? [], 10),
		},
	};
}

function buildCompactionSummarizerInput(event: any, loop: any): unknown {
	const preparation = event?.preparation ?? {};
	return buildCompactionSummarizerInputFromSlice(loop, {
		customInstructions: typeof event?.customInstructions === "string" ? event.customInstructions : null,
		tokensBefore: preparation?.tokensBefore ?? null,
		previousSummary: typeof preparation?.previousSummary === "string" ? preparation.previousSummary : null,
		recentMessages: preparation?.messagesToSummarize ?? [],
		turnPrefixMessages: preparation?.turnPrefixMessages ?? [],
	});
}

function buildCompactionSummarizerInputFromContext(ctx: any, loop: any): unknown {
	const branch = Array.isArray(ctx?.sessionManager?.getBranch?.()) ? ctx.sessionManager.getBranch() : [];
	const messages = branch
		.filter((entry: any) => entry?.type === "message" && entry.message)
		.map((entry: any) => ({
			role: entry.message.role,
			content: entry.message.content,
		}));
	const usage = typeof ctx?.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
	return buildCompactionSummarizerInputFromSlice(loop, {
		customInstructions: null,
		tokensBefore: usage?.tokens ?? null,
		previousSummary: null,
		recentMessages: messages,
		turnPrefixMessages: [],
	});
}

function buildCompactionHandoffPrompt(loop: any, analysis: RecoveryAnalysis): string {
	const lines = [
		`Ralph compaction handoff for loop "${loop.name}" at iteration ${loop.iteration}${loop.maxIterations > 0 ? `/${loop.maxIterations}` : ""}.`,
		"",
		"Pi skipped compaction and created a fresh session for this Ralph loop.",
		"Do not assume the old transcript is available.",
		"Use Ralph canonical state as the source of truth and the summarized handoff below as supporting context.",
	];

	if (analysis.suspectedGoal?.trim()) {
		lines.push("", `Suspected goal: ${analysis.suspectedGoal.trim()}`);
	}
	if (analysis.summary?.trim()) {
		lines.push("", "## Handoff Summary", analysis.summary.trim());
	}
	if (analysis.rationale?.trim()) {
		lines.push("", "## Why Fresh Context Was Needed", analysis.rationale.trim());
	}
	if (Array.isArray(analysis.nextSteps) && analysis.nextSteps.length > 0) {
		lines.push("", "## Next Steps");
		for (const step of analysis.nextSteps) {
			lines.push(`- ${step}`);
		}
	}

	lines.push(
		"",
		"Start with the narrowest validating step.",
		"If compiler errors, Rust error codes, library API uncertainty, or framework-specific failures are blocking progress, use the web access tool to research the exact issue before guessing.",
		"Treat unresolved exact technical errors as a research or diagnosis problem first, not a review problem.",
		"If the issue looks sticky or needs comparison across multiple candidate fixes, delegate early: use researcher for sourced web investigation or oracle for a second-opinion diagnosis and best-next-move recommendation.",
		"Use reviewer to validate a proposed fix or sanity-check reasoning after you already have a likely path; do not use reviewer as the first stop for an unresolved exact error.",
		"Do not keep brute-forcing the same exact technical issue in the main session when delegation or research would be cheaper.",
		"Do not repeat the same failed action pattern.",
		"Update Ralph task state and evidence as you work.",
	);

	return lines.join("\n");
}

async function loadFreshRalphHandoffHelpers(): Promise<null | {
	getPendingRalphHandoff: typeof getPendingRalphHandoff;
	ensurePendingRalphHandoff: typeof ensurePendingRalphHandoff;
	markPendingRalphHandoffQueued: typeof markPendingRalphHandoffQueued;
	clearPendingRalphHandoff: typeof clearPendingRalphHandoff;
	updatePendingRalphHandoffPrompt: typeof updatePendingRalphHandoffPrompt;
	primeActiveTaskGraphifyContext: (ctx: any, loopName: string) => { loop: any; task: any; context: any } | null;
	dispatchPendingRalphHandoff: typeof dispatchPendingRalphHandoff;
}> {
	try {
		const moduleUrl = new URL(`./ralph-tools.js?ralph_handoff_helpers=${Date.now()}`, import.meta.url).href;
		const mod = await import(moduleUrl);
		if (
			typeof mod?.getPendingRalphHandoff !== "function" ||
			typeof mod?.ensurePendingRalphHandoff !== "function" ||
			typeof mod?.markPendingRalphHandoffQueued !== "function" ||
			typeof mod?.clearPendingRalphHandoff !== "function" ||
			typeof mod?.updatePendingRalphHandoffPrompt !== "function" ||
			typeof mod?.primeActiveTaskGraphifyContext !== "function" ||
			typeof mod?.dispatchPendingRalphHandoff !== "function"
		) {
			return null;
		}
		return {
			getPendingRalphHandoff: mod.getPendingRalphHandoff,
			ensurePendingRalphHandoff: mod.ensurePendingRalphHandoff,
			markPendingRalphHandoffQueued: mod.markPendingRalphHandoffQueued,
			clearPendingRalphHandoff: mod.clearPendingRalphHandoff,
			updatePendingRalphHandoffPrompt: mod.updatePendingRalphHandoffPrompt,
			primeActiveTaskGraphifyContext: mod.primeActiveTaskGraphifyContext,
			dispatchPendingRalphHandoff: mod.dispatchPendingRalphHandoff,
		};
	} catch {
		return null;
	}
}

async function prepareCompactionHandoff(state: RuntimeState, event: any, ctx: any, pi: ExtensionAPI): Promise<boolean> {
	const loop = getActiveRalphLoop(ctx);
	if (!loop || loop.status !== "active") {
		if (ctx.hasUI) {
			ctx.ui.notify("Ralph compaction handoff skipped: no active Ralph loop.", "warning");
		}
		return false;
	}
	debugLog(`[ralph] compaction handoff prepare start loop=${loop.name} iteration=${loop.iteration}`);

	const handoffHelpers = await loadFreshRalphHandoffHelpers();
	if (!handoffHelpers) {
		if (ctx.hasUI) {
			ctx.ui.notify("Ralph compaction handoff helpers are unavailable in the current extension runtime; allowing normal compaction.", "warning");
		}
		return false;
	}

	handoffHelpers.primeActiveTaskGraphifyContext(ctx, loop.name);

	const pending = handoffHelpers.getPendingRalphHandoff(ctx, loop.name);
	if (pending?.commandQueued) {
		debugLog(`[ralph] compaction handoff prepare already-queued loop=${loop.name} generation=${pending.generation}`);
		if (ctx.hasUI) {
			ctx.ui.notify(`Ralph compaction handoff already queued for ${loop.name}; allowing normal compaction.`, "warning");
		}
		return false;
	}

	const summarizerInput = buildCompactionSummarizerInput(event, loop);
	const summarizerInputSize = JSON.stringify(summarizerInput).length;
	debugLog(`[ralph] compaction handoff summarizer input chars=${summarizerInputSize} loop=${loop.name} iteration=${loop.iteration}`);
	if (ctx.hasUI) {
		ctx.ui.notify(`Ralph compaction handoff preparing summary for ${loop.name} (${summarizerInputSize} chars).`, "warning");
	}

	let analysis: RecoveryAnalysis | null = null;
	try {
		analysis = await evaluateRecoverySummaryWithSubagent(pi, summarizerInput, { timeoutMs: DEFAULT_JUDGE_TIMEOUT_MS });
		debugLog(
			`[ralph] compaction handoff summary ready loop=${loop.name} iteration=${loop.iteration} summaryChars=${analysis?.summary?.length ?? 0}`,
		);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		debugLog(`[ralph] compaction handoff summary failed loop=${loop.name} error=${JSON.stringify(detail)}`);
		if (ctx.hasUI) {
			ctx.ui.notify(`Ralph compaction handoff unavailable; allowing normal compaction. ${detail}`, "warning");
		}
		return false;
	}

	const handoffPrompt =
		analysis?.summary?.trim()
			? buildCompactionHandoffPrompt(loop, analysis)
			: [
				`Ralph compaction handoff for loop "${loop.name}" at iteration ${loop.iteration}.`,
				"",
				"Pi compacted the old transcript. Continue from Ralph canonical state plus this stored handoff.",
				"Use Ralph canonical state as the source of truth.",
				"Take the narrowest validating next step and avoid repeating the same failed action.",
			].join("\n");

	const handoff = handoffHelpers.ensurePendingRalphHandoff(ctx, loop.name, handoffPrompt, "compaction");
	if (!handoff) {
		if (ctx.hasUI) {
			ctx.ui.notify("Ralph compaction handoff could not persist pending state; allowing normal compaction.", "warning");
		}
		return false;
	}
	debugLog(
		`[ralph] compaction handoff persisted loop=${handoff.loop.name} generation=${handoff.generation} promptChars=${handoffPrompt.length}`,
	);
	if (ctx.hasUI) {
		ctx.ui.notify(`Ralph compaction handoff stored for ${handoff.loop.name}; it will dispatch after compaction completes.`, "warning");
	}
	return false;
}

async function maybeQueueDeferredCompactionHandoff(ctx: any, pi: ExtensionAPI, trigger: string): Promise<void> {
	const pending = getPendingRalphHandoff(ctx);
	if (!pending) {
		debugLog(`[ralph] compaction handoff deferred-queue skipped trigger=${trigger} reason=no_pending_handoff`);
		return;
	}
	const loop = pending.loop;
	if (pending.commandQueued) {
		debugLog(
			`[ralph] compaction handoff deferred-queue skipped loop=${loop.name} generation=${pending.generation} trigger=${trigger} reason=already_queued`,
		);
		return;
	}
	if (typeof ctx?.hasPendingMessages === "function" && ctx.hasPendingMessages()) {
		debugLog(
			`[ralph] compaction handoff deferred-queue skipped loop=${loop.name} generation=${pending.generation} trigger=${trigger} reason=pending_messages`,
		);
		return;
	}
	const handoffHelpers = await loadFreshRalphHandoffHelpers();
	if (!handoffHelpers) {
		debugLog(
			`[ralph] compaction handoff deferred-queue skipped loop=${loop.name} generation=${pending.generation} trigger=${trigger} reason=no_helpers`,
		);
		return;
	}
	if (typeof pi?.sendUserMessage !== "function") {
		debugLog(
			`[ralph] compaction handoff deferred-queue skipped loop=${loop.name} generation=${pending.generation} trigger=${trigger} reason=no_sendUserMessage`,
		);
		return;
	}
	debugLog(
		`[ralph] compaction handoff deferred-queue start loop=${loop.name} generation=${pending.generation} trigger=${trigger}`,
	);
	const prompt = COMPACTION_HANDOFF_TOOL_PROMPT(loop.name);
	try {
		await pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		handoffHelpers.markPendingRalphHandoffQueued(ctx, loop.name, true);
		debugLog(
			`[ralph] compaction handoff deferred-queue complete loop=${loop.name} generation=${pending.generation} trigger=${trigger}`,
		);
		if (ctx.hasUI) {
			ctx.ui.notify(`Ralph compaction handoff queued for ${loop.name}.`, "warning");
		}
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		debugLog(
			`[ralph] compaction handoff deferred-queue failed loop=${loop.name} generation=${pending.generation} trigger=${trigger} error=${JSON.stringify(detail)}`,
		);
		return;
	}
}

async function dispatchRecovery(state: RuntimeState, ctx: any, outcome: NonNullable<LoopOutcome>, pi: ExtensionAPI): Promise<void> {
	if (state.halted && state.pendingRecoveryOutcome == null) return;
	state.halted = true;
	state.pendingRecoveryOutcome = null;
	state.haltReason = outcome.review?.message || outcome.judgeOutcome?.reason || outcome.trigger?.kind || "loop detected";

	const { prompt } = await buildRecoveryContext(state, outcome, ctx, pi);
	const dispatched = await dispatchFreshRecoveryPrompt(ctx, pi, prompt);

	if (!dispatched && ctx.hasUI) {
		ctx.ui.notify("Ralph recovery prompt could not be dispatched automatically.", "warning");
	}

	// if (typeof ctx.abort === "function" && typeof ctx.isIdle === "function" && !ctx.isIdle()) {
	// 	ctx.abort();
	// }
}

function queueRecovery(state: RuntimeState, ctx: any, outcome: NonNullable<LoopOutcome>): void {
	if (state.halted) return;
	state.halted = true;
	state.pendingRecoveryOutcome = outcome;
	state.haltReason = outcome.review?.message || outcome.judgeOutcome?.reason || outcome.trigger?.kind || "loop detected";
	if (ctx.hasUI) {
		ctx.ui.notify("Ralph recovery queued; fresh context will start after the current turn settles.", "warning");
	}
}

async function flushPendingRecovery(state: RuntimeState, ctx: any, pi: ExtensionAPI): Promise<void> {
	if (!state.pendingRecoveryOutcome) return;
	if (typeof ctx?.isIdle === "function" && !ctx.isIdle()) return;
	const outcome = state.pendingRecoveryOutcome;
	await dispatchRecovery(state, ctx, outcome, pi);
}

async function haltWithoutRecovery(state: RuntimeState, ctx: any, outcome: NonNullable<LoopOutcome>): Promise<void> {
	if (state.halted) return;
	state.halted = true;
	state.haltReason = outcome.review?.message || outcome.judgeOutcome?.reason || outcome.trigger?.kind || "loop detected";

	if (ctx.hasUI) {
		ctx.ui.notify(`Ralph loop detector halted on ${outcome.trigger?.kind ?? "loop"}; reset required.`, "warning");
	}

	if (typeof ctx.abort === "function" && typeof ctx.isIdle === "function" && !ctx.isIdle()) {
		ctx.abort();
	}
}

async function handleJudgeOutcome(state: RuntimeState, ctx: any, pi: ExtensionAPI, outcome: NonNullable<LoopOutcome>): Promise<void> {
	const disposition = resolveJudgeDisposition(outcome, { confidenceThreshold: state.judgeConfidenceThreshold });
	if (ctx.hasUI) {
		const confidenceLabel = Number.isFinite(disposition.confidence) ? disposition.confidence.toFixed(2) : "0.00";
		const reason = disposition.reason?.trim() || "no reason provided";
		const trigger = outcome.trigger?.kind ?? "loop";
		const level = disposition.action === "continue" ? "info" : "warning";
		ctx.ui.notify(`Ralph judge: ${disposition.action} on ${trigger} (confidence ${confidenceLabel}). ${reason}`, level);
	}
	if (disposition.action === "continue") return;
	if (disposition.action === "steer") {
		if (typeof ctx?.isIdle === "function" && !ctx.isIdle()) {
			queueRecovery(state, ctx, outcome);
			return;
		}
		await dispatchRecovery(state, ctx, outcome, pi);
		return;
	}
	await haltWithoutRecovery(state, ctx, outcome);
}

	export default function ralphLoopDetectorExtension(pi: ExtensionAPI) {
		let runtime = createRuntimeState(safeLoadProjectConfig(null), createJudgeBridge(pi, () => runtime.hostContext));

		function syncActiveLoop(ctx: any): string | null {
			const activeLoop = safeGetActiveRalphLoop(ctx);
			const activeLoopName = typeof activeLoop?.name === "string" ? activeLoop.name : null;
			if (!activeLoopName) {
				if (runtime.activeLoopName !== null || runtime.events.length > 0 || runtime.halted || runtime.lastOutcome) {
					runtime = createRuntimeState(safeLoadProjectConfig(ctx), createJudgeBridge(pi, () => runtime.hostContext));
					runtime.hostContext = ctx;
			}
			runtime.activeLoopName = null;
			return null;
		}

		if (runtime.activeLoopName !== activeLoopName) {
			runtime = createRuntimeState(safeLoadProjectConfig(ctx), createJudgeBridge(pi, () => runtime.hostContext));
			runtime.hostContext = ctx;
			runtime.activeLoopName = activeLoopName;
			return activeLoopName;
		}

		runtime.hostContext = ctx;
		runtime.activeLoopName = activeLoopName;
		return activeLoopName;
	}

	async function handleRuntimeEvent(event: LoopEvent, ctx: any): Promise<void> {
		if (!runtime.enabled) return;
		if (!syncActiveLoop(ctx)) return;
		recordRuntimeEvent(runtime, event);
		if (runtime.halted) return;
		const outcome = await runtime.detector.handleEvent(event);
		runtime.lastOutcome = outcome;
		if (outcome) {
			await handleJudgeOutcome(runtime, ctx, pi, outcome);
		}
		flushDebugLogs(runtime, ctx);
	}

	function resetRuntime(ctx: any): void {
		const activeLoop = safeGetActiveRalphLoop(ctx);
		const wasEnabled = runtime.enabled;
		runtime = createRuntimeState(safeLoadProjectConfig(ctx), createJudgeBridge(pi, () => runtime.hostContext));
		runtime.hostContext = ctx;
		runtime.activeLoopName = typeof activeLoop?.name === "string" ? activeLoop.name : null;
		runtime.enabled = wasEnabled;
		if (ctx.hasUI) ctx.ui.notify("Ralph loop detector runtime state reset.", "info");
	}

	function registerStatusCommand(commandName: string): void {
		pi.registerCommand(commandName, {
			description: "Inspect or control the Ralph loop detector",
			handler: async (args, ctx) => {
				const [command] = args.trim().split(/\s+/);

					if (command === "reset") {
						resetRuntime(ctx);
						return;
					}

					if (command === "on") {
						runtime.enabled = true;
						if (ctx.hasUI) ctx.ui.notify("Ralph loop detector enabled.", "info");
						return;
					}

					if (command === "off") {
						runtime.enabled = false;
						if (ctx.hasUI) ctx.ui.notify("Ralph loop detector disabled.", "info");
						return;
					}

				if (command === "debug") {
					const [, mode] = args.trim().split(/\s+/);
					if (mode === "on") {
						runtime.debugEnabled = true;
						if (ctx.hasUI) ctx.ui.notify("Loop detector debug enabled.", "info");
						flushDebugLogs(runtime, ctx);
						return;
					}
					if (mode === "off") {
						runtime.debugEnabled = false;
						if (ctx.hasUI) ctx.ui.notify("Loop detector debug disabled.", "info");
						return;
					}
					if (mode === "dump") {
						const entries = runtime.debugEvents.slice(-10).map((entry) => formatDebugEntry(entry));
						if (ctx.hasUI) {
							ctx.ui.notify(entries.length > 0 ? `Loop detector debug\n${entries.join("\n")}` : "Loop detector debug buffer is empty.", "info");
						}
						return;
					}
					if (ctx.hasUI) {
						ctx.ui.notify(
							[
								"Ralph Loop Detector",
								`  /${commandName} debug on    Enable debug tracing`,
								`  /${commandName} debug off   Disable debug tracing`,
								`  /${commandName} debug dump  Show recent debug lines`,
							].join("\n"),
							"info",
						);
					}
					return;
				}

					if (command === "status") {
						const summary = runtime.lastOutcome ? summarizeOutcome(runtime.lastOutcome) : "No loop detected in this session.";
						const enabled = `Enabled: ${runtime.enabled ? "yes" : "no"}`;
						const halted = runtime.halted ? `Halted: yes (${runtime.haltReason ?? "unknown"})` : "Halted: no";
						const recovery = runtime.lastRecoveryPrompt ? "Last recovery prompt: present" : "Last recovery prompt: none";
						const debug = `Debug: ${runtime.debugEnabled ? "on" : "off"} (${runtime.debugEvents.length} buffered)`;
						if (ctx.hasUI) {
							ctx.ui.notify(`${summary}\n${enabled}\n${halted}\n${recovery}\n${debug}\nCaptured events: ${runtime.events.length}`, "info");
						}
					return;
				}

				if (ctx.hasUI) {
					ctx.ui.notify(
						[
							"Ralph Loop Detector",
							`  /${commandName} status   Show runtime detector state`,
							`  /${commandName} on       Enable the detector`,
							`  /${commandName} off      Disable the detector`,
							`  /${commandName} reset    Clear captured detector state`,
						].join("\n"),
						"info",
					);
				}
			},
		});
	}

	registerStatusCommand("ralph-loop");
	registerStatusCommand("loop-detector");

	pi.registerTool({
		name: "detect_loop",
		label: "Detect Ralph Loop",
		description: "Analyze recent assistant and tool events for suspicious Ralph loop behavior.",
		promptSnippet: "Check whether the agent is stuck repeating the same wrong action pattern.",
		promptGuidelines: [
			"Use this when recent turns suggest repeated nonproductive behavior rather than normal multi-step work.",
			"Pass events in chronological order and include assistant text plus tool calls and tool results when available.",
			"Prefer the fixed recovery order scout -> researcher -> oracle -> reviewer when the result indicates a loop.",
		],
		parameters: Type.Object({
			events: Type.Optional(
				Type.Array(
					Type.Object(
						{},
						{
							additionalProperties: true,
							description: "Chronological event objects with type assistant_message, tool_call, or tool_result.",
						},
					),
					{ description: "Recent runtime events in chronological order." },
				),
			),
			config: Type.Optional(
				Type.Object({}, { additionalProperties: true, description: "Optional detector threshold overrides." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const inputEvents = Array.isArray(params.events) && params.events.length > 0 ? (params.events as LoopEvent[]) : runtime.events;
			const debugTrace: Array<{ at: string; stage: string; payload: unknown }> = [];
			const detector = new LoopDetector({
				...RALPH_DETECTOR_CONFIG,
				...(params.config ?? {}),
				debug: Boolean(params.config?.debug)
					? (entry: { stage: string; payload: unknown }) => {
						debugTrace.push({
							at: new Date().toISOString(),
							stage: entry.stage,
							payload: entry.payload,
						});
					}
					: undefined,
			});
			let outcome: LoopOutcome = null;

			for (const rawEvent of inputEvents) {
				outcome = await detector.handleEvent(rawEvent);
			}

			const state = detector.getState();
			const text = summarizeOutcome(outcome);

			return {
				content: [{ type: "text", text }],
				details: {
					outcome,
					state,
					debugTrace: debugTrace.length > 0 ? debugTrace : undefined,
						recovery: outcome && outcome.review?.action !== "continue" ? {
							prompt: buildRecoveryPrompt(outcome),
						} : undefined,
					runtimeSummary:
						inputEvents === runtime.events
							? {
								capturedEvents: runtime.events.length,
								halted: runtime.halted,
								haltReason: runtime.haltReason,
								lastResetAt: runtime.lastResetAt,
							}
							: undefined,
				},
			};
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const reason = typeof (_event as any)?.reason === "string" ? (_event as any).reason : undefined;
		const previousSessionFile =
			typeof (_event as any)?.previousSessionFile === "string" ? (_event as any).previousSessionFile : undefined;
		const activeLoop = safeGetActiveRalphLoop(ctx);
		const wasEnabled = runtime.enabled;
		runtime = createRuntimeState(safeLoadProjectConfig(ctx), createJudgeBridge(pi, () => runtime.hostContext));
		runtime.hostContext = ctx;
		runtime.activeLoopName = typeof activeLoop?.name === "string" ? activeLoop.name : null;
		runtime.enabled = wasEnabled;
		debugLog(
			`[ralph] session_start reason=${reason ?? "unknown"} previousSessionFile=${JSON.stringify(previousSessionFile ?? null)} activeLoop=${JSON.stringify(runtime.activeLoopName)}`,
		);
		if (ctx.hasUI) {
			ctx.ui.notify("Ralph loop detector loaded for this session.", "info");
		}
	});

	pi.on("session_before_compact", async (event, ctx) => {
		runtime.hostContext = ctx;
		if (!syncActiveLoop(ctx)) return;
		const prepared = await prepareCompactionHandoff(runtime, event, ctx, pi);
		if (prepared) {
			return { cancel: true };
		}
	});

	pi.on("session_compact", async (_event, ctx) => {
		runtime.hostContext = ctx;
		debugLog("[ralph] compaction handoff observed session_compact");
		await maybeQueueDeferredCompactionHandoff(ctx, pi, "session_compact");
	});

	pi.on("session_shutdown", async () => {
		runtime = createRuntimeState();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		runtime.hostContext = ctx;
		const prompt = typeof event?.prompt === "string" ? event.prompt : "";
		if (!isCompactionHandoffToolPrompt(prompt)) {
			runtime.handoffToolTurnActive = false;
			runtime.handoffToolTurnLoopName = null;
			runtime.handoffToolTurnPromptChars = 0;
			runtime.handoffToolTurnSeenAt = null;
			runtime.handoffToolTurnProviderResponded = false;
			runtime.handoffToolTurnToolCalled = false;
			return;
		}
		runtime.handoffToolTurnActive = true;
		runtime.handoffToolTurnLoopName = parseCompactionHandoffLoopName(prompt);
		runtime.handoffToolTurnPromptChars = prompt.length;
		runtime.handoffToolTurnSeenAt = new Date().toISOString();
		runtime.handoffToolTurnProviderResponded = false;
		runtime.handoffToolTurnToolCalled = false;
		debugLog(
			`[ralph] handoff-turn before_agent_start loop=${runtime.handoffToolTurnLoopName ?? "unknown"} promptChars=${runtime.handoffToolTurnPromptChars}`,
		);
	});

	pi.on("agent_start", async (_event, ctx) => {
		runtime.hostContext = ctx;
		if (!runtime.handoffToolTurnActive) return;
		const usage = typeof ctx?.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
		debugLog(
			`[ralph] handoff-turn agent_start loop=${runtime.handoffToolTurnLoopName ?? "unknown"} seenAt=${runtime.handoffToolTurnSeenAt ?? "unknown"} usageTokens=${usage?.tokens ?? "unknown"} usagePercent=${usage?.percent ?? "unknown"} contextWindow=${usage?.contextWindow ?? "unknown"}`,
		);
	});

	pi.on("before_provider_request", async (event, ctx) => {
		runtime.hostContext = ctx;
		if (!runtime.handoffToolTurnActive) return;
		const payload = (event as any)?.payload;
		const payloadText = payload == null ? "" : JSON.stringify(payload);
		const payloadChars = payloadText.length;
		const messageCount = Array.isArray(payload?.messages) ? payload.messages.length : 0;
		const systemChars =
			typeof payload?.system === "string"
				? payload.system.length
				: Array.isArray(payload?.system)
					? JSON.stringify(payload.system).length
					: 0;
		debugLog(
			`[ralph] handoff-turn before_provider_request loop=${runtime.handoffToolTurnLoopName ?? "unknown"} payloadChars=${payloadChars} messageCount=${messageCount} systemChars=${systemChars}`,
		);
	});

	pi.on("after_provider_response", async (event, ctx) => {
		runtime.hostContext = ctx;
		if (!runtime.handoffToolTurnActive) return;
		runtime.handoffToolTurnProviderResponded = true;
		debugLog(
			`[ralph] handoff-turn provider_response loop=${runtime.handoffToolTurnLoopName ?? "unknown"} status=${event?.status ?? "unknown"}`,
		);
	});

	pi.on("input", async (event, ctx) => {
		const text = extractText(event);
		const source = typeof (event as any)?.source === "string" ? (event as any).source : "";
		if (source === "extension" && isCompactionHandoffToolPrompt(text)) {
			const loopName = parseCompactionHandoffLoopName(text);
			debugLog(`[ralph] handoff-input intercepted loop=${loopName ?? "unknown"} source=${source}`);
			const pending = getPendingRalphHandoff(ctx, loopName ?? undefined);
			if (!pending) {
				debugLog(`[ralph] handoff-input no-pending loop=${loopName ?? "unknown"}`);
				if (ctx.hasUI) {
					ctx.ui.notify(loopName ? `No pending Ralph handoff for ${loopName}.` : "No pending Ralph handoff.", "warning");
				}
				return { action: "handled" as const };
			}
			const result = await dispatchPendingRalphHandoff(pi, ctx, pending.loop.name);
			debugLog(
				`[ralph] handoff-input dispatched loop=${pending.loop.name} ok=${String(result.dispatched)} reason=${result.dispatched ? "ok" : result.reason}`,
			);
			if (!result.dispatched && ctx.hasUI) {
				ctx.ui.notify(`Ralph handoff did not dispatch (${result.reason}).`, "warning");
			}
			return { action: "handled" as const };
		}
		recordInput(runtime, text);
		return { action: "continue" as const };
	});

	pi.on("tool_call", async (event, ctx) => {
		const normalized = normalizeToolCallEvent(event);
		if (!normalized) return;
		if (normalized.toolName === "ralph_handoff") {
			runtime.handoffToolTurnToolCalled = true;
			debugLog(
				`[ralph] handoff-turn tool_call loop=${runtime.handoffToolTurnLoopName ?? "unknown"} tool=${normalized.toolName}`,
			);
		}
		await handleRuntimeEvent(normalized, ctx);
		await flushPendingRecovery(runtime, ctx, pi);
	});

	pi.on("tool_result", async (event, ctx) => {
		const normalized = normalizeToolResultEvent(event);
		if (!normalized) return;
		if (normalized.toolName === "ralph_handoff") {
			debugLog(
				`[ralph] handoff-turn tool_result loop=${runtime.handoffToolTurnLoopName ?? "unknown"} tool=${normalized.toolName} ok=${normalized.ok}`,
			);
		}
		await handleRuntimeEvent(normalized, ctx);
		await flushPendingRecovery(runtime, ctx, pi);
	});

	pi.on("agent_end", async (event, ctx) => {
		const lastAssistant = getLatestAssistantEntry(event);
		const assistantText = lastAssistant ? extractText(lastAssistant.content).trim() : "";
		if (assistantText) {
			const timestamp = typeof (event as any)?.timestamp === "string" ? (event as any).timestamp : undefined;
			await handleRuntimeEvent(
				{
					type: "assistant_message",
					content: assistantText,
					timestamp,
				},
				ctx,
			);
		}
		await flushPendingRecovery(runtime, ctx, pi);
		if (!runtime.halted) {
			await maybeDispatchStoppedLoopSteering(ctx, pi, {
				stopReason: typeof lastAssistant?.stopReason === "string" ? lastAssistant.stopReason : "",
				assistantText,
			});
		}
		if (runtime.handoffToolTurnActive) {
			debugLog(
				`[ralph] handoff-turn agent_end loop=${runtime.handoffToolTurnLoopName ?? "unknown"} providerResponded=${runtime.handoffToolTurnProviderResponded} toolCalled=${runtime.handoffToolTurnToolCalled} stopReason=${typeof lastAssistant?.stopReason === "string" ? lastAssistant.stopReason : ""}`,
			);
			runtime.handoffToolTurnActive = false;
			runtime.handoffToolTurnLoopName = null;
			runtime.handoffToolTurnPromptChars = 0;
			runtime.handoffToolTurnSeenAt = null;
			runtime.handoffToolTurnProviderResponded = false;
			runtime.handoffToolTurnToolCalled = false;
		}
	});

	registerRalphSurface(pi);
}
