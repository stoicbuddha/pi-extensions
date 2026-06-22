const DEFAULTS = {
  bufferSize: 64,
  evidenceWindow: 8,
  cooldownEvents: 3,
  sameTool: {
    recentActions: 5,
    minRepeats: 3,
    maxDistinctArgs: 1,
  },
  intentMismatch: {
    mismatchThreshold: 2,
    lookbackResults: 6,
  },
  failureRepetition: {
    minFailures: 3,
    lookbackResults: 6,
  },
  selfCorrection: {
    minCorrections: 2,
  },
};

const INTENT_PATTERNS = [
  /(?:call|use|run)\s+`([a-z0-9_-]+)`(?:\s+(?:now|next))?/gi,
  /`([a-z0-9_-]+)`\s+(?:now|next)/gi,
  /(?:call|use|run)\s+(?:the actual\s+)?([a-z0-9_-]+)\s+tool\b/gi,
];

const SELF_CORRECTION_PATTERNS = [
  /i keep doing the wrong thing/i,
  /i need to stop calling/i,
  /let me correct that/i,
  /i should stop using/i,
];

export class LoopDetector {
  constructor(config = {}) {
    this.config = mergeConfig(DEFAULTS, config);
    this.events = [];
    this.cooldownRemaining = 0;
    this.lastInterventionType = null;
    this.lastJudgeOutcome = null;
    this.pendingIntents = [];
    this.intentMismatches = [];
  }

  getState() {
    return {
      recentEvents: [...this.events],
      activeCooldown: this.cooldownRemaining,
      lastInterventionType: this.lastInterventionType,
      lastJudgeOutcome: this.lastJudgeOutcome,
    };
  }

  async handleEvent(event) {
    const normalizedEvent = normalizeEvent(event);
    this.#trackIntentState(normalizedEvent);
    this.events.push(normalizedEvent);
    this.#trimEvents();

    if (this.cooldownRemaining > 0) {
      if (this.#shouldClearCooldownEarly(normalizedEvent)) {
        this.cooldownRemaining = 0;
        return null;
      } else {
        this.cooldownRemaining -= 1;
        return null;
      }
    }

    const trigger = this.#evaluateHeuristics();
    if (!trigger) {
      return null;
    }

    const evidence = this.#buildEvidencePacket(trigger);
    const judgeOutcome = await this.#runJudge(evidence);
    this.lastJudgeOutcome = judgeOutcome;

    if (!judgeOutcome.is_loop || judgeOutcome.recommended_action === "ignore") {
      return {
        trigger,
        evidence,
        judgeOutcome,
        intervention: null,
      };
    }

    const intervention = this.#buildIntervention(trigger, judgeOutcome);
    this.lastInterventionType = intervention.type;
    this.cooldownRemaining = this.config.cooldownEvents;

    return {
      trigger,
      evidence,
      judgeOutcome,
      intervention,
    };
  }

  #trackIntentState(event) {
    if (event.type === "assistant_message") {
      const intents = extractExpectedTools(event.content);
      if (intents.length > 0) {
        this.pendingIntents.push({
          eventId: event.id,
          tools: intents,
          content: event.content,
        });
      }
      return;
    }

    if (event.type !== "tool_call" || this.pendingIntents.length === 0) {
      return;
    }

    const toolName = event.toolName;
    const stillPending = [];
    for (const pending of this.pendingIntents) {
      if (pending.tools.includes(toolName)) {
        continue;
      }
      this.intentMismatches.push({
        expectedTools: pending.tools,
        actualTool: toolName,
        assistantMessageId: pending.eventId,
        assistantMessage: pending.content,
      });
    }
    for (const pending of stillPending) {
      this.pendingIntents.push(pending);
    }
    this.pendingIntents = [];
    this.intentMismatches = this.intentMismatches.slice(-10);
  }

  #trimEvents() {
    if (this.events.length > this.config.bufferSize) {
      this.events.splice(0, this.events.length - this.config.bufferSize);
    }
  }

  #shouldClearCooldownEarly(event) {
    if (event.type === "tool_result" && event.ok && event.progress !== false) {
      return true;
    }
    if (event.type === "tool_call" && this.lastJudgeOutcome?.offendingTool) {
      return event.toolName !== this.lastJudgeOutcome.offendingTool;
    }
    return false;
  }

  #evaluateHeuristics() {
    return (
      this.#checkSameToolRepetition() ||
      this.#checkIntentActionMismatch() ||
      this.#checkFailureRepetition() ||
      this.#checkSelfCorrectionLoop()
    );
  }

  #checkSameToolRepetition() {
    const recentCalls = this.events
      .filter((event) => event.type === "tool_call")
      .slice(-this.config.sameTool.recentActions);

    if (recentCalls.length < this.config.sameTool.minRepeats) {
      return null;
    }

    const counts = new Map();
    for (const call of recentCalls) {
      counts.set(call.toolName, (counts.get(call.toolName) ?? 0) + 1);
    }

    const offender = [...counts.entries()].find(
      ([, count]) => count >= this.config.sameTool.minRepeats,
    );
    if (!offender) {
      return null;
    }

    const [toolName, count] = offender;
    const offendingCalls = recentCalls.filter((event) => event.toolName === toolName);
    const distinctArgs = new Set(offendingCalls.map((event) => event.argsSignature));
    if (distinctArgs.size > this.config.sameTool.maxDistinctArgs) {
      return null;
    }

    const relatedResults = this.events
      .filter((event) => event.type === "tool_result" && event.toolName === toolName)
      .slice(-count);

    if (relatedResults.length < Math.max(1, count - 1)) {
      return null;
    }

    const hasProgress = relatedResults.some((event) => event.ok && event.progress !== false);
    if (hasProgress) {
      return null;
    }

    return {
      kind: "same_tool_repetition",
      offendingTool: toolName,
      repeatCount: count,
      recentActionCount: recentCalls.length,
      notes: [`${toolName} repeated ${count} times with no successful progress signal.`],
    };
  }

  #checkIntentActionMismatch() {
    const mismatches = this.intentMismatches.slice(
      -this.config.intentMismatch.mismatchThreshold,
    );
    if (mismatches.length < this.config.intentMismatch.mismatchThreshold) {
      return null;
    }

    const actualToolSequence = mismatches.map((item) => item.actualTool);
    const repeatedActualTool = actualToolSequence.every(
      (toolName) => toolName === actualToolSequence[0],
    )
      ? actualToolSequence[0]
      : null;
    if (!repeatedActualTool) {
      return null;
    }

    const recentResults = this.events
      .filter(
        (event) =>
          event.type === "tool_result" && event.toolName === repeatedActualTool,
      )
      .slice(-this.config.intentMismatch.lookbackResults);
    const hasProgress = recentResults.some(
      (event) => event.ok && event.progress !== false,
    );
    if (hasProgress) {
      return null;
    }

    const expectedTools = [...new Set(mismatches.flatMap((item) => item.expectedTools))];
    return {
      kind: "intent_action_mismatch",
      expectedTools,
      actualToolSequence,
      offendingTool: repeatedActualTool,
      notes: [
        `Assistant declared ${expectedTools.join(", ")} but repeated ${repeatedActualTool} without observable progress.`,
      ],
    };
  }

  #checkFailureRepetition() {
    const recentResults = this.events
      .filter((event) => event.type === "tool_result")
      .slice(-this.config.failureRepetition.lookbackResults);

    const failures = recentResults.filter((event) => !event.ok);
    if (failures.length < this.config.failureRepetition.minFailures) {
      return null;
    }

    const grouped = new Map();
    for (const failure of failures) {
      const key = `${failure.toolName}:${failure.argsSignature}`;
      const bucket = grouped.get(key) ?? [];
      bucket.push(failure);
      grouped.set(key, bucket);
    }

    for (const [key, bucket] of grouped.entries()) {
      if (bucket.length < this.config.failureRepetition.minFailures) {
        continue;
      }
      const [toolName, argsSignature] = key.split(":");
      return {
        kind: "failure_repetition",
        offendingTool: toolName,
        argsSignature,
        failureCount: bucket.length,
        notes: [`${toolName} failed ${bucket.length} times with materially similar inputs.`],
      };
    }

    return null;
  }

  #checkSelfCorrectionLoop() {
    const correctionMessages = this.events.filter(
      (event) =>
        event.type === "assistant_message" &&
        SELF_CORRECTION_PATTERNS.some((pattern) => pattern.test(event.content)),
    );

    if (correctionMessages.length < this.config.selfCorrection.minCorrections) {
      return null;
    }

    const recentCalls = this.events.filter((event) => event.type === "tool_call").slice(-3);
    if (recentCalls.length < 2) {
      return null;
    }

    const repeatedTool = recentCalls.every(
      (call) => call.toolName === recentCalls[0].toolName,
    )
      ? recentCalls[0].toolName
      : null;

    if (!repeatedTool) {
      return null;
    }

    return {
      kind: "self_correction_loop",
      offendingTool: repeatedTool,
      correctionCount: correctionMessages.length,
      notes: [
        `Assistant self-corrected ${correctionMessages.length} times and still repeated ${repeatedTool}.`,
      ],
    };
  }

  #buildEvidencePacket(trigger) {
    const recentEvents = this.events.slice(-this.config.evidenceWindow);
    const assistantMessages = recentEvents
      .filter((event) => event.type === "assistant_message")
      .map((event) => ({
        id: event.id,
        content: event.content,
        timestamp: event.timestamp,
      }));
    const toolCalls = recentEvents
      .filter((event) => event.type === "tool_call")
      .map((event) => ({
        id: event.id,
        toolName: event.toolName,
        args: event.args,
        argsSignature: event.argsSignature,
        timestamp: event.timestamp,
      }));
    const toolResults = recentEvents
      .filter((event) => event.type === "tool_result")
      .map((event) => ({
        id: event.id,
        toolName: event.toolName,
        ok: event.ok,
        progress: event.progress,
        resultSummary: event.resultSummary,
        argsSignature: event.argsSignature,
        timestamp: event.timestamp,
      }));

    return {
      trigger: trigger.kind,
      assistantMessages,
      toolCalls,
      toolResults,
      normalizedSummary: buildNormalizedSummary(trigger),
    };
  }

  async #runJudge(evidence) {
    const judge = this.config.judge;
    if (typeof judge !== "function") {
      return {
        is_loop: true,
        confidence: 0.7,
        reason: `Deterministic heuristic fired: ${evidence.trigger}.`,
        recommended_action: "steer",
        offendingTool: evidence.normalizedSummary.offendingTool ?? null,
      };
    }

    const result = await judge(evidence);
    return {
      is_loop: Boolean(result?.is_loop),
      confidence: Number(result?.confidence ?? 0),
      reason: String(result?.reason ?? ""),
      recommended_action: normalizeRecommendedAction(result?.recommended_action),
      offendingTool:
        result?.offendingTool ?? evidence.normalizedSummary.offendingTool ?? null,
    };
  }

  #buildIntervention(trigger, judgeOutcome) {
    const type = judgeOutcome.recommended_action;
    const offendingTool = judgeOutcome.offendingTool ?? trigger.offendingTool ?? null;
    const message = buildInterventionMessage(type, trigger, offendingTool);

    return {
      type,
      offendingTool,
      message,
      blockedTools: type === "restrict_tools" && offendingTool ? [offendingTool] : [],
    };
  }
}

export function createEvidencePacket(events, trigger, evidenceWindow = DEFAULTS.evidenceWindow) {
  const recentEvents = events.map(normalizeEvent).slice(-evidenceWindow);
  return {
    trigger: trigger.kind,
    assistantMessages: recentEvents
      .filter((event) => event.type === "assistant_message")
      .map((event) => ({
        id: event.id,
        content: event.content,
        timestamp: event.timestamp,
      })),
    toolCalls: recentEvents
      .filter((event) => event.type === "tool_call")
      .map((event) => ({
        id: event.id,
        toolName: event.toolName,
        args: event.args,
        argsSignature: event.argsSignature,
        timestamp: event.timestamp,
      })),
    toolResults: recentEvents
      .filter((event) => event.type === "tool_result")
      .map((event) => ({
        id: event.id,
        toolName: event.toolName,
        ok: event.ok,
        progress: event.progress,
        resultSummary: event.resultSummary,
        argsSignature: event.argsSignature,
        timestamp: event.timestamp,
      })),
    normalizedSummary: buildNormalizedSummary(trigger),
  };
}

export function buildNormalizedSummary(trigger) {
  return {
    trigger: trigger.kind,
    offendingTool: trigger.offendingTool ?? null,
    expectedTools: trigger.expectedTools ?? [],
    actualToolSequence: trigger.actualToolSequence ?? [],
    notes: trigger.notes ?? [],
  };
}

export function buildInterventionMessage(type, trigger, offendingTool) {
  switch (type) {
    case "pause":
      return `Loop detector paused the run after ${trigger.kind}. Resume only after changing strategy away from ${offendingTool ?? "the repeated action"}.`;
    case "restrict_tools":
      return `Loop detector observed ${trigger.kind}. Do not call ${offendingTool} on the next turn; choose a different corrective action.`;
    case "ignore":
      return "Loop detector recorded the trigger and took no action.";
    case "steer":
    default:
      return `Repeated pattern detected: ${trigger.kind}. Next take a different corrective action and do not repeat ${offendingTool ?? "the same tool/action"}.`;
  }
}

function normalizeEvent(event) {
  const timestamp = event.timestamp ?? new Date().toISOString();
  const id = event.id ?? `${event.type}:${timestamp}:${Math.random().toString(16).slice(2)}`;
  if (event.type === "assistant_message") {
    return {
      id,
      type: "assistant_message",
      timestamp,
      content: String(event.content ?? ""),
    };
  }
  if (event.type === "tool_call") {
    return {
      id,
      type: "tool_call",
      timestamp,
      toolName: String(event.toolName),
      args: event.args ?? {},
      argsSignature: stableStringify(event.args ?? {}),
    };
  }
  if (event.type === "tool_result") {
    return {
      id,
      type: "tool_result",
      timestamp,
      toolName: String(event.toolName),
      ok: Boolean(event.ok),
      progress: event.progress,
      resultSummary: summarizeResult(event.result),
      argsSignature: stableStringify(event.args ?? {}),
    };
  }
  throw new Error(`Unsupported event type: ${event.type}`);
}

function extractExpectedTools(content) {
  const matches = new Set();
  for (const pattern of INTENT_PATTERNS) {
    const scoped = new RegExp(pattern.source, pattern.flags);
    for (const match of content.matchAll(scoped)) {
      matches.add(match[1]);
    }
  }
  return [...matches];
}

function summarizeResult(result) {
  if (result == null) {
    return "";
  }
  if (typeof result === "string") {
    return result.slice(0, 160);
  }
  return stableStringify(result).slice(0, 160);
}

function normalizeRecommendedAction(value) {
  if (value === "ignore" || value === "steer" || value === "pause" || value === "restrict_tools") {
    return value;
  }
  return "steer";
}

function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortValue(value[key])]),
    );
  }
  return value;
}

function mergeConfig(base, override) {
  const output = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      base[key] &&
      typeof base[key] === "object" &&
      !Array.isArray(base[key])
    ) {
      output[key] = mergeConfig(base[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}
