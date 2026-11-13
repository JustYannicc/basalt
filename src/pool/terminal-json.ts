/** Incremental JSON validation. Only protocol envelope fields survive a token; content is discarded. */
export class TerminalJson {
  private frames: { kind: "object" | "array"; state: string; path: string; key: string }[] = [];
  private root = "value";
  private token: "string" | "scalar" | undefined;
  private text = "";
  private overflow = false;
  private escape = false;
  private unicode = 0;
  private invalid = false;
  private firstType: string | undefined;
  private scalarState = "";
  private literal = "";
  private scalarLength = 0;
  readonly fields: Record<string, string> = {};

  push(text: string) {
    for (const char of text) {
      if (this.invalid) return;
      if (this.token === "string") {
        if (this.unicode) {
          if (!/[a-f0-9]/i.test(char)) this.invalid = true;
          this.unicode--;
        } else if (this.escape) {
          if (char === "u") this.unicode = 4;
          else if (!'"\\/bfnrt'.includes(char)) this.invalid = true;
          this.escape = false;
        } else if (char === "\\") this.escape = true;
        else if (char === '"') {
          this.token = undefined;
          let value = "";
          if (!this.overflow) {
            try {
              value = JSON.parse(`"${this.text}"`);
              if (value.length > 256) value = "";
            } catch {
              this.invalid = true;
            }
          }
          const frame = this.frames.at(-1);
          if (frame?.kind === "object" && ["key", "first-key"].includes(frame.state)) {
            frame.key = value;
            frame.state = "colon";
          } else this.value(value);
          continue;
        } else if (char.charCodeAt(0) < 32) this.invalid = true;
        this.append(char);
        continue;
      }
      if (this.token === "scalar") {
        if (!/[ \t\r\n,}\]]/.test(char)) {
          this.scalarChar(char);
          continue;
        }
        this.scalar();
      }
      if (/[ \t\r\n]/.test(char)) continue;
      const frame = this.frames.at(-1);
      const state = frame?.state ?? this.root;
      if (char === '"') {
        if (!["value", "first-value", "key", "first-key"].includes(state)) this.invalid = true;
        this.token = "string";
        this.text = "";
        this.overflow = false;
      } else if (char === ":") {
        if (state !== "colon") this.invalid = true;
        else frame!.state = "value";
      } else if (char === ",") {
        if (state !== "comma") this.invalid = true;
        else frame!.state = frame!.kind === "object" ? "key" : "value";
      } else if (char === "}" || char === "]") {
        if (
          !frame ||
          frame.kind !== (char === "}" ? "object" : "array") ||
          !["comma", "first-key", "first-value"].includes(state)
        )
          this.invalid = true;
        else this.frames.pop();
      } else if (char === "{" || char === "[") {
        const path = this.path();
        this.value("object");
        // Match encoding/json's bound, including ignored nested request/response content.
        if (this.frames.length >= 10_000) this.invalid = true;
        else
          this.frames.push({
            kind: char === "{" ? "object" : "array",
            state: char === "{" ? "first-key" : "first-value",
            path,
            key: "",
          });
      } else {
        if (!["value", "first-value"].includes(state)) this.invalid = true;
        this.token = "scalar";
        this.text = "";
        this.overflow = false;
        this.scalarState = "";
        this.literal = "";
        this.scalarLength = 0;
        this.scalarChar(char);
      }
    }
  }

  end(): boolean {
    if (this.token === "scalar") this.scalar();
    return !this.invalid && !this.token && !this.frames.length && this.root === "done";
  }

  requestType() {
    return this.firstType;
  }

  private append(char: string) {
    // A 256-character envelope value may encode every character as \uXXXX.
    if (this.text.length < 1536) this.text += char;
    else this.overflow = true;
  }
  private path() {
    const frame = this.frames.at(-1);
    if (!frame) return "";
    if (frame.kind === "array") return "*";
    // Only root envelope fields and the response envelope have protocol meaning.
    if (frame.path === "")
      return ["type", "status", "id", "response_id", "request_id", "error", "response"].includes(
        frame.key,
      )
        ? frame.key
        : "*";
    return frame.path === "response" && ["id", "status"].includes(frame.key)
      ? `response.${frame.key}`
      : "*";
  }
  private value(value: string) {
    const frame = this.frames.at(-1);
    if (!["value", "first-value"].includes(frame?.state ?? this.root)) {
      this.invalid = true;
      return;
    }
    const path = this.path();
    if (path === "type" && this.firstType === undefined) this.firstType = value;
    if (
      [
        "type",
        "status",
        "id",
        "response.id",
        "response.status",
        "response_id",
        "request_id",
      ].includes(path)
    )
      this.fields[path] = value;
    if (path === "error" && value !== "null") this.fields.error = "present";
    if (frame) frame.state = "comma";
    else this.root = "done";
  }
  private scalarChar(char: string) {
    this.append(char);
    if (this.scalarLength++ === 0) {
      this.literal = char === "n" ? "null" : char === "t" ? "true" : char === "f" ? "false" : "";
      this.scalarState = this.literal
        ? "literal"
        : char === "-"
          ? "minus"
          : char === "0"
            ? "zero"
            : /[1-9]/.test(char)
              ? "integer"
              : "invalid";
      return;
    }
    const digit = /[0-9]/.test(char);
    const state = this.scalarState;
    if (state === "literal") {
      if (this.literal[this.scalarLength - 1] !== char) this.scalarState = "invalid";
    } else if (state === "minus")
      this.scalarState = char === "0" ? "zero" : /[1-9]/.test(char) ? "integer" : "invalid";
    else if (state === "integer" && digit) return;
    else if ((state === "zero" || state === "integer") && char === ".") this.scalarState = "dot";
    else if (["zero", "integer", "fraction"].includes(state) && /[eE]/.test(char))
      this.scalarState = "exponent";
    else if (["dot", "fraction"].includes(state) && digit) this.scalarState = "fraction";
    else if (state === "exponent" && /[+-]/.test(char)) this.scalarState = "exponent-sign";
    else if (["exponent", "exponent-sign", "exponent-digits"].includes(state) && digit)
      this.scalarState = "exponent-digits";
    else this.scalarState = "invalid";
  }
  private scalar() {
    this.token = undefined;
    if (
      !(this.scalarState === "literal"
        ? this.scalarLength === this.literal.length
        : ["zero", "integer", "fraction", "exponent-digits"].includes(this.scalarState))
    )
      this.invalid = true;
    this.value(this.overflow ? "number" : this.text);
  }
}
