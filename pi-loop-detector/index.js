import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { LoopDetector } from "./src/index.js";
import { evaluateLoopWithSubagent } from "./src/subagent-bridge.js";
const MAX_RUNTIME_EVENTS = 64;
const MAX_INPUT_HISTORY = 6;
const DEFAULT_JUDGE_TIMEOUT_MS = 15_000;
const MAX_INPUT_CHARS = 2000;
const MAX_TOOL_ARG_STRING_CHARS = 500;
const MAX_TOOL_ARGS_JSON_CHARS = 1400;
const MAX_TOOL_RESULT_CHARS = 1000;
const MAX_OBJECT_KEYS = 30;
const MAX_ARRAY_ITEMS = 20;
const REDACTED_ARG_KEYS = new Set([
    "content",
    "contents",
    "new_str",
    "old_str",
    "newString",
    "oldString",
    "patch",
    "diff",
    "script",
    "source",
    "transcript",
    "messages",
    "stdout",
    "stderr",
    "output",
    "result",
    "results",
]);
function createRuntimeState(config = {}, judgeBridge) {
    const state = {
        detector: null,
        events: [],
        inputHistory: [],
        hostContext: null,
        halted: false,
        haltReason: null,
        lastOutcome: null,
        lastResetAt: new Date().toISOString(),
    };
    const judge = typeof judgeBridge === "function" ? (evidence) => judgeBridge(evidence, state) : undefined;
    state.detector = new LoopDetector({
        ...config,
        judge,
    });
    return state;
}
function loadProjectConfig(ctx) {
    const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : "";
    if (!cwd)
        return {};
    const configPath = path.join(cwd, ".pi-loop-detector.json");
    if (!fs.existsSync(configPath))
        return {};
    try {
        const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed;
        }
        if (ctx.hasUI)
            ctx.ui.notify(".pi-loop-detector.json must contain a JSON object; using defaults.", "warning");
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI)
            ctx.ui.notify(`Failed to read .pi-loop-detector.json; using defaults: ${detail}`, "warning");
    }
    return {};
}
function summarizeOutcome(outcome) {
    if (!outcome) {
        return "No suspicious loop pattern detected.";
    }
    const action = outcome.intervention?.type ?? outcome.judgeOutcome.action;
    const reason = outcome.judgeOutcome.reason || outcome.trigger.kind;
    return `Loop detected via ${outcome.trigger.kind}. Action: ${action}. Reason: ${reason}`;
}
function recordRuntimeEvent(state, event) {
    state.events.push(event);
    if (state.events.length > MAX_RUNTIME_EVENTS) {
        state.events.splice(0, state.events.length - MAX_RUNTIME_EVENTS);
    }
}
function recordInput(state, text) {
    const normalized = truncateText(text.trim(), MAX_INPUT_CHARS);
    if (!normalized)
        return;
    state.inputHistory.push(normalized);
    if (state.inputHistory.length > MAX_INPUT_HISTORY) {
        state.inputHistory.splice(0, state.inputHistory.length - MAX_INPUT_HISTORY);
    }
}
function truncateText(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]`;
}
function summarizeOmitted(value) {
    if (typeof value === "string")
        return `[omitted ${value.length} chars]`;
    if (Array.isArray(value))
        return `[omitted array with ${value.length} items]`;
    if (value && typeof value === "object")
        return `[omitted object with ${Object.keys(value).length} keys]`;
    return "[omitted]";
}
function sanitizeForPrompt(value, key = "", depth = 0) {
    if (REDACTED_ARG_KEYS.has(key))
        return summarizeOmitted(value);
    if (typeof value === "string")
        return truncateText(value, MAX_TOOL_ARG_STRING_CHARS);
    if (value == null || typeof value !== "object")
        return value;
    if (depth >= 4)
        return summarizeOmitted(value);
    if (Array.isArray(value)) {
        const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeForPrompt(item, "", depth + 1));
        if (value.length > MAX_ARRAY_ITEMS)
            items.push(`[truncated ${value.length - MAX_ARRAY_ITEMS} items]`);
        return items;
    }
    const entries = Object.entries(value);
    const output = {};
    for (const [entryKey, entryValue] of entries.slice(0, MAX_OBJECT_KEYS)) {
        output[entryKey] = sanitizeForPrompt(entryValue, entryKey, depth + 1);
    }
    if (entries.length > MAX_OBJECT_KEYS) {
        output.__truncated_keys = entries.length - MAX_OBJECT_KEYS;
    }
    return output;
}
function sanitizeToolArgs(args) {
    const sanitized = sanitizeForPrompt(args);
    const serialized = JSON.stringify(sanitized);
    if (serialized.length <= MAX_TOOL_ARGS_JSON_CHARS)
        return sanitized;
    return {
        _summary: truncateText(serialized, MAX_TOOL_ARGS_JSON_CHARS),
        _originalArgKeys: Object.keys(args),
    };
}
function compactResultPayload(result) {
    if (typeof result === "string")
        return truncateText(result, MAX_TOOL_RESULT_CHARS);
    if (result == null || typeof result !== "object")
        return result;
    const sanitized = sanitizeForPrompt(result);
    const serialized = JSON.stringify(sanitized);
    if (serialized.length <= MAX_TOOL_RESULT_CHARS)
        return sanitized;
    return truncateText(serialized, MAX_TOOL_RESULT_CHARS);
}
function extractText(value) {
    if (typeof value === "string")
        return value;
    if (Array.isArray(value)) {
        return value
            .map((item) => {
            if (typeof item === "string")
                return item;
            if (item && typeof item === "object" && "text" in item && typeof item.text === "string") {
                return item.text;
            }
            return "";
        })
            .filter(Boolean)
            .join("\n");
    }
    if (value && typeof value === "object") {
        const candidate = value;
        if (typeof candidate.text === "string")
            return candidate.text;
        if (candidate.content !== undefined)
            return extractText(candidate.content);
        if (candidate.message !== undefined)
            return extractText(candidate.message);
    }
    return "";
}
function getToolArgs(event) {
    if (event?.args && typeof event.args === "object")
        return event.args;
    if (event?.input && typeof event.input === "object")
        return event.input;
    return {};
}
function inferResultPayload(event) {
    return event?.result ?? event?.output ?? event?.content ?? event?.details;
}
function getNestedNumber(value, key) {
    if (!value || typeof value !== "object")
        return undefined;
    const candidate = value;
    if (typeof candidate[key] === "number")
        return candidate[key];
    if (candidate.result && typeof candidate.result === "object" && typeof candidate.result[key] === "number") {
        return candidate.result[key];
    }
    return undefined;
}
function hasExplicitError(value) {
    if (!value || typeof value !== "object")
        return false;
    const candidate = value;
    if (candidate.error != null || candidate.errors != null)
        return true;
    if (candidate.result && typeof candidate.result === "object") {
        const nested = candidate.result;
        return nested.error != null || nested.errors != null;
    }
    return false;
}
function inferToolResultStatus(event) {
    const payload = inferResultPayload(event);
    const explicitOk = typeof event?.ok === "boolean" ? event.ok : typeof event?.success === "boolean" ? event.success : undefined;
    const exitCode = typeof event?.exit_code === "number"
        ? event.exit_code
        : typeof event?.exitCode === "number"
            ? event.exitCode
            : getNestedNumber(payload, "exit_code") ?? getNestedNumber(payload, "exitCode");
    const explicitProgress = typeof event?.progress === "boolean" ? event.progress : undefined;
    let ok;
    if (explicitOk !== undefined) {
        ok = explicitOk;
    }
    else if (typeof exitCode === "number") {
        ok = exitCode === 0;
    }
    else if (hasExplicitError(event) || hasExplicitError(payload)) {
        ok = false;
    }
    else {
        ok = true;
    }
    const progress = explicitProgress !== undefined ? explicitProgress : ok ? true : false;
    return { ok, progress };
}
function normalizeToolCallEvent(event) {
    const toolName = typeof event?.toolName === "string" ? event.toolName : typeof event?.name === "string" ? event.name : "";
    if (!toolName)
        return null;
    return {
        type: "tool_call",
        toolName,
        args: sanitizeToolArgs(getToolArgs(event)),
        timestamp: typeof event?.timestamp === "string" ? event.timestamp : undefined,
        id: typeof event?.id === "string" ? event.id : undefined,
    };
}
function normalizeToolResultEvent(event) {
    const toolName = typeof event?.toolName === "string" ? event.toolName : typeof event?.name === "string" ? event.name : "";
    if (!toolName)
        return null;
    const status = inferToolResultStatus(event);
    return {
        type: "tool_result",
        toolName,
        args: sanitizeToolArgs(getToolArgs(event)),
        ok: status.ok,
        progress: status.progress,
        result: compactResultPayload(inferResultPayload(event)),
        timestamp: typeof event?.timestamp === "string" ? event.timestamp : undefined,
        id: typeof event?.id === "string" ? event.id : undefined,
    };
}
function getLatestAssistantMessage(event) {
    const messages = Array.isArray(event?.messages) ? event.messages : [];
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message?.role !== "assistant")
            continue;
        const text = extractText(message?.content);
        if (text.trim())
            return text.trim();
    }
    return "";
}
function createJudgeBridge(pi) {
    return async (evidence, state) => {
        const context = state.hostContext;
        const piAny = pi;
        return evaluateLoopWithSubagent([context, piAny, context?.subagents, piAny?.subagents, context?.extensions?.["pi-subagents"], piAny?.extensions?.["pi-subagents"]], evidence, { timeoutMs: DEFAULT_JUDGE_TIMEOUT_MS });
    };
}
function applyJudgeOutcome(state, ctx, outcome, sendMessage) {
    if (!outcome?.intervention)
        return;
    if (outcome.judgeOutcome.action === "continue")
        return;
    if (state.halted)
        return;
    if (outcome.judgeOutcome.action === "stop") {
        state.halted = true;
        state.haltReason = outcome.judgeOutcome.reason || outcome.trigger.kind;
        if (ctx.hasUI) {
            ctx.ui.notify(`Loop detector halted on ${outcome.trigger.kind}; reset required.`, "warning");
        }
        return;
    }
    const steerMessage = outcome.judgeOutcome.steer_message || outcome.review?.message || outcome.judgeOutcome.reason;
    if (steerMessage) {
        sendMessage(steerMessage, { deliverAs: "steer" });
    }
    if (ctx.hasUI) {
        ctx.ui.notify(`Loop detector sent subagent steering for ${outcome.trigger.kind}.`, "warning");
    }
}
export default function loopDetectorExtension(pi) {
    let runtime = createRuntimeState(loadProjectConfig(null), createJudgeBridge(pi));
    const sendMessage = (prompt, options) => {
        pi.sendUserMessage(prompt, options);
    };
    async function handleRuntimeEvent(event, ctx) {
        recordRuntimeEvent(runtime, event);
        if (runtime.halted)
            return;
        const outcome = await runtime.detector.handleEvent(event);
        runtime.lastOutcome = outcome;
        applyJudgeOutcome(runtime, ctx, outcome, sendMessage);
    }
    pi.registerCommand("loop-detector", {
        description: "Inspect or control the live loop detector",
        handler: async (args, ctx) => {
            const [command] = args.trim().split(/\s+/);
            if (command === "reset") {
                runtime = createRuntimeState(loadProjectConfig(ctx), createJudgeBridge(pi));
                runtime.hostContext = ctx;
                if (ctx.hasUI)
                    ctx.ui.notify("Loop detector runtime state reset.", "info");
                return;
            }
            if (command === "status") {
                const summary = runtime.lastOutcome ? summarizeOutcome(runtime.lastOutcome) : "No loop detected in this session.";
                const halted = runtime.halted ? `Halted: yes (${runtime.haltReason ?? "unknown"})` : "Halted: no";
                if (ctx.hasUI) {
                    ctx.ui.notify(`${summary}\n${halted}\nCaptured events: ${runtime.events.length}`, "info");
                }
                return;
            }
            if (ctx.hasUI) {
                ctx.ui.notify([
                    "Loop Detector",
                    "  /loop-detector status   Show runtime detector state",
                    "  /loop-detector reset    Clear captured detector state",
                ].join("\n"), "info");
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
            events: Type.Optional(Type.Array(Type.Object({}, {
                additionalProperties: true,
                description: "Chronological event objects with type assistant_message, tool_call, or tool_result.",
            }), { description: "Recent runtime events in chronological order." })),
            config: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Optional detector threshold overrides." })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            const inputEvents = Array.isArray(params.events) && params.events.length > 0 ? params.events : runtime.events;
            const detector = new LoopDetector(params.config ?? {});
            let outcome = null;
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
                    runtimeSummary: inputEvents === runtime.events
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
        runtime = createRuntimeState(loadProjectConfig(ctx), createJudgeBridge(pi));
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
        if (!normalized)
            return;
        await handleRuntimeEvent(normalized, ctx);
    });
    pi.on("tool_result", async (event, ctx) => {
        const normalized = normalizeToolResultEvent(event);
        if (!normalized)
            return;
        await handleRuntimeEvent(normalized, ctx);
    });
    pi.on("agent_end", async (event, ctx) => {
        const assistantText = getLatestAssistantMessage(event);
        if (assistantText) {
            await handleRuntimeEvent({
                type: "assistant_message",
                content: assistantText,
                timestamp: typeof event?.timestamp === "string" ? event.timestamp : undefined,
            }, ctx);
        }
    });
}
