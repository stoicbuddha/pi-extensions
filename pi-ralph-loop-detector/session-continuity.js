import fs from "node:fs";

const DEFAULT_TEXT_MAX_CHARS = 360;
const DEFAULT_MAX_MESSAGES = 6;
const DEFAULT_MAX_RALPH_CHARS = 1200;

function trimText(text, maxChars = DEFAULT_TEXT_MAX_CHARS) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function normalizeMessageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => normalizeMessageText(item))
      .filter(Boolean)
      .join("\n");
  }
  if (!content || typeof content !== "object") return "";
  if (typeof content.text === "string") return content.text;
  if (typeof content.content === "string") return content.content;
  if (typeof content.value === "string") return content.value;
  if (typeof content.message === "string") return content.message;
  if (typeof content.type === "string" && typeof content.text?.value === "string") return content.text.value;
  return "";
}

function readJsonlEntries(sessionFile) {
  if (typeof sessionFile !== "string" || !sessionFile.trim() || !fs.existsSync(sessionFile)) return [];
  const raw = fs.readFileSync(sessionFile, "utf8");
  if (!raw.trim()) return [];
  const entries = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Ignore malformed lines and salvage what we can from the rest of the file.
    }
  }
  return entries;
}

function extractEntryText(entry) {
  if (!entry || typeof entry !== "object") return "";
  if (typeof entry.content === "string") return entry.content;
  if (entry.message) return normalizeMessageText(entry.message.content);
  return normalizeMessageText(entry.content);
}

function summarizeEntry(entry) {
  const text = trimText(extractEntryText(entry));
  if (!text) return null;
  return {
    type: entry.type ?? "unknown",
    role: entry.message?.role ?? entry.role ?? null,
    customType: entry.customType ?? null,
    text,
    timestamp: entry.timestamp ?? null,
  };
}

export function readSessionHeader(sessionFile) {
  const entries = readJsonlEntries(sessionFile);
  const header = entries.find((entry) => entry?.type === "session");
  if (!header) return null;
  return {
    id: typeof header.id === "string" ? header.id : null,
    cwd: typeof header.cwd === "string" ? header.cwd : null,
    timestamp: typeof header.timestamp === "string" ? header.timestamp : null,
    parentSession: typeof header.parentSession === "string" ? header.parentSession : null,
  };
}

export function summarizeSessionFile(sessionFile, options = {}) {
  const expectedCwd = typeof options.expectedCwd === "string" ? options.expectedCwd : null;
  const maxMessages = Number.isInteger(options.maxMessages) ? Math.max(1, options.maxMessages) : DEFAULT_MAX_MESSAGES;
  const entries = readJsonlEntries(sessionFile);
  if (entries.length === 0) return null;

  const header = readSessionHeader(sessionFile);
  if (!header) return null;
  if (expectedCwd && header.cwd && header.cwd !== expectedCwd) return null;

  const relevant = entries
    .map((entry) => summarizeEntry(entry))
    .filter(Boolean);
  const recentMessages = relevant.slice(-maxMessages);
  const latestRalphIterationEntry = [...entries]
    .reverse()
    .find((entry) => entry?.type === "custom_message" && entry?.customType === "ralph-iteration" && extractEntryText(entry).trim());
  const lastAssistantEntry = [...entries]
    .reverse()
    .find((entry) => entry?.type === "message" && entry?.message?.role === "assistant" && extractEntryText(entry).trim());
  const lastUserEntry = [...entries]
    .reverse()
    .find((entry) => entry?.type === "message" && entry?.message?.role === "user" && extractEntryText(entry).trim());

  const latestRalphIteration = latestRalphIterationEntry
    ? trimText(extractEntryText(latestRalphIterationEntry), DEFAULT_MAX_RALPH_CHARS)
    : "";
  const lastAssistantMessage = lastAssistantEntry
    ? trimText(extractEntryText(lastAssistantEntry))
    : "";
  const lastUserMessage = lastUserEntry
    ? trimText(extractEntryText(lastUserEntry))
    : "";

  return {
    sessionFile,
    id: header.id,
    timestamp: header.timestamp,
    parentSession: header.parentSession,
    cwd: header.cwd,
    latestRalphIteration: latestRalphIteration || null,
    lastAssistantMessage: lastAssistantMessage || null,
    lastUserMessage: lastUserMessage || null,
    recentMessages,
  };
}

export function summarizeParentSessionContinuity(sessionFile, options = {}) {
  const header = readSessionHeader(sessionFile);
  const parentSession = header?.parentSession;
  if (!parentSession) return null;
  const summary = summarizeSessionFile(parentSession, options);
  if (!summary) return null;
  return {
    ...summary,
    sourceSessionFile: parentSession,
    currentSessionFile: sessionFile,
  };
}
