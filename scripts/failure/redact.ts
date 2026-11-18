/**
 * Failure text for public logs. Actions logs and step summaries are public, so a failure shows a
 * bounded tail with credentials removed, and anything that leaves as a message also loses URLs,
 * hosts, addresses, emails and quoted values. No dependencies: `scripts/process.ts` imports this
 * before anything is installed.
 */
const maximumBytes = 64 * 1024;
const tailLines = 60;
const minimumEnvironmentValue = 8;
const credentialName = /SECRET|TOKEN|KEY|PASSWORD|DSN|CLIENT_ID|DATABASE_URL|CREDENTIAL/i;

/** The last output of a command, bounded while it runs. */
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

/**
 * Removes the values of credential-named environment variables, URL userinfo, bearer and basic
 * credentials, password/secret/token key-value pairs, and long runs mixing letters and digits.
 */
export function redactCredentials(output: string, environment: NodeJS.ProcessEnv): string {
  let text = stripAnsi(output);
  const values = Object.entries(environment)
    .filter(([name]) => credentialName.test(name))
    .flatMap(([, value]) => (typeof value === "string" ? [value, value.trim()] : []))
    .filter((value) => value.trim().length >= minimumEnvironmentValue)
    .sort((left, right) => right.length - left.length);
  for (const value of values) text = text.split(value).join("[redacted]");
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

// Fetch and JavaScript global names that look like hosts in messages such as `Headers.append: ...`.
const apiName =
  "(?!(?:Headers|Request|Response|URL|URLSearchParams|FormData|Blob|File|ReadableStream|WritableStream|AbortSignal|AbortController|JSON|Object|Array|Promise|Buffer|Reflect|Symbol)\\.)";
// A lower-case last label that is not a file's: `Cloudflare.Worker` and `src/pool/worker.ts` stay.
const fileType =
  "(?!(?:[cm]?[jt]sx?|json|jsonc|map|md|ya?ml|toml|lock|sh|py|go|sql|c4|css|html|txt|log|patch)(?![a-z]))";
const hostPattern = new RegExp(
  `(?<![\\w$./-])${apiName}(?:[A-Za-z0-9-]+\\.)+${fileType}[a-z]{2,}(?::\\d+)?(?![\\w$-]|\\.[A-Za-z])`,
  "gu",
);

/** One line that may leave the process: what happened, without where or with what. */
export function publicText(text: string, environment: NodeJS.ProcessEnv = process.env): string {
  return redactCredentials(
    text
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>]+/giu, "[url]")
      // The same without a scheme; a comment's `// ` is followed by a space.
      .replace(/(?<![:/\w])\/\/[^\s"'`<>/][^\s"'`<>]*/gu, "[url]")
      // A pair, else an unmatched opening quote through the end. In-word apostrophes (can't) never open.
      .replace(
        /("[^"]*"|`[^`]*`|(?<![\p{L}\p{N}])'[^']*')|(?:["`]|(?<![\p{L}\p{N}])')[\s\S]*$/gu,
        (quoted, pair: string | undefined) =>
          pair !== undefined && pair.slice(1, -1) === "[url]" ? quoted : "[value]",
      ),
    environment,
  )
    .replace(/[^\s@<>()[\]"'`,;:]+@[^\s@<>()[\]"'`,;:]+\.[a-z]{2,}/giu, "[email]")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b|\[[0-9a-f:]+\](?::\d+)?/giu, "[address]")
    .replace(
      /(?<![\w:.])(?=[0-9a-f:]*[0-9a-f])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/giu,
      "[address]",
    )
    .replace(hostPattern, "[host]")
    .replace(/\p{Cc}/gu, " ")
    .slice(0, 512);
}

/** The last lines of a command's output, each made public on its own. */
export function publicTail(output: string, environment: NodeJS.ProcessEnv = process.env): string {
  return stripAnsi(output)
    .trimEnd()
    .split("\n")
    .slice(-tailLines)
    .map((line) => publicText(line, environment).trimEnd())
    .join("\n");
}
