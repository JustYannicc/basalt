import { requiredPreviewCleanupSecrets, requiredPreviewDeploySecrets } from "../environment.ts";

/** Lifecycle children provision resources; the production pool signing key stays in the parent. */
export function lifecycleEnvironment(
  source: NodeJS.ProcessEnv,
  mode: "deploy" | "cleanup",
): NodeJS.ProcessEnv {
  const names = [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "BUN_INSTALL",
    "ALCHEMY_HOME",
    "RUNNER_TEMP",
    "GITHUB_ACTIONS",
    "PREVIEW_STATE_KEY",
    "PREVIEW_MANIFEST_CHECKPOINTED",
    ...(mode === "deploy"
      ? [
          ...requiredPreviewDeploySecrets,
          "PREVIEW_SMOKE_EMAIL",
          "PREVIEW_SMOKE_PASSWORD",
          "EXECUTOR_COMPILER_PREVIEW_ACCEPTANCE",
          "BASALT_RELEASE_CANDIDATE",
        ]
      : requiredPreviewCleanupSecrets),
  ];
  return Object.fromEntries(
    names.flatMap((name) => (source[name] === undefined ? [] : [[name, source[name]]])),
  );
}

export function validateSmokeSecrets(source: NodeJS.ProcessEnv): void {
  for (const name of [
    "PREVIEW_SMOKE_EMAIL",
    "PREVIEW_SMOKE_PASSWORD",
    "PREVIEW_POOL_ID",
    "ORGANIZATION_ID",
    "OWNER_ID",
    "POOL_APP_SIGNING_KEY",
  ]) {
    if (!source[name]?.trim()) throw new Error(`Missing preview smoke input: ${name}`);
  }
  if (!source.PREVIEW_SMOKE_EMAIL!.endsWith("@example.invalid")) {
    throw new Error("The preview smoke identity must use the reserved example.invalid domain");
  }
  if (!/^[0-9a-f]{64}$/.test(source.POOL_APP_SIGNING_KEY!))
    throw new Error("Preview pool signing key is invalid");
}
