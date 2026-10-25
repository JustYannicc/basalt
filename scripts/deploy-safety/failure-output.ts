/**
 * Failure output for release subprocesses. Actions logs are public, so a failed command shows only a
 * bounded tail with credentials removed: the values of credential-named environment variables, URL
 * userinfo, bearer and basic credentials, and long runs mixing letters and digits. GitHub's own masking of
 * Actions secrets still applies on top.
 */
const maximumBytes = 64 * 1024;
const tailLines = 60;
const minimumEnvironmentValue = 8;
const credentialName = /SECRET|TOKEN|KEY|PASSWORD|DSN|CLIENT_ID|DATABASE_URL|CREDENTIAL/i;

export class OutputTail {
  private chunks: Buffer[] = [];
  private size = 0;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > maximumBytes && this.chunks.length > 1) this.size -= this.chunks.shift()!.length;
  }

  text(): string {
    const joined = Buffer.concat(this.chunks).toString("utf8");
    return joined.length > maximumBytes ? joined.slice(-maximumBytes) : joined;
  }
}

export function redactFailureOutput(output: string, environment: NodeJS.ProcessEnv): string {
  let text = output.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  const values = Object.entries(environment)
    .filter(([name]) => credentialName.test(name))
    .map(([, value]) => value)
    .filter((value): value is string => typeof value === "string" && value.trim().length >= minimumEnvironmentValue)
    .sort((left, right) => right.length - left.length);
  for (const value of values) text = text.split(value).join("[redacted]");
  text = text
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [redacted]")
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, (run) => (/\d/.test(run) && /[A-Za-z]/.test(run) ? "[redacted]" : run));
  return text.trimEnd().split("\n").slice(-tailLines).join("\n");
}
