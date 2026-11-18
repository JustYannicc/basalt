import { createHmac } from "node:crypto";
import { subjectKeyDomain, toSubject, type StageSubject } from "../preview/subject.ts";

export function stageKey(key: string, subject: StageSubject, purpose: string): string {
  let checked: StageSubject | undefined;
  try {
    checked = toSubject(subject);
  } catch {
    checked = undefined;
  }
  if (!/^[a-f0-9]{64}$/.test(key) || checked === undefined) {
    throw new Error("Invalid preview state key or pull request");
  }
  return createHmac("sha256", Buffer.from(key, "hex"))
    .update(`${subjectKeyDomain(checked)}\0${checked.number}\0${purpose}`)
    .digest("hex");
}

export function previewKey(key: string, pullRequest: number, purpose: string): string {
  return stageKey(key, { kind: "pr", number: pullRequest }, purpose);
}

/** Stable across retries of one temporary stage; never reuse the production signing keys. */
export function deriveStageSecrets(key: string, subject: StageSubject): NodeJS.ProcessEnv {
  return Object.fromEntries(
    [
      "BETTER_AUTH_SECRET",
      "EXECUTOR_ENCRYPTION_KEY",
      "MCP_SESSION_KEY_CURRENT",
      "MCP_SESSION_KEY_PREVIOUS",
      "APP_DOMAIN_CONTROL_SECRET",
      "POOL_MANAGEMENT_KEY",
      "POOL_APP_SIGNING_KEY",
    ].map((name) => [name, stageKey(key, subject, name)]),
  );
}

export function derivePreviewSecrets(key: string, pullRequest: number): NodeJS.ProcessEnv {
  return deriveStageSecrets(key, { kind: "pr", number: pullRequest });
}
