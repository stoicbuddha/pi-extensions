export const RECOVERY_CHILD_PRIORITY = ["scout", "researcher", "reviewer"];
export const DEFAULT_JUDGE_CONFIDENCE_THRESHOLD = 0.7;

export function selectRecoveryChildren() {
  return [...RECOVERY_CHILD_PRIORITY];
}

export function resolveJudgeDisposition(outcome, options = {}) {
  const confidenceThreshold = normalizeConfidenceThreshold(options.confidenceThreshold ?? DEFAULT_JUDGE_CONFIDENCE_THRESHOLD);
  const action = outcome?.review?.action ?? outcome?.judgeOutcome?.action ?? "continue";
  const confidence = normalizeConfidence(outcome?.review?.confidence ?? outcome?.judgeOutcome?.confidence);
  const reason = outcome?.review?.message ?? outcome?.judgeOutcome?.reason ?? "";

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

export function buildRecoveryPrompt(outcome, options = {}) {
  const trigger = outcome?.trigger?.kind ?? outcome?.trigger ?? "unknown";
  const action = outcome?.review?.action ?? outcome?.judgeOutcome?.action ?? "steer";
  const reason = outcome?.review?.message ?? outcome?.judgeOutcome?.reason ?? "";
  const offendingTool = outcome?.trigger?.offendingTool ?? outcome?.judgeOutcome?.offendingTool ?? null;
  const steerMessage = outcome?.judgeOutcome?.steer_message ?? outcome?.review?.message ?? "";
  const lines = [
    options.title ?? "Ralph recovery session",
    "",
    `Likely loop trigger: ${trigger}.`,
    `Suggested action: ${action}.`,
    "Stay in the current session and steer the active agent directly.",
  ];

  if (offendingTool) {
    lines.push(`Offending tool: ${offendingTool}.`);
  }
  if (reason) {
    lines.push(`Reason: ${reason}.`);
  }
  if (steerMessage && steerMessage !== reason) {
    lines.push(`Steer guidance: ${steerMessage}.`);
  }

  lines.push(
    "",
    "Do not fork a fresh recovery context for this loop.",
    "Use the smallest correction that breaks the loop, or stop if the loop is unbreakable.",
    "If the active loop should advance rather than repeat, prefer invoking ralph_done from the same session.",
    "Take the smallest useful recovery step and do not repeat the same failed action.",
    "If the current session can continue safely, let it continue.",
  );

  return lines.join("\n");
}

export function summarizeRecovery(outcome) {
  if (!outcome) {
    return "No suspicious loop pattern detected.";
  }

  const action = outcome.review?.action ?? outcome.judgeOutcome?.action ?? outcome.intervention?.type ?? "continue";
  const reason = outcome.review?.message ?? outcome.judgeOutcome?.reason ?? outcome.trigger?.kind ?? "unknown";
  return `Loop detected via ${outcome.trigger?.kind ?? outcome.trigger}. Action: ${action}. Reason: ${reason}`;
}

function normalizeConfidence(value) {
  const confidence = Number(value);
  if (!Number.isFinite(confidence)) return 0;
  if (confidence < 0) return 0;
  if (confidence > 1) return 1;
  return confidence;
}

function normalizeConfidenceThreshold(value) {
  const threshold = Number(value);
  if (!Number.isFinite(threshold)) return DEFAULT_JUDGE_CONFIDENCE_THRESHOLD;
  if (threshold < 0) return 0;
  if (threshold > 1) return 1;
  return threshold;
}

function isJudgeFallbackReason(reason) {
  return typeof reason === "string" && /^(subagent response|loop judge unavailable)/i.test(reason.trim());
}
