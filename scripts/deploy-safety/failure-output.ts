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
const credentialName = /SECRET|TOKEN|KEY|PASSWORD|DSN|CLIENT_ID|DATABASE_URL|CREDENTIAL/i;

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

export function redactFailureOutput(output: string, environment: NodeJS.ProcessEnv): string {
  let text = output.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  const values = Object.entries(environment)
    .filter(([name]) => credentialName.test(name))
    .flatMap(([, value]) => (typeof value === "string" ? [value, value.trim()] : []))
    .filter((value) => value.trim().length >= minimumEnvironmentValue)
    .sort((left, right) => right.length - left.length);
  for (const value of values) text = text.split(value).join("[redacted]");
  text = text
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, "$1[redacted]@")
    .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [redacted]")
    .replace(/\b(pass(?:word)?|pwd|secret|token|api[_-]?key)(["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi, "$1$2[redacted]")
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, (run) => (/\d/.test(run) && /[A-Za-z]/.test(run) ? "[redacted]" : run));
  return text.trimEnd().split("\n").slice(-tailLines).join("\n");
}
