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
    this.debugLogger = typeof this.config.debug === "function" ? this.config.debug : null;
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
    this.#debug("event.normalized", {
      eventType: normalizedEvent.type,
      toolName: normalizedEvent.toolName ?? null,
      toolBaseName: normalizedEvent.toolBaseName ?? null,
      toolClass: normalizedEvent.toolClass ?? null,
      ok: normalizedEvent.ok ?? null,
      progress: normalizedEvent.progress ?? null,
      progressKind: normalizedEvent.progressKind ?? null,
      argsSignature: normalizedEvent.argsSignature ?? null,
    });
    this.#trackIntentState(normalizedEvent);
    this.events.push(normalizedEvent);
    this.#trimEvents();

    if (this.cooldownRemaining > 0) {
      this.#debug("cooldown.active", {
        remaining: this.cooldownRemaining,
        eventType: normalizedEvent.type,
        eventTool: normalizedEvent.toolName ?? null,
      });
      if (this.#shouldClearCooldownEarly(normalizedEvent)) {
        this.cooldownRemaining = 0;
        this.#debug("cooldown.cleared", {
          eventType: normalizedEvent.type,
          eventTool: normalizedEvent.toolName ?? null,
        });
        return null;
      } else {
        this.cooldownRemaining -= 1;
        return null;
      }
    }

    const trigger = this.#evaluateHeuristics();
    if (!trigger) {
      this.#debug("heuristics.none", {
        eventType: normalizedEvent.type,
        eventTool: normalizedEvent.toolName ?? null,
      });
      return null;
    }
    this.#debug("heuristics.trigger", trigger);

    const evidence = this.#buildEvidencePacket(trigger);
    this.#debug("judge.request", {
      trigger: trigger.kind,
      offendingTool: trigger.offendingTool ?? null,
      assistantMessages: evidence.assistantMessages.length,
      toolCalls: evidence.toolCalls.length,
      toolResults: evidence.toolResults.length,
    });
    const judgeOutcome = await this.#runJudge(evidence);
    this.lastJudgeOutcome = judgeOutcome;
    this.#debug("judge.result", judgeOutcome);
    const review = this.#buildReview(judgeOutcome);
    this.#debug("review.result", review);

    if (!judgeOutcome.is_loop || judgeOutcome.action === "continue") {
      this.#debug("intervention.skip", {
        trigger: trigger.kind,
        reason: judgeOutcome.reason,
      });
      return {
        trigger,
        evidence,
        judgeOutcome,
        intervention: null,
        review,
      };
    }

    const intervention = {
      type: review.action,
      offendingTool: trigger.offendingTool ?? judgeOutcome.offendingTool ?? null,
      message:
        review.message ??
        buildInterventionMessage(
          review.action,
          trigger,
          trigger.offendingTool ?? judgeOutcome.offendingTool ?? null,
        ),
      blockedTools:
        review.action === "stop" && trigger.offendingTool
          ? [trigger.offendingTool]
          : [],
    };

    this.lastInterventionType = intervention.type;
    this.cooldownRemaining = this.config.cooldownEvents;
    this.#resetLoopEvidence();
    this.#debug("intervention.emit", intervention);

    return {
      trigger,
      evidence,
      judgeOutcome,
      intervention,
      review,
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
        stillPending.push(pending);
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

  #resetLoopEvidence() {
    this.events = [];
    this.pendingIntents = [];
    this.intentMismatches = [];
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
    const checks = [
      ["exactCallRepetition", heuristicEnabled(this.config.sameTool), () => this.#checkExactCallRepetition()],
      ["sameTool", heuristicEnabled(this.config.sameTool), () => this.#checkSameToolRepetition()],
      ["intentMismatch", heuristicEnabled(this.config.intentMismatch), () => this.#checkIntentActionMismatch()],
      ["failureRepetition", heuristicEnabled(this.config.failureRepetition), () => this.#checkFailureRepetition()],
      ["selfCorrection", heuristicEnabled(this.config.selfCorrection), () => this.#checkSelfCorrectionLoop()],
      ["cycleRepetition", heuristicEnabled(this.config.cycleRepetition), () => this.#checkRepeatedCycle()],
      ["assistantRepetition", heuristicEnabled(this.config.assistantRepetition), () => this.#checkAssistantRepetition()],
    ];

    for (const [name, enabled, fn] of checks) {
      if (!enabled) {
        this.#debug("heuristic.skip", { heuristic: name, enabled: false });
        continue;
      }
      const trigger = fn();
      this.#debug("heuristic.check", {
        heuristic: name,
        enabled: true,
        matched: Boolean(trigger),
        trigger,
      });
      if (trigger) return trigger;
    }

    return null;
  }

  #checkExactCallRepetition() {
    const recentCalls = this.events
      .filter((event) => event.type === "tool_call")
      .slice(-this.config.sameTool.recentActions);

    if (recentCalls.length === 0) {
      return null;
    }

    const latest = recentCalls[recentCalls.length - 1];
    const repeatCount = countTrailingExactCallRepeats(recentCalls, latest.toolName, latest.argsSignature);
    if (repeatCount < sameToolRepeatThreshold(latest, this.config)) {
      return null;
    }

    return {
      kind: "same_call_repetition",
      offendingTool: latest.toolName,
      argsSignature: latest.argsSignature,
      repeatCount,
      recentActionCount: recentCalls.length,
      notes: [`${latest.toolName} repeated ${repeatCount} times with identical arguments.`],
    };
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
        confidence: 0,
        reason: "loop judge unavailable",
        action: "stop",
        offendingTool: evidence.normalizedSummary.offendingTool ?? null,
      };
    }

    try {
      const result = await judge(evidence);
      return {
        is_loop: Boolean(result?.is_loop ?? result?.action !== "continue"),
        confidence: Number(result?.confidence ?? 0),
        reason: String(result?.reason ?? ""),
        action: normalizeJudgeAction(result?.action ?? result?.recommended_action),
        steer_message:
          typeof result?.steer_message === "string"
            ? result.steer_message
            : typeof result?.message === "string"
              ? result.message
              : "",
        offendingTool:
          result?.offendingTool ?? evidence.normalizedSummary.offendingTool ?? null,
      };
    } catch (error) {
      return {
        is_loop: true,
        confidence: 0,
        reason: error instanceof Error ? error.message : String(error),
        action: "stop",
        offendingTool: evidence.normalizedSummary.offendingTool ?? null,
      };
    }
  }

  #buildReview(judgeOutcome) {
    if (!judgeOutcome.is_loop || judgeOutcome.action === "continue") {
      return {
        confidence: 0,
        action: "continue",
      };
    }

    const review = {
      confidence: judgeOutcome.confidence,
      action: judgeOutcome.action === "steer" ? "steer" : "stop",
    };

    if (review.action === "steer") {
      review.message = judgeOutcome.steer_message || judgeOutcome.reason;
    }

    return review;
  }

  #debug(stage, payload) {
    if (typeof this.debugLogger !== "function") {
      return;
    }
    try {
      this.debugLogger({ stage, payload });
    } catch {
      /* ignore debug errors */
    }
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
    case "continue":
      return "Loop detector recorded the trigger and took no action.";
    case "stop":
      return `Loop detector halted the run after ${trigger.kind}. Resume only after changing strategy away from ${offendingTool ?? "the repeated action"}.`;
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
      args,
      argsSignature: stableStringify(args),
      ok: Boolean(event.ok),
      progress: event.progress !== undefined ? Boolean(event.progress) : progressKind !== "none",
      progressKind,
      result: event.result,
      resultSummary: summarizeResult(event.result),
      failureSummarySignature: buildFailureSummarySignature(event),
    };
  }

  return {
    id,
    type: "unknown",
    timestamp,
    original: event,
  };
}

function normalizeTopLevelConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return {};
  return config;
}

function mergeConfig(base, override) {
  const merged = JSON.parse(JSON.stringify(base));
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === "object" && !Array.isArray(value) && merged[key] && typeof merged[key] === "object" && !Array.isArray(merged[key])) {
      merged[key] = { ...merged[key], ...value };
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function normalizeAssistantContent(content) {
  return String(content ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
}

function fnv1a64Hex(value) {
  let hash = BigInt("0xcbf29ce484222325");
  const prime = BigInt("0x100000001b3");
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(16).padStart(16, "0");
}

function compactArgs(args) {
  if (args == null || typeof args !== "object") return {};
  const entries = Object.entries(args);
  const output = {};
  for (const [key, value] of entries.slice(0, MAX_OBJECT_KEYS)) {
    output[key] = compactValue(value, key, 0);
  }
  return output;
}

function compactValue(value, key = "", depth = 0) {
  if (REDACTED_ARG_KEYS.has(key)) return summarizeOmitted(value);
  if (typeof value === "string") return value.length > MAX_ARG_STRING_CHARS ? `${value.slice(0, MAX_ARG_STRING_CHARS)}\n[truncated ${value.length - MAX_ARG_STRING_CHARS} chars]` : value;
  if (value == null || typeof value !== "object") return value;
  if (depth >= 4) return summarizeOmitted(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => compactValue(item, "", depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[truncated ${value.length - MAX_ARRAY_ITEMS} items]`);
    return items;
  }
  const entries = Object.entries(value);
  const output = {};
  for (const [entryKey, entryValue] of entries.slice(0, MAX_OBJECT_KEYS)) {
    output[entryKey] = compactValue(entryValue, entryKey, depth + 1);
  }
  if (entries.length > MAX_OBJECT_KEYS) {
    output.__truncated_keys = entries.length - MAX_OBJECT_KEYS;
  }
  return output;
}

function summarizeOmitted(value) {
  if (typeof value === "string") return `[omitted ${value.length} chars]`;
  if (Array.isArray(value)) return `[omitted array with ${value.length} items]`;
  if (value && typeof value === "object") return `[omitted object with ${Object.keys(value).length} keys]`;
  return "[omitted]";
}

function summarizeResult(result) {
  if (typeof result === "string") return result.length > 1000 ? `${result.slice(0, 1000)}\n[truncated ${result.length - 1000} chars]` : result;
  if (result == null || typeof result !== "object") return result;
  const serialized = stableStringify(result);
  if (serialized.length <= 1000) return result;
  return `${serialized.slice(0, 1000)}\n[truncated ${serialized.length - 1000} chars]`;
}

function buildFailureSummarySignature(event) {
  return stableStringify({
    ok: Boolean(event.ok),
    error: event.error ?? null,
    result: typeof event.result === "object" ? compactArgs(event.result) : event.result,
  });
}

function resolveToolInfo(toolName, config) {
  const normalizedName = normalizeToolName(toolName, config.toolAliases);
  const className = classifyTool(normalizedName, config);
  return {
    name: normalizedName,
    className,
    settings: resolveToolSettings(normalizedName, className, config),
  };
}

function normalizeToolName(toolName, aliases = []) {
  let normalized = String(toolName ?? "");
  for (const alias of aliases) {
    const regex = new RegExp(alias.match, "gi");
    normalized = normalized.replace(regex, alias.replace ?? "$1");
  }
  return normalized;
}

function classifyTool(toolName, config) {
  for (const rule of config.toolClasses ?? []) {
    const regex = new RegExp(rule.match, "i");
    if (regex.test(toolName)) return rule.class;
  }
  return "unknown";
}

function resolveToolSettings(toolName, className, config) {
  return {
    ...(config.classes?.[className] ?? config.classes?.unknown ?? {}),
    ...(config.tools?.[toolName] ?? {}),
  };
}

function inferProgressKind(event, toolSettings, config) {
  if (event.progress === true) return "progress";
  const text = typeof event.result === "string" ? event.result : stableStringify(event.result ?? "");
  if (!text) return toolSettings.successCountsAsProgress ? "progress" : "none";
  if (matchesAny(text, config.resultPatterns?.failure ?? [])) return "failure";
  if (matchesAny(text, config.resultPatterns?.noProgress ?? [])) return "none";
  if (matchesAny(text, config.resultPatterns?.progress ?? [])) return "progress";
  if (toolSettings.successCountsAsProgress === true) return "progress";
  if (toolSettings.successCountsAsProgress === "weak") return event.ok ? "progress" : "none";
  return "none";
}

function matchesAny(text, patterns) {
  return patterns.some((pattern) => new RegExp(pattern, "i").test(text));
}

function resultIndicatesProgress(event) {
  return Boolean(event.progress);
}

function heuristicEnabled(heuristic) {
  return heuristic && heuristic.enabled !== false;
}

function sameToolRepeatThreshold(sampleCall, config) {
  return sampleCall?.toolSettings?.sameToolRepeats ?? config.sameTool.minRepeats;
}

function isLowInformationTool(toolName, config) {
  const toolInfo = resolveToolInfo(toolName, config);
  return ["read", "cleanup"].includes(toolInfo.className);
}

function failureGroupingKeys(failure) {
  return [stableStringify({
    toolName: failure.toolName,
    toolClass: failure.toolClass,
    argsSignature: failure.argsSignature,
    failureSummarySignature: failure.failureSummarySignature,
  })];
}

function buildActionCycles(events, minAssistantChars) {
  const cycles = [];
  const assistantIndexes = [];
  for (let index = 0; index < events.length; index += 1) {
    if (events[index].type === "assistant_message") {
      assistantIndexes.push(index);
    }
  }

  let pendingCall = null;
  let pendingCallIndex = -1;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.type === "assistant_message") {
      continue;
    }
    if (event.type === "tool_call") {
      pendingCall = event;
      pendingCallIndex = index;
      continue;
    }
    if (event.type !== "tool_result" || !pendingCall || pendingCall.toolName !== event.toolName) {
      continue;
    }

    const assistant = findNearbyAssistantMessage(events, assistantIndexes, pendingCallIndex, index, minAssistantChars);
    if (!assistant) {
      pendingCall = null;
      pendingCallIndex = -1;
      continue;
    }

    const assistantText = assistant.content.slice(0, minAssistantChars);
    cycles.push({
      signature: stableStringify({
        assistant: assistantText,
        toolName: pendingCall.toolName,
        argsSignature: pendingCall.argsSignature,
        ok: event.ok,
        progress: event.progress,
      }),
      toolName: pendingCall.toolName,
    });
    pendingCall = null;
    pendingCallIndex = -1;
  }
  return cycles;
}

function findNearbyAssistantMessage(events, assistantIndexes, callIndex, resultIndex, minAssistantChars) {
  const nearby = [];
  for (const index of assistantIndexes) {
    if (index < Math.max(0, callIndex - 4)) continue;
    if (index > Math.min(events.length - 1, resultIndex + 4)) continue;
    const assistant = events[index];
    if (!assistant || assistant.type !== "assistant_message") continue;
    if (assistant.content.length < minAssistantChars) continue;
    nearby.push({ index, content: assistant.content });
  }

  if (nearby.length === 0) {
    return null;
  }

  const before = nearby.filter((entry) => entry.index <= resultIndex).sort((a, b) => b.index - a.index)[0];
  if (before) return before;
  return nearby.sort((a, b) => a.index - b.index)[0];
}

function countTrailingExactCallRepeats(recentCalls, toolName, argsSignature) {
  let count = 0;
  for (let index = recentCalls.length - 1; index >= 0; index -= 1) {
    const call = recentCalls[index];
    if (call.toolName !== toolName || call.argsSignature !== argsSignature) {
      break;
    }
    count += 1;
  }
  return count;
}

function cycleRepeatThreshold(latest, config) {
  const toolInfo = resolveToolInfo(latest.toolName, config);
  return toolInfo.settings.sameCycleRepeats ?? config.cycleRepetition.minRepeats;
}

function extractExpectedTools(content) {
  const normalized = String(content ?? "");
  const found = new Set();
  for (const pattern of INTENT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(normalized))) {
      if (match[1]) found.add(match[1]);
    }
  }
  return [...found];
}

function normalizeJudgeAction(value) {
  if (value === "continue" || value === "stop" || value === "steer") return value;
  if (value === "ignore") return "continue";
  if (value === "pause" || value === "restrict_tools") return "stop";
  return "stop";
}

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}
