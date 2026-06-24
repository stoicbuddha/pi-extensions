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
    minCorrections: 3,
    minRepeatedCalls: 3,
  },
  assistantRepetition: {
    recentMessages: 8,
    minRepeats: 4,
    minNormalizedChars: 120,
  },
  cycleRepetition: {
    recentEvents: 24,
    minRepeats: 3,
    minAssistantChars: 80,
  },
  toolAliases: [],
  toolClasses: [
    {
      match: "(?:^|_)(?:status|list|show|read|search|inspect|view|cat|ls|tail)(?:$|_)",
      class: "read",
    },
    {
      match: "(?:^|_)(?:create|append|write|edit|replace|remove|delete|commit|restore|apply)(?:$|_)",
      class: "write",
    },
    {
      match: "(?:^|_)(?:check|test|validate|lint|clippy|build|fmt|doc)(?:$|_)",
      class: "validate",
    },
    {
      match: "(?:^|_)(?:clean|clear|prune|cache)(?:$|_)",
      class: "cleanup",
    },
  ],
  classes: {
    read: {
      successCountsAsProgress: false,
      sameCycleRepeats: 3,
      sameToolRepeats: 3,
    },
    cleanup: {
      successCountsAsProgress: false,
      sameCycleRepeats: 3,
      sameToolRepeats: 3,
    },
    validate: {
      successCountsAsProgress: "weak",
      sameCycleRepeats: 3,
      sameToolRepeats: 3,
    },
    write: {
      successCountsAsProgress: true,
      sameCycleRepeats: 3,
      sameToolRepeats: 3,
    },
    unknown: {
      successCountsAsProgress: "weak",
      sameCycleRepeats: 3,
      sameToolRepeats: 4,
    },
  },
  tools: {},
  resultPatterns: {
    progress: [
      "rollback_id",
      "created",
      "updated",
      "modified",
      "files? changed",
      "committed",
    ],
    noProgress: [
      "no files? changed",
      "unchanged",
      "already up to date",
      "not executed",
      "redundant",
      "real file changed:\\s*no",
      "candidate edit persisted:\\s*no",
    ],
    failure: [
      "validation failed",
      "write aborted",
      "exit_code[:\"\\s]*[1-9]",
      "\"ok\"\\s*:\\s*false",
    ],
  },
};

const MAX_ARG_STRING_CHARS = 500;
const MAX_ARGS_JSON_CHARS = 1400;
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

const INTENT_PATTERNS = [
  /(?:call|use|run)\s+`([a-z0-9_-]+)`(?:\s+(?:now|next))?/gi,
  /`([a-z0-9_-]+)`\s+(?:now|next)/gi,
  /(?:call|use|run)\s+(?:the actual\s+)?([a-z0-9_-]+)\s+tool\b/gi,
];

const SELF_CORRECTION_PATTERNS = [
  /i keep doing the wrong thing/i,
  /i keep running the same command/i,
  /i keep making (?:the )?(?:same|exact same) (?:mistake|error)/i,
  /i keep (?:making|doing) this (?:exact same|same) mistake/i,
  /i keep (?:making|doing) this (?:exact same|same) error/i,
  /i need to stop calling/i,
  /let me stop and (?:think|read)/i,
  /let me correct that/i,
  /i should stop using/i,
];

export class LoopDetector {
  constructor(config = {}) {
    this.config = mergeConfig(DEFAULTS, normalizeTopLevelConfig(config));
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
    const normalizedEvent = normalizeEvent(event, this.config);
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
    if (event.type === "tool_result" && resultIndicatesProgress(event)) {
      return true;
    }
    if (event.type === "tool_call" && this.lastJudgeOutcome?.offendingTool) {
      return event.toolName !== this.lastJudgeOutcome.offendingTool;
    }
    return false;
  }

  #evaluateHeuristics() {
    return (
      (heuristicEnabled(this.config.sameTool) && this.#checkSameToolRepetition()) ||
      (heuristicEnabled(this.config.intentMismatch) && this.#checkIntentActionMismatch()) ||
      (heuristicEnabled(this.config.failureRepetition) && this.#checkFailureRepetition()) ||
      (heuristicEnabled(this.config.selfCorrection) && this.#checkSelfCorrectionLoop()) ||
      (heuristicEnabled(this.config.cycleRepetition) && this.#checkRepeatedCycle()) ||
      (heuristicEnabled(this.config.assistantRepetition) && this.#checkAssistantRepetition())
    );
  }

  #checkSameToolRepetition() {
    const recentCalls = this.events
      .filter((event) => event.type === "tool_call")
      .slice(-this.config.sameTool.recentActions);

    if (recentCalls.length === 0) {
      return null;
    }

    const counts = new Map();
    for (const call of recentCalls) {
      counts.set(call.toolName, (counts.get(call.toolName) ?? 0) + 1);
    }

    const offender = [...counts.entries()].find(([toolName, count]) => {
      const sampleCall = recentCalls.find((event) => event.toolName === toolName);
      return count >= sameToolRepeatThreshold(sampleCall, this.config);
    });
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

    const hasProgress = relatedResults.some((event) => resultIndicatesProgress(event));
    if (hasProgress) {
      const isLowInformationSelfCorrection =
        isLowInformationTool(toolName, this.config) &&
        this.#recentSelfCorrectionMessages().length >= this.config.selfCorrection.minCorrections;
      if (!isLowInformationSelfCorrection) {
        return null;
      }
    }

    return {
      kind: "same_tool_repetition",
      offendingTool: toolName,
      repeatCount: count,
      recentActionCount: recentCalls.length,
      notes: [
        hasProgress
          ? `${toolName} repeated ${count} times during self-correction without changing strategy.`
          : `${toolName} repeated ${count} times with no successful progress signal.`,
      ],
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
      for (const key of failureGroupingKeys(failure)) {
        const bucket = grouped.get(key) ?? [];
        bucket.push(failure);
        grouped.set(key, bucket);
      }
    }

    for (const [key, bucket] of grouped.entries()) {
      if (bucket.length < this.config.failureRepetition.minFailures) {
        continue;
      }
      const toolName = bucket[0].toolName;
      return {
        kind: "failure_repetition",
        offendingTool: toolName,
        argsSignature: bucket[0].argsSignature,
        failureSignature: key,
        failureCount: bucket.length,
        notes: [`${toolName} failed ${bucket.length} times with materially similar inputs.`],
      };
    }

    return null;
  }

  #checkSelfCorrectionLoop() {
    const correctionMessages = this.#recentSelfCorrectionMessages();

    if (correctionMessages.length < this.config.selfCorrection.minCorrections) {
      return null;
    }

    const minRepeatedCalls = Math.max(2, Number(this.config.selfCorrection.minRepeatedCalls) || 2);
    const recentCalls = this.events.filter((event) => event.type === "tool_call").slice(-minRepeatedCalls);
    if (recentCalls.length < minRepeatedCalls) {
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

    const relatedResults = this.events
      .filter((event) => event.type === "tool_result" && event.toolName === repeatedTool)
      .slice(-minRepeatedCalls);
    if (relatedResults.length < Math.max(1, minRepeatedCalls - 1)) {
      return null;
    }
    if (relatedResults.some((event) => resultIndicatesProgress(event))) {
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

  #checkAssistantRepetition() {
    const recentMessages = this.events
      .filter((event) => event.type === "assistant_message" && event.contentFingerprint)
      .slice(-this.config.assistantRepetition.recentMessages);

    const grouped = new Map();
    for (const message of recentMessages) {
      if (message.normalizedContent.length < this.config.assistantRepetition.minNormalizedChars) {
        continue;
      }
      const bucket = grouped.get(message.contentFingerprint) ?? [];
      bucket.push(message);
      grouped.set(message.contentFingerprint, bucket);
    }

    for (const [fingerprint, bucket] of grouped.entries()) {
      if (bucket.length < this.config.assistantRepetition.minRepeats) {
        continue;
      }
      return {
        kind: "assistant_repetition",
        assistantFingerprint: fingerprint,
        repeatCount: bucket.length,
        offendingTool: this.#latestToolName(),
        notes: [
          `Assistant repeated materially similar text ${bucket.length} times without a distinct recovery signal.`,
        ],
      };
    }

    return null;
  }

  #checkRepeatedCycle() {
    const recentEvents = this.events.slice(-this.config.cycleRepetition.recentEvents);
    const cycles = buildActionCycles(recentEvents, this.config.cycleRepetition.minAssistantChars);
    const grouped = new Map();

    for (const cycle of cycles) {
      const bucket = grouped.get(cycle.signature) ?? [];
      bucket.push(cycle);
      grouped.set(cycle.signature, bucket);
    }

    for (const [signature, bucket] of grouped.entries()) {
      const latest = bucket[bucket.length - 1];
      if (bucket.length < cycleRepeatThreshold(latest, this.config)) {
        continue;
      }
      return {
        kind: "cycle_repetition",
        cycleSignature: signature,
        offendingTool: latest.toolName,
        repeatCount: bucket.length,
        notes: [
          `Repeated assistant/tool/result cycle ${bucket.length} times: ${latest.toolName} with materially similar context and outcome.`,
        ],
      };
    }

    return null;
  }

  #latestToolName() {
    const latestTool = [...this.events]
      .reverse()
      .find((event) => event.type === "tool_call" || event.type === "tool_result");
    return latestTool?.toolName ?? null;
  }

  #recentSelfCorrectionMessages() {
    return this.events.filter(
      (event) =>
        event.type === "assistant_message" &&
        SELF_CORRECTION_PATTERNS.some((pattern) => pattern.test(event.content)),
    );
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
        toolBaseName: event.toolBaseName,
        toolClass: event.toolClass,
        args: event.args,
        argsSignature: event.argsSignature,
        timestamp: event.timestamp,
      }));
    const toolResults = recentEvents
      .filter((event) => event.type === "tool_result")
      .map((event) => ({
        id: event.id,
        toolName: event.toolName,
        toolBaseName: event.toolBaseName,
        toolClass: event.toolClass,
        ok: event.ok,
        progress: event.progress,
        progressKind: event.progressKind,
        resultSummary: event.resultSummary,
        argsSignature: event.argsSignature,
        failureSummarySignature: event.failureSummarySignature,
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

export function createEvidencePacket(events, trigger, evidenceWindow = DEFAULTS.evidenceWindow, config = {}) {
  const effectiveConfig = mergeConfig(DEFAULTS, normalizeTopLevelConfig(config));
  const recentEvents = events.map((event) => normalizeEvent(event, effectiveConfig)).slice(-evidenceWindow);
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
        toolBaseName: event.toolBaseName,
        toolClass: event.toolClass,
        args: event.args,
        argsSignature: event.argsSignature,
        timestamp: event.timestamp,
      })),
    toolResults: recentEvents
      .filter((event) => event.type === "tool_result")
      .map((event) => ({
        id: event.id,
        toolName: event.toolName,
        toolBaseName: event.toolBaseName,
        toolClass: event.toolClass,
        ok: event.ok,
        progress: event.progress,
        progressKind: event.progressKind,
        resultSummary: event.resultSummary,
        argsSignature: event.argsSignature,
        failureSummarySignature: event.failureSummarySignature,
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

function normalizeEvent(event, config = DEFAULTS) {
  const timestamp = event.timestamp ?? new Date().toISOString();
  const id = event.id ?? `${event.type}:${timestamp}:${Math.random().toString(16).slice(2)}`;
  if (event.type === "assistant_message") {
    const normalizedContent = normalizeAssistantContent(String(event.content ?? ""));
    return {
      id,
      type: "assistant_message",
      timestamp,
      content: String(event.content ?? ""),
      normalizedContent,
      contentFingerprint: normalizedContent ? fnv1a64Hex(normalizedContent) : "",
    };
  }
  if (event.type === "tool_call") {
    const args = compactArgs(event.args ?? {});
    const toolInfo = resolveToolInfo(String(event.toolName), config);
    return {
      id,
      type: "tool_call",
      timestamp,
      toolName: String(event.toolName),
      toolBaseName: toolInfo.name,
      toolClass: toolInfo.className,
      toolSettings: toolInfo.settings,
      args,
      argsSignature: stableStringify(args),
    };
  }
  if (event.type === "tool_result") {
    const args = compactArgs(event.args ?? {});
    const toolInfo = resolveToolInfo(String(event.toolName), config);
    const progressKind = inferProgressKind(event, toolInfo.settings, config);
    return {
      id,
      type: "tool_result",
      timestamp,
      toolName: String(event.toolName),
      toolBaseName: toolInfo.name,
      toolClass: toolInfo.className,
      toolSettings: toolInfo.settings,
      ok: Boolean(event.ok),
      progress: event.progress,
      progressKind,
      resultSummary: summarizeResult(event.result),
      resultSignature: normalizeResultSignature(event.result),
      argsSignature: stableStringify(args),
      failureSummarySignature: normalizeFailureSummary(event.result),
    };
  }
  throw new Error(`Unsupported event type: ${event.type}`);
}

function extractExpectedTools(content) {
  const matches = new Set();
  for (const pattern of INTENT_PATTERNS) {
    const scoped = new RegExp(pattern.source, pattern.flags);
    for (const match of content.matchAll(scoped)) {
      const candidate = match[1];
      if (candidate !== candidate.toLowerCase()) continue;
      matches.add(candidate);
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

function buildActionCycles(events, minAssistantChars) {
  const cycles = [];
  let latestAssistant = null;
  let pendingCall = null;

  for (const event of events) {
    if (event.type === "assistant_message") {
      latestAssistant = event;
      pendingCall = null;
      continue;
    }
    if (event.type === "tool_call") {
      pendingCall = event;
      continue;
    }
    if (event.type !== "tool_result" || !pendingCall) {
      continue;
    }
    if (event.toolName !== pendingCall.toolName) {
      pendingCall = null;
      continue;
    }

    const assistantFingerprint =
      latestAssistant?.normalizedContent?.length >= minAssistantChars
        ? latestAssistant.contentFingerprint
        : "";
    const resultSignature = event.resultSignature || event.failureSummarySignature || event.resultSummary || "";
    if (!assistantFingerprint || !resultSignature) {
      pendingCall = null;
      continue;
    }

    const signature = [
      assistantFingerprint,
      pendingCall.toolBaseName ?? pendingCall.toolName,
      pendingCall.argsSignature,
      event.ok ? "ok" : "failed",
      event.progressKind ?? String(event.progress),
      resultSignature,
    ].join("|");

    cycles.push({
      signature,
      toolName: pendingCall.toolName,
      toolBaseName: pendingCall.toolBaseName ?? pendingCall.toolName,
      toolClass: pendingCall.toolClass ?? "unknown",
      toolSettings: pendingCall.toolSettings ?? {},
      progressKind: event.progressKind,
      assistantFingerprint,
      argsSignature: pendingCall.argsSignature,
      resultSignature,
    });
    pendingCall = null;
  }

  return cycles;
}

function normalizeAssistantContent(content) {
  const withoutCodeBlocks = content.replace(/```[\s\S]*?```/g, " <code> ");
  return withoutCodeBlocks
    .toLowerCase()
    .replace(/\/(?:[\w.-]+\/)*[\w.-]+/g, "<path>")
    .replace(/\b[a-z]:\\(?:[^ \n\r\t]+\\?)+/gi, "<path>")
    .replace(/\b\d+(?:\.\d+)?\b/g, "<num>")
    .replace(/\b0x[0-9a-f]+\b/g, "<hex>")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeResultSignature(result) {
  const summary = summarizeResult(result)
    .toLowerCase()
    .replace(/'[^']*'/g, "'<quoted>'")
    .replace(/"[^"]*"/g, '"<quoted>"')
    .replace(/\/(?:[\w.-]+\/)*[\w.-]+/g, "<path>")
    .replace(/\b\d+(?:\.\d+)?\b/g, "<num>")
    .replace(/\s+/g, " ")
    .trim();

  return summary.length >= 8 ? summary : "";
}

function fnv1a64Hex(input) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const char of input) {
    hash ^= BigInt(char.codePointAt(0));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

function normalizeTopLevelConfig(config) {
  if (!config || typeof config !== "object") return {};
  const output = { ...config };
  if (config.heuristics && typeof config.heuristics === "object") {
    for (const [key, value] of Object.entries(config.heuristics)) {
      output[key] = value;
    }
  }
  return output;
}

function resolveToolInfo(toolName, config) {
  const name = normalizeToolNameWithAliases(toolName, config.toolAliases ?? []);
  const exactSettings = config.tools?.[name] ?? config.tools?.[toolName] ?? {};
  const className = exactSettings.class ?? matchToolClass(name, config.toolClasses ?? []) ?? "unknown";
  const classSettings = config.classes?.[className] ?? config.classes?.unknown ?? {};
  return {
    name,
    className,
    settings: {
      ...classSettings,
      ...exactSettings,
      class: className,
    },
  };
}

function normalizeToolNameWithAliases(toolName, aliases) {
  let output = toolName;
  for (const alias of aliases) {
    if (!alias || typeof alias !== "object") continue;
    if (typeof alias.match !== "string" || typeof alias.replace !== "string") continue;
    try {
      output = output.replace(new RegExp(alias.match), alias.replace);
    } catch {
      continue;
    }
  }
  return output;
}

function matchToolClass(toolName, rules) {
  for (const rule of rules) {
    if (!rule || typeof rule !== "object") continue;
    if (typeof rule.match !== "string" || typeof rule.class !== "string") continue;
    try {
      if (new RegExp(rule.match, "i").test(toolName)) {
        return rule.class;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function inferProgressKind(event, settings, config) {
  if (!Boolean(event.ok)) return "failure";
  const resultText = resultTextForMatching(event.result);
  if (matchesAnyPattern(resultText, config.resultPatterns?.failure)) return "failure";
  if (matchesAnyPattern(resultText, settings.noProgressPatterns)) return "no_progress";
  if (matchesAnyPattern(resultText, config.resultPatterns?.noProgress)) return "no_progress";
  if (matchesAnyPattern(resultText, settings.progressPatterns)) return "progress";
  if (matchesAnyPattern(resultText, config.resultPatterns?.progress)) return "progress";

  const setting = settings.successCountsAsProgress;
  if (setting === true) return "progress";
  if (setting === false) return "no_progress";
  return "weak_progress";
}

function resultTextForMatching(result) {
  if (result == null) return "";
  if (typeof result === "string") return result;
  try {
    return stableStringify(result);
  } catch {
    return String(result);
  }
}

function matchesAnyPattern(text, patterns) {
  if (!Array.isArray(patterns) || !text) return false;
  for (const pattern of patterns) {
    if (typeof pattern !== "string" || !pattern) continue;
    try {
      if (new RegExp(pattern, "i").test(text)) return true;
    } catch {
      continue;
    }
  }
  return false;
}

function resultIndicatesProgress(event) {
  if (event.progressKind) return event.progressKind === "progress";
  return event.ok && event.progress !== false;
}

function cycleRepeatThreshold(cycle, config) {
  const explicit = Number(cycle.toolSettings?.sameCycleRepeats);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const classSettings = config.classes?.[cycle.toolClass] ?? config.classes?.unknown ?? {};
  const classValue = Number(classSettings.sameCycleRepeats);
  if (Number.isFinite(classValue) && classValue > 0) return classValue;
  return config.cycleRepetition.minRepeats;
}

function sameToolRepeatThreshold(event, config) {
  const explicit = Number(event?.toolSettings?.sameToolRepeats);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const classSettings = config.classes?.[event?.toolClass] ?? config.classes?.unknown ?? {};
  const classValue = Number(classSettings.sameToolRepeats);
  if (Number.isFinite(classValue) && classValue > 0) return classValue;
  return config.sameTool.minRepeats;
}

function heuristicEnabled(config) {
  return config?.enabled !== false;
}

function truncateText(text, maxChars) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]`;
}

function summarizeOmitted(value) {
  if (typeof value === "string") return `[omitted ${value.length} chars]`;
  if (Array.isArray(value)) return `[omitted array with ${value.length} items]`;
  if (value && typeof value === "object") return `[omitted object with ${Object.keys(value).length} keys]`;
  return "[omitted]";
}

function sanitizeArgsValue(value, key = "", depth = 0) {
  if (REDACTED_ARG_KEYS.has(key)) return summarizeOmitted(value);
  if (typeof value === "string") return truncateText(value, MAX_ARG_STRING_CHARS);
  if (value == null || typeof value !== "object") return value;
  if (depth >= 4) return summarizeOmitted(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeArgsValue(item, "", depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[truncated ${value.length - MAX_ARRAY_ITEMS} items]`);
    return items;
  }

  const entries = Object.entries(value);
  const output = {};
  for (const [entryKey, entryValue] of entries.slice(0, MAX_OBJECT_KEYS)) {
    output[entryKey] = sanitizeArgsValue(entryValue, entryKey, depth + 1);
  }
  if (entries.length > MAX_OBJECT_KEYS) {
    output.__truncated_keys = entries.length - MAX_OBJECT_KEYS;
  }
  return output;
}

function compactArgs(args) {
  const sanitized = sanitizeArgsValue(args);
  const serialized = JSON.stringify(sanitized);
  if (serialized.length <= MAX_ARGS_JSON_CHARS) return sanitized;
  return {
    _summary: truncateText(serialized, MAX_ARGS_JSON_CHARS),
    _originalArgKeys: Object.keys(args),
  };
}

function failureGroupingKeys(failure) {
  const keys = [`${failure.toolName}:args:${failure.argsSignature}`];
  if (failure.failureSummarySignature) {
    keys.push(`${failure.toolName}:result:${failure.failureSummarySignature}`);
  }
  return keys;
}

function normalizeFailureSummary(result) {
  const summary = summarizeResult(result)
    .toLowerCase()
    .replace(/'[^']*'/g, "'<quoted>'")
    .replace(/"[^"]*"/g, '"<quoted>"')
    .replace(/\/(?:[\w.-]+\/)*[\w.-]+/g, "<path>")
    .replace(/\b\d+\b/g, "<num>")
    .replace(/\s+/g, " ")
    .trim();

  return summary.length >= 12 ? summary : "";
}

function isLowInformationTool(toolName, config = DEFAULTS) {
  const toolInfo = resolveToolInfo(toolName, config);
  if (toolInfo.settings.successCountsAsProgress === false) return true;
  return /(?:^|_)(?:status|list|show|inspect|read|view|cat|ls)(?:$|_)/i.test(toolInfo.name);
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
