export const RECOVERY_CHILD_PRIORITY = ["scout", "researcher", "reviewer"];

export function selectRecoveryChildren() {
  return [...RECOVERY_CHILD_PRIORITY];
}

export function buildRecoveryPrompt(outcome, options = {}) {
  const childAgents = Array.isArray(options.childAgents) && options.childAgents.length > 0 ? options.childAgents : RECOVERY_CHILD_PRIORITY;
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
    "Pause the current turn and move the next step into a fresh recovery context when supported.",
    `Preferred child-agent order: ${childAgents.join(" -> ")}.`,
    "Take the smallest useful recovery step and do not repeat the same failed action.",
    "If a fresh session is available, prefer it; otherwise use the supported fallback path.",
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
