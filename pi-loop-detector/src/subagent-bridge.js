const DEFAULT_TIMEOUT_MS = 15_000;

export async function evaluateLoopWithSubagent(target, evidence, options = {}) {
  const adapter = resolveSubagentAdapter(target);
  if (!adapter) {
    throw new Error("subagent RPC unavailable");
  }

  const payload = buildLoopJudgePayload(evidence, options);

  let rawResult;
  if (typeof adapter.invoke === "function") {
    rawResult = await withTimeout(
      Promise.resolve(adapter.invoke(payload, options)),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "subagent judge timed out",
    );
  } else {
    if (typeof adapter.spawn !== "function" || typeof adapter.waitForCompletion !== "function") {
      throw new Error("subagent RPC unavailable");
    }

    const run = await withTimeout(
      Promise.resolve(adapter.spawn(payload, options)),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "subagent spawn timed out",
    );
    rawResult = await withTimeout(
      Promise.resolve(adapter.waitForCompletion(run, options)),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "subagent completion timed out",
    );
  }

  return normalizeLoopJudgeResponse(rawResult, evidence);
}

export function buildLoopJudgePayload(evidence, options = {}) {
  return {
    task: "loop_judge",
    version: 1,
    evidence,
    requestId: options.requestId ?? undefined,
  };
}

export function resolveSubagentAdapter(target) {
  const roots = Array.isArray(target) ? target : [target];

  for (const root of roots) {
    if (!root) continue;

    const invoke =
      firstFunction(root, [
        "judgeLoop",
        "evaluateLoop",
        "invokeLoopJudge",
        "runLoopJudge",
        "requestLoopJudge",
        "judge",
      ]) ?? null;
    if (invoke) {
      return { invoke };
    }

    const spawn =
      firstFunction(root, [
        "spawnLoopJudge",
        "spawnJudge",
        "spawnSubagent",
        "spawn",
      ]) ?? null;
    const waitForCompletion =
      firstFunction(root, [
        "waitForLoopJudgeCompletion",
        "waitForJudgeCompletion",
        "waitForSubagentCompletion",
        "waitForCompletion",
        "awaitCompletion",
      ]) ?? null;

    if (spawn && waitForCompletion) {
      return {
        spawn,
        waitForCompletion,
      };
    }
  }

  return null;
}

export function normalizeLoopJudgeResponse(raw, evidence) {
  const parsed = parseJsonLike(raw);
  if (!parsed || typeof parsed !== "object") {
    return {
      confidence: 0,
      action: "stop",
      reason: "subagent response malformed",
      offendingTool: evidence?.normalizedSummary?.offendingTool ?? null,
    };
  }

  const source = parsed;
  const hasConfidence = typeof source.confidence === "number" && Number.isFinite(source.confidence);
  const hasAction = typeof source.action === "string" || typeof source.recommended_action === "string";
  const action = normalizeLoopAction(source.action ?? source.recommended_action);
  const confidence = normalizeConfidence(source.confidence);
  const reason = typeof source.reason === "string" ? source.reason : "";
  const steerMessage =
    typeof source.steer_message === "string"
      ? source.steer_message
      : typeof source.message === "string"
        ? source.message
        : "";
  const offendingTool = typeof source.offendingTool === "string" ? source.offendingTool : evidence?.normalizedSummary?.offendingTool ?? null;

  if (!hasConfidence) {
    return {
      confidence: 0,
      action: "stop",
      reason: "subagent response missing confidence",
      offendingTool,
    };
  }

  if (!hasAction) {
    return {
      confidence: 0,
      action: "stop",
      reason: "subagent response missing action",
      offendingTool,
    };
  }

  if (action === "steer" && !steerMessage.trim()) {
    return {
      confidence: 0,
      action: "stop",
      reason: "subagent response missing steer_message",
      offendingTool,
    };
  }

  return {
    confidence,
    action,
    steer_message: action === "steer" ? steerMessage : undefined,
    reason,
    offendingTool,
  };
}

function parseJsonLike(raw) {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  if (raw && typeof raw === "object") {
    if (typeof raw.content === "string") {
      try {
        return JSON.parse(raw.content);
      } catch {
        return raw;
      }
    }
    if (typeof raw.text === "string") {
      try {
        return JSON.parse(raw.text);
      } catch {
        return raw;
      }
    }
    return raw;
  }

  return null;
}

function normalizeLoopAction(value) {
  if (value === "continue" || value === "stop" || value === "steer") {
    return value;
  }
  if (value === "ignore") {
    return "continue";
  }
  if (value === "pause" || value === "restrict_tools") {
    return "stop";
  }
  return "stop";
}

function normalizeConfidence(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function firstFunction(root, names) {
  for (const name of names) {
    const value = root?.[name];
    if (typeof value === "function") return value.bind(root);
  }
  return null;
}

function withTimeout(promise, timeoutMs, message) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([
    promise.finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
    }),
    timeout,
  ]);
}
