/**
 * Failure text for public logs. Actions logs and step summaries are public, so nothing leaves
 * before these rules ran over it. No dependencies: `scripts/process.ts` imports this before
 * anything is installed.
 *
 * What they cannot know stays possible: a bare name with no dot, such as a single-label host or a
 * database's name, prints as written.
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
 * Runs over whole output, so a value that spans lines is still found.
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
// Source file endings that are not top-level domains, so `worker.ts` is a file and `docs.example.md` a host.
const fileType = "(?!(?:[cm]?[jt]sx?|jsonc?|ya?ml|toml|lock|sql|css|html|txt|log|patch)(?![a-z]))";
const host = (lastLabel: string) =>
  new RegExp(
    `(?<![\\w$.-])${apiName}(?:[a-z0-9-]+\\.)+${fileType}${lastLabel}(?::\\d+)?(?![\\w$-]|\\.[a-z])`,
    "giu",
  );
const hostPattern = host("[a-z]{2,}");
// In text this repository wrote, `bindings.PoolRuntimeBlue` is a property path, so only a name that
// ends in a domain in common use is taken for a host.
const knownHostPattern = host(
  "(?:com|net|org|io|dev|app|cloud|co|ai|sh|run|tech|xyz|info|eu|de|ch|uk|us|internal|local|lan|corp|invalid|test|example)",
);
// Alchemy's resource types, such as `Cloudflare.Worker`: every label starts with a capital. A host
// written that way would stay too; hosts are written in lower case.
const typeName = /^(?:[A-Z][A-Za-z0-9]*\.)+[A-Z][A-Za-z0-9]*$/u;

function scrub(text: string, environment: NodeJS.ProcessEnv, written: boolean, limit: number) {
  let result = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>]+/giu, "[url]");
  // The same without a scheme; a comment's `// ` is followed by a space.
  result = result.replace(/(?<![:/\w])\/\/[^\s"'`<>/][^\s"'`<>]*/gu, "[url]");
  if (!written)
    // A pair, else an unmatched opening quote through the end. In-word apostrophes (can't) never open.
    result = result.replace(
      /("[^"]*"|`[^`]*`|(?<![\p{L}\p{N}])'[^']*')|(?:["`]|(?<![\p{L}\p{N}])')[\s\S]*$/gu,
      (quoted, pair: string | undefined) =>
        pair !== undefined && pair.slice(1, -1) === "[url]" ? quoted : "[value]",
    );
  return (
    redactCredentials(result, environment)
      .replace(/[^\s@<>()[\]"'`,;:]+@[^\s@<>()[\]"'`,;:]+\.[a-z]{2,}/giu, "[email]")
      .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b|\[[0-9a-f:]+\](?::\d+)?/giu, "[address]")
      .replace(
        /(?<![\w:.])(?=[0-9a-f:]*[0-9a-f])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/giu,
        "[address]",
      )
      .replace(written ? knownHostPattern : hostPattern, (name) =>
        typeName.test(name) ? name : "[host]",
      )
      // A home directory names a person.
      .replace(/\/(?:Users|home)\/[^/\s"'`]+/gu, "~")
      .replace(/\p{Cc}/gu, " ")
      // The Actions runner reads `::name::` at the start of a line and `##[name]` as commands.
      .replace(/^(\s*):(?=:)/u, "$1: ")
      .replaceAll("##[", "# #[")
      .slice(0, limit)
  );
}

/**
 * One line of text this repository did not write, such as an error's message or a line of a
 * command's output: what happened, without where or with what. Quoted values go too.
 */
export const publicText = (text: string, environment: NodeJS.ProcessEnv = process.env): string =>
  scrub(text, environment, false, 512);

/**
 * One line this repository wrote for the log, such as a refusal's reason or fix. Its wording and
 * quoted names stay; credentials, URLs, hosts, addresses and emails that reached it still go.
 */
export const publicGuidance = (
  text: string,
  environment: NodeJS.ProcessEnv = process.env,
): string => scrub(text, environment, true, 1024);

/** The last lines of a command's output, each made public on its own. */
export function publicTail(output: string, environment: NodeJS.ProcessEnv = process.env): string {
  return redactCredentials(output, environment)
    .trimEnd()
    .split("\n")
    .slice(-tailLines)
    .map((line) => publicText(line, environment).trimEnd())
    .join("\n");
}
