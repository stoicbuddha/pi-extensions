import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { LoopDetector } from "./src/index.js";

type LoopEvent =
	| {
			type: "assistant_message";
			content: string;
			timestamp?: string;
	  }
	| {
			type: "tool_call";
			toolName: string;
			args?: Record<string, unknown>;
			timestamp?: string;
	  }
	| {
			type: "tool_result";
			toolName: string;
			args?: Record<string, unknown>;
			ok: boolean;
			progress?: boolean;
			result?: unknown;
			timestamp?: string;
	  };

function summarizeOutcome(outcome: Awaited<ReturnType<LoopDetector["handleEvent"]>>): string {
	if (!outcome) {
		return "No suspicious loop pattern detected.";
	}

	const action = outcome.intervention?.type ?? outcome.judgeOutcome.recommended_action;
	const reason = outcome.judgeOutcome.reason || outcome.trigger.kind;
	return `Loop detected via ${outcome.trigger.kind}. Action: ${action}. Reason: ${reason}`;
}

export default function loopDetectorExtension(pi: ExtensionAPI) {
	pi.registerCommand("loop-detector", {
		description: "Show how to use the loop detector extension",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			ctx.ui.notify("Use the detect_loop tool to analyze recent assistant/tool events for loop behavior.", "info");
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
			events: Type.Array(
				Type.Object(
					{},
					{
						additionalProperties: true,
						description: "Chronological event objects with type assistant_message, tool_call, or tool_result.",
					},
				),
				{ description: "Recent runtime events in chronological order." },
			),
			config: Type.Optional(
				Type.Object({}, { additionalProperties: true, description: "Optional detector threshold overrides." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const detector = new LoopDetector(params.config ?? {});
			let outcome: Awaited<ReturnType<LoopDetector["handleEvent"]>> = null;

			for (const rawEvent of params.events as LoopEvent[]) {
				outcome = await detector.handleEvent(rawEvent);
			}

			const state = detector.getState();
			const text = summarizeOutcome(outcome);

			return {
				content: [{ type: "text", text }],
				details: {
					outcome,
					state,
				},
			};
		},
	});
}
