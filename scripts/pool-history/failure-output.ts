/**
 * Failure output for release subprocesses. Actions logs are public, so a failed command shows only a
 * bounded tail with credentials removed: the values of credential-named environment variables, URL
 * userinfo, bearer and basic credentials, password/secret/token key-value pairs, and long runs mixing
 * letters and digits. GitHub's own masking of
 * Actions secrets still applies on top.
 */
const maximumBytes = 64 * 1024;
const tailLines = 60;
const minimumEnvironmentValue = 8;
export const credentialName = /SECRET|TOKEN|KEY|PASSWORD|DSN|CLIENT_ID|DATABASE_URL|CREDENTIAL/i;

export class OutputTail {
  private chunks: Buffer[] = [];
  private size = 0;
  private truncated = false;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > maximumBytes && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.length;
      this.truncated = true;
    }
  }

  /** A window that starts mid-line could start mid-secret, so a truncated tail drops its first partial line. */
  text(): string {
    let text = Buffer.concat(this.chunks).toString("utf8");
    if (text.length > maximumBytes) {
      text = text.slice(-maximumBytes);
      this.truncated = true;
    }
    if (!this.truncated) return text;
    const newline = text.indexOf("\n");
    return `[truncated]\n${newline === -1 ? "" : text.slice(newline + 1)}`;
  }
}

const stripAnsi = (text: string) =>
  text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g"), "");

export function redactFailureOutput(output: string, environment: NodeJS.ProcessEnv): string {
  const values = Object.entries(environment).flatMap(([name, value]) =>
    credentialName.test(name) &&
    typeof value === "string" &&
    value.trim().length >= minimumEnvironmentValue
      ? [value]
      : [],
  );
  return redactCredentialText(output, values).trimEnd().split("\n").slice(-tailLines).join("\n");
}

/** A value as it may appear in text: as written, trimmed, JSON-escaped and URL-encoded. */
const writtenForms = (value: string) => [
  value,
  value.trim(),
  JSON.stringify(value).slice(1, -1),
  encodeURIComponent(value),
];

/**
 * Text with the given values (in every written form) and credential shapes taken out: URL userinfo,
 * bearer and basic credentials, password/secret/token key-value pairs, and long runs mixing letters
 * and digits.
 */
export function redactCredentialText(output: string, values: readonly string[]): string {
  const source = stripAnsi(output);
  const forms = [...new Set(values.flatMap(writtenForms))].filter((form) => form.trim() !== "");
  // Every match on the original text, merged, so two overlapping values are both taken out whole.
  const ranges: [number, number][] = [];
  for (const form of forms)
    for (let at = source.indexOf(form); at !== -1; at = source.indexOf(form, at + 1))
      ranges.push([at, at + form.length]);
  ranges.sort((left, right) => left[0] - right[0] || right[1] - left[1]);
  let text = "";
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (end <= cursor) continue;
    if (start >= cursor) text += `${source.slice(cursor, start)}[redacted]`;
    cursor = end;
  }
  text += source.slice(cursor);
  return text
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi, "$1[redacted]@")
    .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [redacted]")
    .replace(
      /(\w*(?:pass(?:word)?|pwd|secret|token|api[_-]?key)["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"'&,;}]+)/gi,
      "$1[redacted]",
    )
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, (run) =>
      /\d/.test(run) && /[A-Za-z]/.test(run) ? "[redacted]" : run,
    );
}

/** Recognize the provider's startup CPU refusal without forwarding its payload. */
export function isScriptStartupCpuLimit(output: string): boolean {
  const text = stripAnsi(output);
  return (
    /\bScriptStartupError\b/.test(text) && /\bScript startup exceeded CPU time limit\b/i.test(text)
  );
}
