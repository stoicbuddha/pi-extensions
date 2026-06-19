import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { LoopDetector } from "./src/index.js";

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
type RecoveryMode = "steer" | "newSession";

interface RuntimeState {
	detector: LoopDetector;
	events: LoopEvent[];
	inputHistory: string[];
	lastAssistantDigest: string | null;
	hostContext: any | null;
	pendingRecovery: {
		prompt: string;
		triggerKind: string;
		offendingTool: string | null;
		mode: RecoveryMode;
	} | null;
	recovering: boolean;
	lastOutcome: LoopOutcome;
	lastResetAt: string;
}

const MAX_RUNTIME_EVENTS = 64;
const MAX_INPUT_HISTORY = 6;
const DEFAULT_RECOVERY_MODE: RecoveryMode = "newSession";

function createRuntimeState(): RuntimeState {
	return {
		detector: new LoopDetector(),
		events: [],
		inputHistory: [],
		lastAssistantDigest: null,
		hostContext: null,
		pendingRecovery: null,
		recovering: false,
		lastOutcome: null,
		lastResetAt: new Date().toISOString(),
	};
}

function summarizeOutcome(outcome: LoopOutcome): string {
	if (!outcome) {
		return "No suspicious loop pattern detected.";
	}

	const action = outcome.intervention?.type ?? outcome.judgeOutcome.recommended_action;
	const reason = outcome.judgeOutcome.reason || outcome.trigger.kind;
	return `Loop detected via ${outcome.trigger.kind}. Action: ${action}. Reason: ${reason}`;
}

function recordRuntimeEvent(state: RuntimeState, event: LoopEvent): void {
	state.events.push(event);
	if (state.events.length > MAX_RUNTIME_EVENTS) {
		state.events.splice(0, state.events.length - MAX_RUNTIME_EVENTS);
	}
}

function recordInput(state: RuntimeState, text: string): void {
	const normalized = text.trim();
	if (!normalized) return;
	state.inputHistory.push(normalized);
	if (state.inputHistory.length > MAX_INPUT_HISTORY) {
		state.inputHistory.splice(0, state.inputHistory.length - MAX_INPUT_HISTORY);
	}
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

function getNestedNumber(value: unknown, key: string): number | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Record<string, unknown>;
	if (typeof candidate[key] === "number") return candidate[key] as number;
	if (candidate.result && typeof candidate.result === "object" && typeof (candidate.result as Record<string, unknown>)[key] === "number") {
		return (candidate.result as Record<string, unknown>)[key] as number;
	}
	return undefined;
}

function hasExplicitError(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	if (candidate.error != null || candidate.errors != null) return true;
	if (candidate.result && typeof candidate.result === "object") {
		const nested = candidate.result as Record<string, unknown>;
		return nested.error != null || nested.errors != null;
	}
	return false;
}

function inferToolResultStatus(event: any): { ok: boolean; progress: boolean | undefined } {
	const payload = inferResultPayload(event);
	const explicitOk = typeof event?.ok === "boolean" ? event.ok : typeof event?.success === "boolean" ? event.success : undefined;
	const exitCode =
		typeof event?.exit_code === "number"
			? event.exit_code
			: typeof event?.exitCode === "number"
				? event.exitCode
				: getNestedNumber(payload, "exit_code") ?? getNestedNumber(payload, "exitCode");
	const explicitProgress = typeof event?.progress === "boolean" ? event.progress : undefined;

	let ok: boolean;
	if (explicitOk !== undefined) {
		ok = explicitOk;
	} else if (typeof exitCode === "number") {
		ok = exitCode === 0;
	} else if (hasExplicitError(event) || hasExplicitError(payload)) {
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

function findSuspectedLoopStart(state: RuntimeState, outcome: NonNullable<LoopOutcome>): string {
	const offendingTool = outcome.trigger.offendingTool ?? outcome.judgeOutcome.offendingTool ?? null;
	const recent = state.events.slice(-16);

	if (offendingTool) {
		const firstToolCall = recent.find(
			(event) => event.type === "tool_call" && event.toolName === offendingTool,
		);
		if (firstToolCall) {
			return `First recent repeated call to ${offendingTool}${firstToolCall.timestamp ? ` at ${firstToolCall.timestamp}` : ""}.`;
		}

		const firstToolResult = recent.find(
			(event) => event.type === "tool_result" && event.toolName === offendingTool,
		);
		if (firstToolResult) {
			return `First recent repeated result for ${offendingTool}${firstToolResult.timestamp ? ` at ${firstToolResult.timestamp}` : ""}.`;
		}
	}

	const firstEvidenceEvent = state.events[Math.max(0, state.events.length - 8)];
	if (!firstEvidenceEvent) return "Unknown.";
	return `Within the last ${Math.min(8, state.events.length)} captured runtime events${firstEvidenceEvent.timestamp ? `, beginning around ${firstEvidenceEvent.timestamp}` : ""}.`;
}

function buildRecentTranscript(state: RuntimeState): string {
	const recent = state.events.slice(-12);
	if (recent.length === 0) return "No recent runtime events captured.";

	return recent
		.map((event) => {
			if (event.type === "assistant_message") {
				return `assistant_message: ${event.content.slice(0, 400)}`;
			}
			if (event.type === "tool_call") {
				return `tool_call ${event.toolName}: ${JSON.stringify(event.args ?? {})}`;
			}
			return `tool_result ${event.toolName}: ok=${event.ok} progress=${String(event.progress)} result=${extractText(event.result).slice(0, 240)}`;
		})
		.join("\n");
}

function buildRecoveryPrompt(state: RuntimeState, outcome: NonNullable<LoopOutcome>, mode: RecoveryMode): string {
	const offendingTool = outcome.trigger.offendingTool ?? outcome.judgeOutcome.offendingTool ?? null;
	const recentGoal = state.inputHistory.length > 0 ? state.inputHistory[state.inputHistory.length - 1] : "No user goal captured in this session.";
	const originalGoal = state.inputHistory.length > 0 ? state.inputHistory[0] : recentGoal;
	const evidence = outcome.evidence;
	const suspectedLoopStart = findSuspectedLoopStart(state, outcome);
	const triggerNotes = outcome.trigger.notes?.join("\n- ") ?? "No notes.";
	const assistantMessages = evidence.assistantMessages.map((msg) => `- ${msg.content.slice(0, 280)}`).join("\n") || "- None captured";
	const toolCalls = evidence.toolCalls.map((call) => `- ${call.toolName} ${JSON.stringify(call.args ?? {})}`).join("\n") || "- None captured";
	const toolResults =
		evidence.toolResults
			.map((result) => `- ${result.toolName} ok=${result.ok} progress=${String(result.progress)} summary=${result.resultSummary}`)
			.join("\n") || "- None captured";
	const resetHeader =
		mode === "newSession"
			? "Previous transcript tail is suspected to be a nonproductive loop. Treat this as a fresh recovery context."
			: "Loop detector interruption: evaluate the suspected loop before continuing.";

	return `${resetHeader}

## Original Goal
${originalGoal}

## Most Recent User Direction
${recentGoal}

## Suspected Loop
- Trigger: ${outcome.trigger.kind}
- Offending tool: ${offendingTool ?? "unknown"}
- Suspected loop start: ${suspectedLoopStart}
- Judge reason: ${outcome.judgeOutcome.reason || "Deterministic heuristic trigger"}
- Confidence: ${outcome.judgeOutcome.confidence}
- Notes:
- ${triggerNotes}

## Recent Assistant Messages
${assistantMessages}

## Recent Tool Calls
${toolCalls}

## Recent Tool Results
${toolResults}

## Recent Runtime Transcript
${buildRecentTranscript(state)}

## Recovery Instructions
1. First perform an isolated loop judgment. Decide whether the prior run was genuinely stuck in a loop.
2. Be explicitly skeptical of the parent session's recent self-explanations, self-corrections, and confident narration. Treat them as potentially compromised loop behavior rather than reliable evidence.
3. Give more weight to observable tool calls, tool results, and concrete failures than to the parent's reflective prose when they conflict.
4. If it was not a loop, say so briefly and continue the task normally.
5. If it was a loop, summarize the last known good state before the loop in 2-4 bullets.
6. Name the concrete constraint, missing precondition, or mistaken assumption that caused the repetition.
7. Choose a different next action that addresses that constraint directly.
8. Do not repeat ${offendingTool ?? "the same tool/action"} with materially similar inputs until the blocking condition has changed.
9. Continue the task from the recovered state instead of narrating the failed loop again.

## Required First Output
Start your first response with exactly one fenced \`json\` block and no prose before it:

\`\`\`json
{
  "is_loop": true,
  "confidence": 0.0,
  "loop_start": "short description",
  "last_good_state": [
    "bullet 1",
    "bullet 2"
  ],
  "cause": "short description",
  "next_steps": [
    "step 1",
    "step 2"
  ]
}
\`\`\`

After that JSON block, continue the task from the recovered state.`;
}

async function flushPendingRecovery(
	state: RuntimeState,
	ctx: any,
	sendMessage: (prompt: string, options?: { deliverAs?: "followUp" | "steer" }) => void,
): Promise<void> {
	if (!state.pendingRecovery || state.recovering) return;

	const pending = state.pendingRecovery;
	state.pendingRecovery = null;
	state.recovering = true;

	try {
		if (pending.mode === "steer") {
			sendMessage(pending.prompt, { deliverAs: "steer" });
			if (ctx.hasUI) {
				ctx.ui.notify(`Loop detector sent steering for ${pending.triggerKind}.`, "warning");
			}
			return;
		}

		const recoveryCtx = typeof ctx?.newSession === "function" ? ctx : state.hostContext;
		if (!recoveryCtx || typeof recoveryCtx.newSession !== "function") {
			throw new Error("fresh session API unavailable");
		}

		if (typeof recoveryCtx.waitForIdle === "function") {
			await recoveryCtx.waitForIdle();
		}

		const result = await recoveryCtx.newSession({
			withSession: async (nextCtx: any) => {
				await nextCtx.sendUserMessage(pending.prompt);
			},
		});

		if (result?.cancelled) {
			throw new Error("Fresh session creation was cancelled");
		}

		if (ctx.hasUI) {
			ctx.ui.notify(`Loop detector started a fresh recovery session for ${pending.triggerKind}.`, "warning");
		}
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		sendMessage(pending.prompt, { deliverAs: "followUp" });
		if (ctx.hasUI) {
			ctx.ui.notify(`Fresh recovery session failed; queued follow-up recovery prompt instead: ${detail}`, "warning");
		}
	} finally {
		state.recovering = false;
	}
}

export default function loopDetectorExtension(pi: ExtensionAPI) {
	let runtime = createRuntimeState();
	const sendMessage = (prompt: string, options?: { deliverAs?: "followUp" | "steer" }) => {
		pi.sendUserMessage(prompt, options);
	};

	async function handleRuntimeEvent(event: LoopEvent, ctx: any, preferredMode: RecoveryMode = DEFAULT_RECOVERY_MODE): Promise<void> {
		recordRuntimeEvent(runtime, event);
		const outcome = await runtime.detector.handleEvent(event);
		runtime.lastOutcome = outcome;
		if (!outcome?.intervention) return;
		if (runtime.pendingRecovery || runtime.recovering) return;

		const prompt = buildRecoveryPrompt(runtime, outcome, preferredMode);
		if (preferredMode === "steer") {
			sendMessage(prompt, { deliverAs: "steer" });
			if (ctx.hasUI) {
				ctx.ui.notify(`Loop detector sent in-session judge steering for ${outcome.trigger.kind}.`, "warning");
			}
			return;
		}

		runtime.pendingRecovery = {
			prompt,
			triggerKind: outcome.trigger.kind,
			offendingTool: outcome.trigger.offendingTool ?? outcome.judgeOutcome.offendingTool ?? null,
			mode: preferredMode,
		};

		if (ctx.hasUI) {
			ctx.ui.notify(`Loop detector triggered on ${outcome.trigger.kind}; preparing fresh-context judge recovery.`, "warning");
		}

		if (typeof ctx?.isIdle === "function" && ctx.isIdle()) {
			await flushPendingRecovery(runtime, ctx, sendMessage);
		}
	}

	pi.registerCommand("loop-detector", {
		description: "Inspect or control the live loop detector",
		handler: async (args, ctx) => {
			const [command] = args.trim().split(/\s+/);

			if (command === "reset") {
				runtime = createRuntimeState();
				if (ctx.hasUI) ctx.ui.notify("Loop detector runtime state reset.", "info");
				return;
			}

			if (command === "recover") {
				await flushPendingRecovery(runtime, ctx, sendMessage);
				return;
			}

			if (command === "status") {
				const summary = runtime.lastOutcome ? summarizeOutcome(runtime.lastOutcome) : "No loop detected in this session.";
				const pending = runtime.pendingRecovery
					? `Pending recovery: ${runtime.pendingRecovery.triggerKind} via ${runtime.pendingRecovery.mode}`
					: "Pending recovery: none";
				if (ctx.hasUI) {
					ctx.ui.notify(`${summary}\n${pending}\nCaptured events: ${runtime.events.length}`, "info");
				}
				return;
			}

			if (ctx.hasUI) {
				ctx.ui.notify(
					[
						"Loop Detector",
						"  /loop-detector status   Show runtime detector state",
						"  /loop-detector recover  Execute any pending recovery immediately",
						"  /loop-detector reset    Clear captured detector state",
					].join("\n"),
					"info",
				);
			}
		},
	});

	pi.registerTool({
		name: "detect_loop",
		label: "Detect Agent Loop",
		description: "Analyze recent assistant and tool events for suspicious looping behavior.",
		promptSnippet: "Check whether the agent is stuck repeating the same wrong action pattern.",
		promptGuidelines: [
			"Use this when recent turns suggest repeated nonproductive behavior rather than normal multi-step work.",
			"Pass events in chronological order and include assistant text plus tool calls and tool results when available.",
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
			const detector = new LoopDetector(params.config ?? {});
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
					runtimeSummary:
						inputEvents === runtime.events
							? {
									capturedEvents: runtime.events.length,
									pendingRecovery: runtime.pendingRecovery,
									lastResetAt: runtime.lastResetAt,
							  }
							: undefined,
				},
			};
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		runtime = createRuntimeState();
		runtime.hostContext = ctx;
		if (ctx.hasUI) {
			ctx.ui.notify("Loop detector active for this session.", "info");
		}
	});

	pi.on("session_shutdown", async () => {
		runtime = createRuntimeState();
	});

	pi.on("input", async (event, _ctx) => {
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
			const digest = assistantText.slice(0, 600);
			if (digest !== runtime.lastAssistantDigest) {
				runtime.lastAssistantDigest = digest;
				await handleRuntimeEvent(
					{
						type: "assistant_message",
						content: assistantText,
						timestamp: typeof event?.timestamp === "string" ? event.timestamp : undefined,
					},
					ctx,
					"steer",
				);
			}
		}

		await flushPendingRecovery(runtime, ctx, sendMessage);
	});

	pi.on("turn_end", async (_event, ctx) => {
		await flushPendingRecovery(runtime, ctx, sendMessage);
	});
}
