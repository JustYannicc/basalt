/**
 * Failure text for public logs. Actions logs and step summaries are public, so nothing leaves
 * before these rules ran over it. No dependencies: `scripts/process.ts` imports this before
 * anything is installed.
 *
 * The rules are the release barrier's, kept per kind of text:
 * - an error's message from fetch, a provider or the runtime (`publicText`): credentials, URLs,
 *   addresses, quoted values and every dotted name go, so it says what happened without where or
 *   with what;
 * - a command's output (`publicTail`): credentials by value and by shape, and also URLs, emails,
 *   addresses and home directories. File names, property paths and quoted names stay, because a
 *   tail exists to show them. So does a hostname written bare, which no rule can tell from them;
 * - a line this repository wrote (`publicGuidance`): the output rules, except that content
 *   digests, commits and ids stay and a keyword in a sentence is not read as a credential's name.
 */
type Text = "message" | "output" | "written";
const maximumBytes = 64 * 1024;
/** The lines of one stream a failure keeps. */
export const tailLines = 60;
/** The rules run over a bounded line, so none of them can be made slow. */
const inputLimit = 4096;
const minimumEnvironmentValue = 8;
/** An environment variable whose value is removed wherever it appears. */
export const credentialName =
  /SECRET|TOKEN|KEY|PASS|PWD|AUTH|COOKIE|DSN|CLIENT_ID|DATABASE_URL|CREDENTIAL/i;

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
 * The values of credential-named environment variables. They can span lines, so this runs first.
 * Such a value seldom arrives whole: a tool prefixes each line, a window cuts its start off, JSON
 * writes its line ends as `\n`. So each of its lines and its JSON form go too.
 */
function withoutEnvironmentValues(text: string, environment: NodeJS.ProcessEnv): string {
  const values = Object.entries(environment)
    .filter(([name]) => credentialName.test(name))
    .flatMap(([, value]) =>
      typeof value === "string"
        ? [value, JSON.stringify(value).slice(1, -1), ...value.split("\n")].map((part) =>
            part.trim(),
          )
        : [],
    )
    .filter((value) => value.length >= minimumEnvironmentValue)
    .sort((left, right) => right.length - left.length);
  for (const value of new Set(values)) text = text.split(value).join("[redacted]");
  return text;
}

// Content digests, commit hashes and operation ids are evidence a refusal exists to show.
const digest =
  /^(?:sha(?:1|256|384|512)-|[a-z]{2,16}=)?(?:[0-9a-f]{40}|[0-9a-f]{64}|[0-9a-f]{96}|[0-9a-f]{128}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/iu;
const sourceEnding = /^\.(?:[cm]?[jt]sx?|json|go|rs|py|sh|md|ya?ml|toml|sql|css|html|c4)$/u;
// A credential's name, with whatever follows the word: `token`, `password_file`, `secret-access-key`.
const named = "(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|auth[_-]?key)[\\w-]*";
// A quoted value, whose quotes can be escaped (JSON inside JSON) and whose end a cut can take; else
// everything up to a space. A password may hold any punctuation, so none ends the value.
const quoted = `\\\\?"[^"\\n]*"?|\\\\?'[^'\\n]*'?`;
const value = `(${quoted}|[^\\s"']+)`;
const namedValue = new RegExp(`(${named}\\\\?["']?\\s*[:=]\\s*)${value}`, "gi");
// In a sentence a colon follows a word all the time: only `=` or a quoted value marks a credential.
const namedValueWritten = new RegExp(
  `(${named}\\\\?["']?\\s*(?:=\\s*|:\\s*(?=\\\\?["'])))${value}`,
  "gi",
);
// Tried only from where a flag starts and over a bounded name, so a long run of dashes and names
// costs no more than its length. Another flag is never the value.
const flagValue = new RegExp(
  `((?<![\\w-])--[\\w-]{0,64}?${named}[\\s=]+)(?!--)(?:${quoted}|\\S+)`,
  "gi",
);
// An environment assignment whose name says it holds a credential: `STRIPE_KEY=…`.
const assigned = new RegExp(`(?<![A-Za-z0-9_])([A-Z][A-Z0-9_]{1,63}=)${value}`, "g");
// Tokens that say what they are, whatever characters follow: GitHub, Slack, AWS and `sk-` keys.
const prefixed = /\b(?:gh[pousr]_|github_pat_|xox[abprs]-|sk-|AKIA|ASIA)[A-Za-z0-9_-]{16,}/g;

/** Credentials by shape: userinfo, credential headers, bearer and basic, named values, long mixed runs. */
function withoutCredentialShapes(text: string, kind: Text): string {
  const written = kind === "written";
  let result = text
    .replace(/([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/]*@/gi, "$1[redacted]@")
    // The same with no scheme, and a name whose `@` is written `%40`.
    .replace(/(?<![^\s"'=(])[^\s/"'=@:]+:[^\s"'@]+@(?=[\p{L}\p{N}[])/gu, "[redacted]@")
    .replace(/(?<![^\s/"'=])[^\s/"'=]*%40[^\s/"'=:@]*/gi, "[redacted]");
  // A header's value runs to the end of its line, whatever scheme it names.
  if (!written)
    result = result.replace(
      /\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key)\b(["']?\s*[:=]\s*)[^\n]*/gi,
      "$1$2[redacted]",
    );
  return result
    .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [redacted]")
    .replace(prefixed, "[redacted]")
    .replace(flagValue, "$1[redacted]")
    .replace(written ? namedValueWritten : namedValue, "$1[redacted]")
    .replace(assigned, (found, name: string) =>
      credentialName.test(name) ? `${name}[redacted]` : found,
    )
    .replace(
      /[A-Za-z0-9+/_=-]{32,}(\.[A-Za-z0-9]{1,5}(?![A-Za-z0-9]))?/g,
      (found, ending: string | undefined) => {
        const run = ending ? found.slice(0, -ending.length) : found;
        if (!/\d/.test(run) || !/[A-Za-z]/.test(run)) return found;
        // A long path with a digit in it names a source file: `src/v2/handlers/threads.ts`.
        if (ending && run.includes("/") && sourceEnding.test(ending)) return found;
        return written && digest.test(run) ? found : `[redacted]${ending ?? ""}`;
      },
    );
}

/** A command's name or a link: credentials go, the rest stays. */
export const redactCredentials = (output: string, environment: NodeJS.ProcessEnv): string =>
  withoutCredentialShapes(withoutEnvironmentValues(stripAnsi(output), environment), "output");

// Fetch and JavaScript globals in messages such as `Headers.append: invalid value`.
const globals = new Set(
  "Headers Request Response URL URLSearchParams FormData Blob File ReadableStream WritableStream AbortSignal AbortController JSON Object Array Promise Buffer Reflect Symbol".split(
    " ",
  ),
);
const dottedName =
  /(?<![\p{L}\p{N}_$.-])(?:[\p{L}\p{N}_-]+\.)+\p{L}{2,}(?::\d+)?(?![\p{L}\p{N}_$-])/gu;

/** A word the cut divided could be half a key, so the cut falls back to the last whole word. */
function bounded(text: string): string {
  if (text.length <= inputLimit) return text;
  let end = inputLimit;
  while (end > 0 && !/\s/u.test(text[end - 1]!)) end--;
  return `${text.slice(0, end)}[cut]`;
}

function scrub(text: string, environment: NodeJS.ProcessEnv, kind: Text, limit: number): string {
  // Whole values first: a cut could leave half of one behind.
  let result = bounded(withoutEnvironmentValues(stripAnsi(text), environment))
    .replace(/[a-z][a-z0-9+.-]{0,31}:\/\/[^\s"'`<>]+/giu, "[url]")
    // The same without a scheme; a comment's `// ` is followed by a space.
    .replace(/(?<![:/\w])\/\/[^\s"'`<>/][^\s"'`<>]*/gu, "[url]");
  if (kind === "message")
    // A pair, else an unmatched opening quote through the end. In-word apostrophes (can't) never open.
    result = result.replace(
      /("[^"]*"|`[^`]*`|(?<![\p{L}\p{N}])'[^']*')|(?:["`]|(?<![\p{L}\p{N}])')[\s\S]*$/gu,
      (quoted, pair: string | undefined) =>
        pair !== undefined && pair.slice(1, -1) === "[url]" ? quoted : "[value]",
    );
  result = withoutCredentialShapes(result, kind)
    // Neither part holds a `/`, `=`, `&` or `|`: a package path such as `effect@4.0.1/dist/x.js`
    // is no address, and two addresses in one query string are two.
    .replace(
      /(?<![^\s@<>()[\]"'`,;:&=/|])[^\s@<>()[\]"'`,;:&=/|]+@[^\s@<>()[\]"'`,;:&=/|]+\.[a-z]{2,}/giu,
      "[email]",
    )
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/gu, "[address]")
    // A clock time is three numbers too: an address has a hex letter, a `::` or five groups.
    // The same in brackets, so `[00:22:03]` and `items[0]` stay.
    .replace(
      /(?<![\w:.])(?=[0-9a-f:]*(?:[a-f]|::)|(?:[0-9a-f]{1,4}:){4})(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:-])/giu,
      "[address]",
    )
    .replace(/\[\[address\]\](?::\d+)?/gu, "[address]");
  if (kind === "message")
    result = result.replace(dottedName, (name) => {
      const labels = name.split(".");
      return labels.length === 2 && globals.has(labels[0]!) ? name : "[host]";
    });
  result = result
    // A home directory names a person.
    .replace(/\/(?:Users|home)\/[^/\s"'`]+/gu, "~")
    .replace(/[\p{Cc}\u2028\u2029]/gu, " ")
    // The Actions runner reads `::name::` at the start of a line and `##[name]` as commands.
    .replace(/^(\s*):(?=:)/u, "$1: ")
    .replaceAll("##[", "# #[");
  return result.length > limit ? `${result.slice(0, limit - 5)}[cut]` : result;
}

/** One line of an error's message that this repository did not write. */
export const publicText = (text: string, environment: NodeJS.ProcessEnv = process.env): string =>
  scrub(text, environment, "message", 512);

/** One line this repository wrote for the log: a refusal's reason, fix or evidence. */
export const publicGuidance = (
  text: string,
  environment: NodeJS.ProcessEnv = process.env,
): string => scrub(text, environment, "written", 1024);

/**
 * Output that is one thing over several lines, such as a command line. It is made one line before
 * the rules run, so a flag and its value on two lines are still read together.
 */
export const publicLine = (text: string, environment: NodeJS.ProcessEnv = process.env): string =>
  scrub(
    withoutEnvironmentValues(stripAnsi(text), environment)
      // A shell's line continuation is no part of the value that follows it.
      .replace(/\\\r?\n/gu, " ")
      .replace(/\s+/gu, " ")
      .trim(),
    environment,
    "output",
    512,
  );

/** The last lines of a command's output, each made public on its own. */
export function publicTail(
  output: string,
  environment: NodeJS.ProcessEnv = process.env,
  lines = tailLines,
): string {
  return withoutEnvironmentValues(stripAnsi(output), environment)
    .trimEnd()
    .split("\n")
    .slice(-lines)
    .map((line) => scrub(line, environment, "output", 512).trimEnd())
    .join("\n");
}
