import { TerminalJson } from "./terminal-json.ts";

export type TerminalOutcome =
  | "complete"
  | "truncated"
  | "client_closed"
  | "provider_failed"
  | "unavailable";

export type TerminalCompletion = "model" | "delivery";

type Protocol = "messages" | "responses" | "chat" | "image-generation" | "image-edit";

export function protocolOutcome(
  fields: Record<string, string>,
  protocol?: Protocol,
): "complete" | "provider_failed" | undefined {
  if (
    fields.error ||
    ["error", "response.failed", "response.incomplete"].includes(fields.type ?? "") ||
    [fields.status, fields["response.status"]].some(
      (value) => value === "failed" || value === "incomplete",
    )
  )
    return "provider_failed";
  if (
    (protocol === "image-generation" && fields.type === "image_generation.completed") ||
    (protocol === "image-edit" && fields.type === "image_edit.completed")
  )
    return "complete";
  if (fields.type === "message_stop" && (protocol === undefined || protocol === "messages"))
    return "complete";
  if (fields.type === "response.completed" && (protocol === undefined || protocol === "responses"))
    return "complete";
}

/** SSE fields are streamed, including large response.completed events. No event/body is buffered. */
export class TerminalProtocol {
  private decoder = new TextDecoder();
  private json = new TerminalJson();
  private field = "";
  private fieldValue = false;
  private skipSpace = false;
  private lineLength = 0;
  private cr = false;
  private data = "";
  private dataLong = false;
  private event = "";
  private hasData = false;
  private terminal: "complete" | "provider_failed" | undefined;
  private bytes = 0;
  private readonly completion: TerminalCompletion;
  private readonly format: "sse" | "json" | "body";
  private readonly status: number;
  private readonly protocol: Protocol | undefined;
  constructor(
    format: "sse" | "json" | "body",
    status: number,
    pathname: string,
    completion: TerminalCompletion,
  ) {
    this.format = format;
    this.completion = completion;
    this.status = status;
    this.protocol =
      pathname === "/v1/images/generations"
        ? "image-generation"
        : pathname === "/v1/images/edits"
          ? "image-edit"
          : pathname.endsWith("/messages")
            ? "messages"
            : pathname.endsWith("/responses")
              ? "responses"
              : pathname.endsWith("/completions")
                ? "chat"
                : undefined;
  }

  push(value: Uint8Array) {
    this.bytes += value.byteLength;
    if (this.format === "body") return;
    const text = this.decoder.decode(value, { stream: true });
    if (this.format === "json") this.json.push(text);
    else this.sseText(text);
  }
  finish(): { outcome: TerminalOutcome; bytes: number } {
    if (this.format === "body")
      return { outcome: this.status >= 400 ? "provider_failed" : "complete", bytes: this.bytes };
    const tail = this.decoder.decode();
    if (this.format === "json") {
      this.json.push(tail);
      const valid = this.json.end();
      return {
        outcome:
          this.status >= 400
            ? "provider_failed"
            : !valid
              ? "truncated"
              : this.completion === "delivery"
                ? "complete"
                : (protocolOutcome(this.json.fields) ?? "complete"),
        bytes: this.bytes,
      };
    }
    this.sseText(tail);
    // An unterminated SSE event is not dispatched by clients, even if it contains a terminal name.
    return {
      outcome: this.status >= 400 ? "provider_failed" : (this.terminal ?? "truncated"),
      bytes: this.bytes,
    };
  }
  count() {
    return this.bytes;
  }
  observed() {
    // Image events complete individual images. EOF ends a batch, so its first image cannot finish the request.
    if (
      this.terminal === "complete" &&
      ["image-generation", "image-edit"].includes(this.protocol ?? "")
    )
      return undefined;
    return this.terminal
      ? this.status >= 400
        ? ("provider_failed" as const)
        : this.terminal
      : undefined;
  }

  private sseText(text: string) {
    for (const char of text) {
      if (this.cr && char === "\n") {
        this.cr = false;
        continue;
      }
      this.cr = char === "\r";
      if (char === "\n" || char === "\r") {
        if (this.lineLength === 0) this.dispatch();
        else if (this.field === "data" && this.fieldValue) {
          this.json.push("\n");
          if (this.data.length < 16) this.data += "\n";
          else this.dataLong = true;
        }
        this.field = "";
        this.fieldValue = false;
        this.skipSpace = false;
        this.lineLength = 0;
        continue;
      }
      this.lineLength++;
      if (!this.fieldValue) {
        if (char === ":") {
          this.fieldValue = true;
          this.skipSpace = true;
          if (this.field === "event") this.event = "";
        } else if (this.field.length < 16) this.field += char;
        continue;
      }
      if (this.skipSpace) {
        this.skipSpace = false;
        if (char === " ") continue;
      }
      if (this.field === "event") {
        if (this.event.length < 64) this.event += char;
      }
      if (this.field === "data") {
        this.hasData = true;
        this.json.push(char);
        if (this.data.length < 16) this.data += char;
        else this.dataLong = true;
      }
    }
  }
  private dispatch() {
    if (this.hasData) {
      const valid = this.json.end();
      const outcome =
        !this.dataLong && this.data.trim() === "[DONE]" && this.protocol === "chat"
          ? "complete"
          : valid
            ? protocolOutcome(this.json.fields, this.protocol)
            : undefined;
      // A protocol error cannot be cleared by a later terminator.
      if (this.terminal !== "provider_failed" && outcome) this.terminal = outcome;
      if (this.event === "error") this.terminal = "provider_failed";
    }
    this.json = new TerminalJson();
    this.data = "";
    this.dataLong = false;
    this.event = "";
    this.hasData = false;
  }
}
