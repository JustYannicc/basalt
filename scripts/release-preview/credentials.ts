import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const loginFiles = {
  PREVIEW_CLAUDE_AUTH_JSON: "PREVIEW_CLAUDE_AUTH_FILE",
  PREVIEW_CODEX_SUBSCRIPTION_AUTH_JSON: "PREVIEW_CODEX_SUBSCRIPTION_AUTH_FILE",
  PREVIEW_CODEX_CLI_AUTH_JSON: "PREVIEW_CODEX_CLI_AUTH_FILE",
} as const;

export function validateSmokeSecrets(source: NodeJS.ProcessEnv): void {
  for (const name of [
    "PREVIEW_SMOKE_EMAIL", "PREVIEW_SMOKE_PASSWORD",
    "PREVIEW_CLAUDE_MODEL", "PREVIEW_CODEX_MODEL", ...Object.keys(loginFiles),
  ]) {
    if (!source[name]?.trim()) throw new Error(`Missing preview smoke input: ${name}`);
  }
  if (!source.PREVIEW_SMOKE_EMAIL!.endsWith("@example.invalid")) {
    throw new Error("The preview smoke identity must use the reserved example.invalid domain");
  }
  for (const name of Object.keys(loginFiles)) {
    let value: unknown;
    try { value = JSON.parse(source[name]!); } catch {
      throw new Error(`Preview smoke input must contain JSON: ${name}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Preview smoke input must contain a JSON object: ${name}`);
    }
  }
}

/** The caller owns this private directory and removes it in its lifecycle finalizer. */
export async function materializeSmokeSecrets(
  source: NodeJS.ProcessEnv,
  directory: string,
): Promise<NodeJS.ProcessEnv> {
  validateSmokeSecrets(source);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const environment = { ...source };
  for (const [secret, variable] of Object.entries(loginFiles)) {
    const path = join(directory, `${variable.toLowerCase()}.json`);
    await writeFile(path, source[secret]!, { flag: "wx", mode: 0o600 });
    environment[variable] = path;
    delete environment[secret];
  }
  return environment;
}
