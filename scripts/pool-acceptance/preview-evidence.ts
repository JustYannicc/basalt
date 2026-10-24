import { isObject } from "./types.ts";

export type NativeClient = "claude" | "codex";

function parseJsonLines(stdout: string): Record<string, unknown>[] | undefined {
  const lines = stdout.split(/\r?\n/).filter(line => line.length > 0);
  if (!lines.length) return undefined;
  try {
    const events: Record<string, unknown>[] = [];
    for (const line of lines) {
      const value: unknown = JSON.parse(line);
      if (!isObject(value)) return undefined;
      events.push(value);
    }
    return events;
  } catch { return undefined; }
}

function expectedSearchArguments(value: unknown): boolean {
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { return false; }
  }
  if (!isObject(parsed)) return false;
  return Object.keys(parsed).length === 2 && parsed.query === "pool" && parsed.limit === 1;
}

export function hasNativePreviewEvidence(client: NativeClient, stdout: string, serverName: string, marker: string): boolean {
  const events = parseJsonLines(stdout);
  if (!events) return false;
  if (client === "claude") {
    let toolIndex = -1, finalIndex = -1;
    let finalReply: string | undefined;
    for (const [index, event] of events.entries()) {
      if (event.type === "assistant" && isObject(event.message) && Array.isArray(event.message.content)) {
        if (toolIndex < 0 && event.message.content.some(block => isObject(block) && block.type === "tool_use"
          && block.name === `mcp__${serverName}__search` && expectedSearchArguments(block.input))) toolIndex = index;
      }
      if (event.type === "result" && typeof event.result === "string") { finalIndex = index; finalReply = event.result; }
    }
    return toolIndex >= 0 && finalIndex > toolIndex && finalReply === marker;
  }
  let toolIndex = -1, finalIndex = -1;
  let finalReply: string | undefined;
  for (const [index, event] of events.entries()) {
    if (event.type !== "item.completed" || !isObject(event.item)) continue;
    if (event.item.type === "mcp_tool_call" && event.item.server === serverName
      && event.item.tool === "search" && event.item.status === "completed"
      && expectedSearchArguments(event.item.arguments) && toolIndex < 0) toolIndex = index;
    if (event.item.type === "agent_message" && typeof event.item.text === "string") {
      finalIndex = index; finalReply = event.item.text;
    }
  }
  return toolIndex >= 0 && finalIndex > toolIndex && finalReply === marker;
}
