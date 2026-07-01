import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";

import { LoopDetector } from "./src/index.js";
import { evaluateLoopWithSubagent } from "./src/subagent-bridge.js";
import { buildRecoveryPrompt, summarizeRecovery } from "./routing.js";
import { getActiveRalphLoop, registerRalphSurface } from "./ralph-tools.js";

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
	debugEnabled: boolean;
	lastDebugFlushedIndex: number;
	hostContext: any | null;
	halted: boolean;
	haltReason: string | null;
	lastOutcome: LoopOutcome;
	lastRecoveryPrompt: string | null;
	lastRecoveryAgents: string[];
	judgeConfidenceThreshold: number;
	activeLoopName: string | null;
	lastResetAt: string;
}

const MAX_RUNTIME_EVENTS = 64;
const MAX_INPUT_HISTORY = 6;
const DEFAULT_JUDGE_TIMEOUT_MS = null;
const DEFAULT_JUDGE_CONFIDENCE_THRESHOLD = 0.7;
const MAX_INPUT_CHARS = 2000;
const MAX_DEBUG_EVENTS = 120;
const MAX_DEBUG_TEXT = 600;
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
		debugEnabled: Boolean(config.debug),
		lastDebugFlushedIndex: 0,
		hostContext: null,
		halted: false,
		haltReason: null,
		lastOutcome: null,
		lastRecoveryPrompt: null,
		lastRecoveryAgents: [],
		judgeConfidenceThreshold: normalizeJudgeConfidenceThreshold(config.judgeConfidenceThreshold) ?? DEFAULT_JUDGE_CONFIDENCE_THRESHOLD,
		activeLoopName: null,
		lastResetAt: new Date().toISOString(),
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

function createJudgeBridge(pi: ExtensionAPI): JudgeBridge {
	return async (evidence) => {
		return evaluateLoopWithSubagent(pi, evidence, { timeoutMs: DEFAULT_JUDGE_TIMEOUT_MS });
	};
}

async function deliverRecoveryPrompt(target: any, prompt: string): Promise<boolean> {
	if (target && typeof target.sendMessage === "function") {
		await target.sendMessage(
			{
				customType: "ralph-recovery",
				content: prompt,
				display: false,
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
		return true;
	}

	return false;
}

function buildRecoveryContext(state: RuntimeState, outcome: NonNullable<LoopOutcome>): { prompt: string } {
	const prompt = buildRecoveryPrompt(outcome, { title: `Ralph recovery after ${outcome?.trigger?.kind ?? "loop"}` });
	state.lastRecoveryPrompt = prompt;
	state.lastRecoveryAgents = [];
	return { prompt };
}

async function dispatchRecovery(state: RuntimeState, ctx: any, outcome: NonNullable<LoopOutcome>, pi: ExtensionAPI): Promise<void> {
	if (state.halted) return;
	state.halted = true;
	state.haltReason = outcome.review?.message || outcome.judgeOutcome?.reason || outcome.trigger?.kind || "loop detected";

	const { prompt } = buildRecoveryContext(state, outcome);
	let dispatched = false;
	if (typeof ctx.sendMessage === "function") {
		dispatched = await deliverRecoveryPrompt(ctx, prompt);
	} else if (typeof pi.sendMessage === "function") {
		dispatched = await deliverRecoveryPrompt(pi, prompt);
	}

	if (!dispatched && ctx.hasUI) {
		ctx.ui.notify("Ralph recovery prompt could not be dispatched automatically.", "warning");
	}

	// if (typeof ctx.abort === "function" && typeof ctx.isIdle === "function" && !ctx.isIdle()) {
	// 	ctx.abort();
	// }
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
		await dispatchRecovery(state, ctx, outcome, pi);
		return;
	}
	await haltWithoutRecovery(state, ctx, outcome);
}

export default function ralphLoopDetectorExtension(pi: ExtensionAPI) {
	let runtime = createRuntimeState(loadProjectConfig(null), createJudgeBridge(pi));

	function syncActiveLoop(ctx: any): string | null {
		const activeLoop = getActiveRalphLoop(ctx);
		const activeLoopName = typeof activeLoop?.name === "string" ? activeLoop.name : null;
		if (!activeLoopName) {
			if (runtime.activeLoopName !== null || runtime.events.length > 0 || runtime.halted || runtime.lastOutcome) {
				runtime = createRuntimeState(loadProjectConfig(ctx), createJudgeBridge(pi));
				runtime.hostContext = ctx;
			}
			runtime.activeLoopName = null;
			return null;
		}

		if (runtime.activeLoopName !== activeLoopName) {
			runtime = createRuntimeState(loadProjectConfig(ctx), createJudgeBridge(pi));
			runtime.hostContext = ctx;
			runtime.activeLoopName = activeLoopName;
			return activeLoopName;
		}

		runtime.hostContext = ctx;
		runtime.activeLoopName = activeLoopName;
		return activeLoopName;
	}

	async function handleRuntimeEvent(event: LoopEvent, ctx: any): Promise<void> {
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
		const activeLoop = getActiveRalphLoop(ctx);
		runtime = createRuntimeState(loadProjectConfig(ctx), createJudgeBridge(pi));
		runtime.hostContext = ctx;
		runtime.activeLoopName = typeof activeLoop?.name === "string" ? activeLoop.name : null;
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
						const halted = runtime.halted ? `Halted: yes (${runtime.haltReason ?? "unknown"})` : "Halted: no";
						const recovery = runtime.lastRecoveryPrompt ? "Last recovery prompt: present" : "Last recovery prompt: none";
						const debug = `Debug: ${runtime.debugEnabled ? "on" : "off"} (${runtime.debugEvents.length} buffered)`;
						if (ctx.hasUI) {
							ctx.ui.notify(`${summary}\n${halted}\n${recovery}\n${debug}\nCaptured events: ${runtime.events.length}`, "info");
						}
					return;
				}

				if (ctx.hasUI) {
					ctx.ui.notify(
						[
							"Ralph Loop Detector",
							`  /${commandName} status   Show runtime detector state`,
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
			"Prefer the fixed recovery order scout -> researcher -> reviewer when the result indicates a loop.",
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
		const activeLoop = getActiveRalphLoop(ctx);
		runtime = createRuntimeState(loadProjectConfig(ctx), createJudgeBridge(pi));
		runtime.hostContext = ctx;
		runtime.activeLoopName = typeof activeLoop?.name === "string" ? activeLoop.name : null;
		if (ctx.hasUI) {
			ctx.ui.notify("Ralph loop detector loaded for this session.", "info");
		}
	});

	pi.on("session_shutdown", async () => {
		runtime = createRuntimeState();
	});

	pi.on("input", async (event) => {
		const text = extractText(event);
		recordInput(runtime, text);
	});

	pi.on("tool_call", async (event, ctx) => {
		const normalized = normalizeToolCallEvent(event);
		if (!normalized) return;
		await handleRuntimeEvent(normalized, ctx);
	});

	pi.on("tool_result", async (event, ctx) => {
		const normalized = normalizeToolResultEvent(event);
		if (!normalized) return;
		await handleRuntimeEvent(normalized, ctx);
	});

	pi.on("agent_end", async (event, ctx) => {
		const assistantText = getLatestAssistantMessage(event);
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
	});

	registerRalphSurface(pi);
}
