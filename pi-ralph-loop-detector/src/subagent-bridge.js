import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = null;
const JUDGE_SYSTEM_PROMPT = [
  "You are an isolated loop judge running in a separate Pi subprocess.",
  "Analyze only the supplied evidence.",
  "Recommend only actions that are possible with the tools and constraints explicitly provided to you.",
  "Do not suggest restoring git branches, checking out branches, resetting git state, or any other action outside the documented tool contract.",
  'Return exactly one JSON object with: confidence (0 to 1), action ("continue" | "stop" | "steer"), reason (string), offendingTool (string or null), and optional steer_message when action is "steer".',
  "Do not include markdown, code fences, or any extra text.",
].join(" ");

export async function evaluateLoopWithSubagent(target, evidence, options = {}) {
  const payload = buildLoopJudgePayload(evidence, options);
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const roots = Array.isArray(target) ? target : [target];
  const processRunner = roots.find((root) => typeof root?.exec === "function");
  if (processRunner) {
    const rawResult = await runLoopJudgeProcess(processRunner, payload, options, timeoutMs);
    return normalizeLoopJudgeResponse(rawResult, evidence);
  }

  const adapter = resolveSubagentAdapter(roots);
  if (!adapter) {
    throw new Error("subagent RPC unavailable");
  }

  let rawResult;
  if (typeof adapter.invoke === "function") {
    rawResult = timeoutMs == null
      ? await Promise.resolve(adapter.invoke(payload, options))
      : await withTimeout(
          Promise.resolve(adapter.invoke(payload, options)),
          timeoutMs,
          "subagent judge timed out",
        );
  } else {
    if (typeof adapter.spawn !== "function" || typeof adapter.waitForCompletion !== "function") {
      throw new Error("subagent RPC unavailable");
    }

    const run = timeoutMs == null
      ? await Promise.resolve(adapter.spawn(payload, options))
      : await withTimeout(
          Promise.resolve(adapter.spawn(payload, options)),
          timeoutMs,
          "subagent spawn timed out",
        );
    rawResult = timeoutMs == null
      ? await Promise.resolve(adapter.waitForCompletion(run, options))
      : await withTimeout(
          Promise.resolve(adapter.waitForCompletion(run, options)),
          timeoutMs,
          "subagent completion timed out",
        );
  }

  return normalizeLoopJudgeResponse(rawResult, evidence);
}

async function runLoopJudgeProcess(pi, payload, options, timeoutMs) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-loop-judge-"));
  const promptPath = path.join(tempDir, "judge-prompt.md");
  const taskPath = path.join(tempDir, "judge-task.json");

  try {
    const toolkitPrompt = await loadToolkitInstructions();
    const systemPrompt = toolkitPrompt
      ? `${JUDGE_SYSTEM_PROMPT}\n\n## Available Tool Contract\n${toolkitPrompt}`
      : JUDGE_SYSTEM_PROMPT;
    await fs.writeFile(promptPath, systemPrompt, { encoding: "utf-8" });
    await fs.writeFile(taskPath, JSON.stringify(payload, null, 2), { encoding: "utf-8" });

    const args = [
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--no-tools",
      "--append-system-prompt",
      promptPath,
      `Judge this loop evidence and return JSON only:\n\n${await fs.readFile(taskPath, "utf-8")}`,
    ];

    const execOptions = { signal: options.signal };
    if (timeoutMs != null) {
      execOptions.timeout = timeoutMs;
    }
    const result = timeoutMs == null
      ? await Promise.resolve(pi.exec("pi", args, execOptions))
      : await withTimeout(
          Promise.resolve(pi.exec("pi", args, execOptions)),
          timeoutMs,
          "subagent judge timed out",
        );

    const stdout =
      typeof result === "string"
        ? result
        : typeof result?.stdout === "string"
          ? result.stdout
          : typeof result?.output === "string"
            ? result.output
            : "";
    return parseJudgeOutput(stdout);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function normalizeTimeoutMs(value) {
  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return null;
  }
  return timeoutMs;
}

async function loadToolkitInstructions() {
  const toolkitPath = path.join(os.homedir(), ".pi", "agent", "prompts", "TOOLKIT_INSTRUCTIONS.md");
  try {
    const content = await fs.readFile(toolkitPath, "utf-8");
    const trimmed = content.trim();
    return trimmed || null;
  } catch {
    return null;
  }
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

    const nested = root.subagents ?? root?.extensions?.["pi-subagents"];
    if (nested && nested !== root) {
      const nestedAdapter = resolveSubagentAdapter(nested);
      if (nestedAdapter) {
        return nestedAdapter;
      }
    }

    if (looksLikeHostSession(root)) {
      continue;
    }

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

function looksLikeHostSession(root) {
  return Boolean(
    root?.sendUserMessage ||
    root?.registerTool ||
    root?.registerCommand ||
    root?.on ||
    root?.ui,
  );
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

  if (action === "steer" && referencesForbiddenRecovery(steerMessage || reason)) {
    return {
      confidence: 0,
      action: "stop",
      reason: "subagent response recommended an unavailable recovery action",
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

function referencesForbiddenRecovery(text) {
  if (typeof text !== "string") return false;
  return /\b(git\s+checkout|checkout\s+(?:a\s+)?branch|switch\s+(?:to\s+)?branch|restore\s+(?:the\s+)?branch|git\s+reset|reset\s+the\s+branch|rewind\s+the\s+branch)\b/i.test(text);
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

function parseJudgeOutput(stdout) {
  if (typeof stdout !== "string" || !stdout.trim()) {
    return null;
  }

  const direct = tryParseJson(stdout);
  if (direct) return direct;

  let lastJson = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const event = tryParseJson(line);
    if (!event) continue;
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const text = extractTextFromMessage(event.message);
      const parsed = tryParseJson(text);
      if (parsed) lastJson = parsed;
    }
  }

  return lastJson;
}

function extractTextFromMessage(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function tryParseJson(text) {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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
