import { credentialName, redactCredentialText } from "../pool-history/failure-output.ts";

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
  "ALCHEMY_STAGE",
  "BASALT_RELEASE_ATTEMPT",
  "BASALT_RELEASE_CANDIDATE",
  "BASALT_BOX_OUTPUT",
  "POLICY",
  "POLICY_NAME",
  "MODE",
  "GO_INPUT",
  "PLAN_DIGEST",
  "PLAN_DIGEST_INPUT",
]);

const isPublic = (name: string) =>
  !credentialName.test(name) &&
  (PUBLIC.has(name) || name.startsWith("RUNNER_") || name.startsWith("GITHUB_"));

/**
 * Text kept on the box past a release container, redacted further than a public failure tail: on
 * top of the credential shapes and credential-named values, any value of the entry's own environment
 * long enough to be a credential unless its name is a known public one. The entry cannot tell a
 * secret from other env by value, so it errs toward redacting too much.
 */
export function redactSecrets(text: string, env: Readonly<Record<string, string | undefined>>) {
  const values = Object.entries(env).flatMap(([name, value]) =>
    typeof value === "string" &&
    !isPublic(name) &&
    value.trim().length >= (credentialName.test(name) ? 4 : 12)
      ? [value]
      : [],
  );
  return redactCredentialText(text, values);
}
