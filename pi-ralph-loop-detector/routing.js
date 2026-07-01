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
  const offendingTool =
    options.analysis?.offendingTool
    ?? outcome?.trigger?.offendingTool
    ?? outcome?.judgeOutcome?.offendingTool
    ?? null;
  const analysisSummary = options.analysis?.summary?.trim?.() ?? "";
  const rationale = options.analysis?.rationale?.trim?.() ?? "";
  const suspectedGoal = options.analysis?.suspectedGoal?.trim?.() ?? "";
  const nextSteps = Array.isArray(options.analysis?.nextSteps) ? options.analysis.nextSteps.filter(Boolean) : [];
  const lines = [
    options.title ?? "Ralph recovery session",
    "",
    `Likely loop trigger: ${trigger}.`,
    `Suggested action: ${action}.`,
    "A fresh recovery context has been created for this Ralph loop.",
    "Do not rely on the prior transcript being present; use the analysis below as your handoff.",
  ];

  if (offendingTool) {
    lines.push(`Offending tool: ${offendingTool}.`);
  }
  if (reason) {
    lines.push(`Reason: ${reason}.`);
  }
  if (suspectedGoal) {
    lines.push(`Suspected goal: ${suspectedGoal}.`);
  }
  if (analysisSummary) {
    lines.push("", "## Recovery Summary", analysisSummary);
  }
  if (rationale && rationale !== reason) {
    lines.push("", "## Why It Got Stuck", rationale);
  }
  if (nextSteps.length > 0) {
    lines.push("", "## Next Steps");
    for (const step of nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  lines.push(
    "",
    "Continue from this fresh context rather than steering the old one.",
    "Take the smallest useful recovery step and do not repeat the same failed action.",
    "If you need to inspect state again, start with the narrowest check that can confirm the next move.",
    "Use Ralph tools to update task state and evidence as you recover.",
    "Invoke subagents again if they can reduce uncertainty faster than continuing solo.",
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
