/**
 * Failure text for public logs. Actions logs and step summaries are public, so nothing leaves
 * before these rules ran over it. No dependencies: `scripts/process.ts` imports this before
 * anything is installed.
 *
 * The rules recognise shapes. What has no shape stays: a bare name with no dot (a single-label
 * host, a database's or a person's name), a two-label name under a country's or a newer domain,
 * and whatever a caller quotes inside text it wrote.
 */
const maximumBytes = 64 * 1024;
const tailLines = 60;
/** Input is cut before the rules run, so no line can make them slow. */
const inputLimit = 4096;
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

/** The values of credential-named environment variables. They can span lines, so this runs first. */
function withoutEnvironmentValues(text: string, environment: NodeJS.ProcessEnv): string {
  const values = Object.entries(environment)
    .filter(([name]) => credentialName.test(name))
    .flatMap(([, value]) => (typeof value === "string" ? [value, value.trim()] : []))
    .filter((value) => value.trim().length >= minimumEnvironmentValue)
    .sort((left, right) => right.length - left.length);
  for (const value of values) text = text.split(value).join("[redacted]");
  return text;
}

// Content digests, commit hashes and operation ids are evidence a refusal exists to show.
const digest = /^(?:[0-9a-f]{40}|[0-9a-f]{64}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/u;

/** Credentials by shape: userinfo, credential headers, bearer and basic, key=value, long mixed runs. */
function withoutCredentialShapes(text: string, keepDigests: boolean): string {
  return (
    text
      .replace(/([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/]*@/gi, "$1[redacted]@")
      // The same with no scheme, and a name whose `@` is written `%40`.
      .replace(/(?<![^\s"'=(])[^\s/"'=@:]+:[^\s/"'@]+@(?=[\p{L}\p{N}[])/gu, "[redacted]@")
      .replace(/(?<![^\s/"'=])[^\s/"'=]*%40[^\s/"'=:@]*/gi, "[redacted]")
      .replace(
        /\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key)\b(["']?\s*[:=]\s*)[^\n]*/gi,
        "$1$2[redacted]",
      )
      .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [redacted]")
      .replace(
        /((?:pass(?:word)?|pwd|secret|token|api[_-]?key)["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"'&,;}]+)/gi,
        "$1[redacted]",
      )
      .replace(/[A-Za-z0-9+/_=-]{32,}/g, (run) =>
        /\d/.test(run) && /[A-Za-z]/.test(run) && !(keepDigests && digest.test(run))
          ? "[redacted]"
          : run,
      )
  );
}

/** A command line or a name: credentials go, the rest stays. */
export const redactCredentials = (output: string, environment: NodeJS.ProcessEnv): string =>
  withoutCredentialShapes(withoutEnvironmentValues(stripAnsi(output), environment), false);

// Under these a dotted name is a host whatever its length.
const domains = new Set("com net org edu gov int internal local lan corp arpa".split(" "));
// Under a country's two letters or one of these, a host has a name in front of its domain. With
// two labels it is a property, a file or a public registration: `props.id`, `README.md`.
const longDomains = new Set("dev app cloud tech xyz site online".split(" "));
// Two-letter file endings that no country has, so `alchemy.run.ts` is never a host.
const sourceEndings = new Set("ts js go rb cs c4".split(" "));
const dottedName =
  /(?<![\p{L}\p{N}_$.-])(?:[\p{L}\p{N}_-]+\.)+\p{L}{2,24}(?::\d+)?(?![\p{L}\p{N}_$-])/gu;

function withoutHosts(text: string): string {
  return text.replace(dottedName, (name) => {
    const labels = name.replace(/:\d+$/u, "").split(".");
    // The longest leading part that ends in a domain is the host; what follows it stays.
    for (let length = labels.length; length >= 2; length--) {
      const last = labels[length - 1]!.toLowerCase();
      const domain =
        domains.has(last) ||
        (length > 2 && !sourceEndings.has(last) && (last.length === 2 || longDomains.has(last)));
      if (!domain) continue;
      const rest = labels.slice(length);
      return rest.length ? `[host].${rest.join(".")}` : "[host]";
    }
    return name;
  });
}

function scrub(text: string, environment: NodeJS.ProcessEnv, written: boolean, limit: number) {
  let result = withoutEnvironmentValues(stripAnsi(text.slice(0, inputLimit)), environment).replace(
    /[a-z][a-z0-9+.-]{0,31}:\/\/[^\s"'`<>]+/giu,
    "[url]",
  );
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
    withoutHosts(
      withoutCredentialShapes(result, written)
        .replace(
          /(?<![^\s@<>()[\]"'`,;:])[^\s@<>()[\]"'`,;:]+@[^\s@<>()[\]"'`,;:]+\.[a-z]{2,}/giu,
          "[email]",
        )
        .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b|\[[0-9a-f:]+\](?::\d+)?/giu, "[address]")
        // A clock time is three numbers too: an address has a hex letter or a `::`.
        .replace(
          /(?<![\w:.])(?=[0-9a-f:]*(?:[a-f]|::))(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:-])/giu,
          "[address]",
        ),
    )
      // A home directory names a person.
      .replace(/\/(?:Users|home)\/[^/\s"'`]+/gu, "~")
      .replace(/[\p{Cc}\u2028\u2029]/gu, " ")
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
 * One line this repository wrote for the log: a refusal's reason, fix or evidence. Its wording,
 * quoted names, digests and ids stay; credentials, URLs, hosts, addresses and emails still go.
 */
export const publicGuidance = (
  text: string,
  environment: NodeJS.ProcessEnv = process.env,
): string => scrub(text, environment, true, 1024);

/** The last lines of a command's output, each made public on its own. */
export function publicTail(output: string, environment: NodeJS.ProcessEnv = process.env): string {
  return withoutEnvironmentValues(stripAnsi(output), environment)
    .trimEnd()
    .split("\n")
    .slice(-tailLines)
    .map((line) => publicText(line, environment).trimEnd())
    .join("\n");
}
