/** Names whose values never reach a public log: credentials, keys, identities and account names. */
const secretName = /TOKEN|KEY|SECRET|PASSWORD|DSN|AUTH|COOKIE|SESSION|CREDENTIAL|ACCOUNT_ID|ORGANIZATION|EMAIL/u;

/**
 * Removes every secret-named environment value, then bearer tokens, JWTs and long hex strings, from
 * text bound for a public Actions log. Values shorter than six characters are left alone because
 * they would also blank ordinary words.
 */
export function redactor(...sources: NodeJS.ProcessEnv[]): (text: string) => string {
  const values = [
    ...new Set(
      sources.flatMap((source) =>
        Object.entries(source).flatMap(([name, value]) =>
          secretName.test(name) && typeof value === "string" && value.trim().length >= 6 ? [value.trim()] : [],
        ),
      ),
    ),
  ].sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text;
    for (const value of values) out = out.split(value).join("[redacted]");
    return out
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gu, "Bearer [redacted]")
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, "[redacted-jwt]")
      .replace(/\b[a-f0-9]{32,}\b/giu, "[redacted-hex]");
  };
}

/** An error and its causes as redacted text, so a failure always says what actually went wrong. */
export function describeError(error: unknown, redact: (text: string) => string, depth = 0): string {
  if (depth > 4) return "";
  if (error instanceof AggregateError)
    return [redact(error.message), ...error.errors.map((item) => describeError(item, redact, depth + 1))].join("\n");
  if (error instanceof Error) {
    const stack = (error.stack ?? `${error.name}: ${error.message}`).split("\n").slice(0, 8).join("\n");
    const cause = error.cause === undefined ? "" : `\ncaused by: ${describeError(error.cause, redact, depth + 1)}`;
    return redact(stack) + cause;
  }
  return redact(String(error));
}
