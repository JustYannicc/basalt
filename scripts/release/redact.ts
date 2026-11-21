/** Runner and workflow names whose values are public and are worth keeping readable in a path. */
const PUBLIC = new Set([
  "PATH",
  "HOME",
  "PWD",
  "OLDPWD",
  "SHELL",
  "USER",
  "LANG",
  "TMPDIR",
  "BASALT_RELEASE_CANDIDATE",
  "BASALT_BOX_OUTPUT",
  "POLICY",
  "POLICY_NAME",
  "MODE",
  "GO_INPUT",
  "PLAN_DIGEST",
  "PLAN_DIGEST_INPUT",
]);
const SECRET_NAME = /TOKEN|SECRET|KEY|PASSWORD|DSN|CREDENTIAL/iu;

const isPublic = (name: string) =>
  !SECRET_NAME.test(name) &&
  (PUBLIC.has(name) || name.startsWith("RUNNER_") || name.startsWith("GITHUB_"));

/**
 * Text kept on the box past a release container, with every secret value taken out: any value of
 * the entry's own environment long enough to be a credential unless its name is a known public
 * one, any value under a secret-shaped name, any Postgres connection URL and any bearer token. It
 * redacts too much rather than too little: the entry cannot tell a secret from other env by value.
 */
export function redactSecrets(text: string, env: Readonly<Record<string, string | undefined>>) {
  const values = Object.entries(env)
    .filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" &&
        !isPublic(entry[0]) &&
        entry[1].length >= (SECRET_NAME.test(entry[0]) ? 4 : 12),
    )
    .map(([, value]) => value)
    // The longest first, so a value that contains another is taken out whole.
    .sort((a, b) => b.length - a.length);
  let redacted = text;
  for (const value of values) redacted = redacted.split(value).join("[redacted]");
  return redacted
    .replace(/\bpostgres(?:ql)?:\/\/[^\s"'`]+/giu, "postgres://[redacted]")
    .replace(/\bBearer\s+[^\s"'`]+/gu, "Bearer [redacted]");
}
