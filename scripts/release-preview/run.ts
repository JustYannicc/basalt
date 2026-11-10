import { catalogAcceptanceOperation } from "./catalog-acceptance-report.ts";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  lifecycleEnvironment,
  materializeSmokeSecrets,
  validateSmokeSecrets,
} from "./credentials.ts";
import { manifestPath, previewNumber } from "./checkpoint.ts";
import { privateOperation } from "./process.ts";
import { runPreview } from "./lifecycle.ts";
import { previewReceipt } from "./receipt.ts";
import { requireCompilerPreviewIdentity } from "./policy.ts";
import { previewIdentity } from "../environment.ts";
import { readPreviewManifest } from "../preview/manifest.ts";

type Identity = { pullRequest: number; head: string; base: string; compilerAcceptance?: true };

function requireIdentity(value: unknown, pullRequest: number): Identity {
  if (!value || typeof value !== "object") throw new Error("Missing preview candidate identity");
  const identity = value as Record<string, unknown>;
  if (
    identity.status !== "candidate-allowed" ||
    identity.pullRequest !== pullRequest ||
    typeof identity.head !== "string" ||
    !/^[a-f0-9]{40}$/.test(identity.head) ||
    typeof identity.base !== "string" ||
    !/^[a-f0-9]{40}$/.test(identity.base)
  ) {
    throw new Error("Invalid preview candidate identity");
  }
  return {
    pullRequest,
    head: identity.head,
    base: identity.base,
    ...(identity.compilerAcceptance === true ? { compilerAcceptance: true } : {}),
  };
}

export async function executePreview(
  root: string,
  pullRequest: number,
  source: NodeJS.ProcessEnv,
  runOperation: typeof privateOperation = privateOperation,
): Promise<void> {
  if (source.GITHUB_ACTIONS !== "true")
    throw new Error("Release previews run only in GitHub Actions");
  if (source.PREVIEW_MANIFEST_CHECKPOINTED !== "1")
    throw new Error("The encrypted cleanup checkpoint must be uploaded before deployment");
  validateSmokeSecrets(source);
  const candidate: unknown = JSON.parse(
    await readFile(join(root, ".local", "candidate.json"), "utf8"),
  );
  const identity = requireIdentity(candidate, pullRequest);
  requireCompilerPreviewIdentity(source, candidate, identity);
  const privateRoot = await mkdtemp(
    join(source.RUNNER_TEMP ?? tmpdir(), "basalt-release-preview-"),
  );
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  let sequence = 0;
  const deployEnvironment = lifecycleEnvironment(source, "deploy");
  const cleanupEnvironment = lifecycleEnvironment(source, "cleanup");
  const operation = (
    label: string,
    script: string,
    args: string[] = [],
    environment = deployEnvironment,
    cleanup = false,
  ) =>
    runOperation({
      label,
      command: process.execPath,
      args: [script, ...args],
      directory: root,
      environment: { ...environment, GITHUB_OUTPUT: undefined, GITHUB_ENV: undefined },
      logPath: join(privateRoot, `${++sequence}-${label}.log`),
      timeoutMs: cleanup ? 15 * 60_000 : 40 * 60_000,
      signal: cleanup ? undefined : controller.signal,
    });
  try {
    await mkdir(join(privateRoot, "credentials"), { mode: 0o700 });
    const materialized = await materializeSmokeSecrets(source, join(privateRoot, "credentials"));
    const runnerEnvironment: NodeJS.ProcessEnv = {};
    let catalogAcceptance: unknown;
    for (const name of [
      "PATH",
      "LANG",
      "RUNNER_TEMP",
      "PREVIEW_SMOKE_EMAIL",
      "PREVIEW_SMOKE_PASSWORD",
      "PREVIEW_CLAUDE_AUTH_FILE",
      "PREVIEW_CODEX_SUBSCRIPTION_AUTH_FILE",
      "PREVIEW_CODEX_CLI_AUTH_FILE",
      "PREVIEW_CLAUDE_MODEL",
      "PREVIEW_CODEX_MODEL",
    ] as const)
      runnerEnvironment[name] = materialized[name];
    const outcome = await runPreview({
      prepare: async () => {
        // The encrypted plan is uploaded by the workflow before the first provider mutation.
        await readFile(manifestPath(root, pullRequest));
        if (controller.signal.aborted) throw new Error("Preview cancelled");
      },
      deploy: () =>
        operation("deploy", "scripts/preview/lifecycle.ts", ["deploy", String(pullRequest)]),
      seed: async () => {
        // Seeding runs inside Alchemy with its private migration connection.
        const path = manifestPath(root, pullRequest);
        const manifest = await readPreviewManifest(path, pullRequest);
        const expected = previewIdentity(pullRequest, source);
        if (
          manifest.phase !== "seeded" ||
          manifest.origin !== expected.origin ||
          typeof manifest.organizationId !== "string" ||
          typeof manifest.poolAppId !== "string"
        ) {
          throw new Error("Preview seed did not produce its native app context");
        }
        runnerEnvironment.POOL_ACCEPTANCE_ORIGIN = manifest.origin;
        runnerEnvironment.POOL_ACCEPTANCE_PREVIEW_MANIFEST_FILE = path;
        runnerEnvironment.PREVIEW_SMOKE_PULL_REQUEST = String(pullRequest);
        runnerEnvironment.ALCHEMY_STAGE = expected.stage;
        runnerEnvironment.TEST_STAGE_DOMAIN = source.TEST_STAGE_DOMAIN;
        runnerEnvironment.PREVIEW_SMOKE_ORGANIZATION_ID = manifest.organizationId;
        runnerEnvironment.PREVIEW_SMOKE_POOL_APP_ID = manifest.poolAppId;
        runnerEnvironment.POOL_ACCEPTANCE_ACCOUNTS_FILE = join(
          privateRoot,
          "provider-accounts.json",
        );
        await operation(
          "provider-account-setup",
          "scripts/pool-acceptance/preview-accounts.ts",
          [],
          runnerEnvironment,
        );
      },
      smoke: async () => {
        if (identity.compilerAcceptance) {
          const catalogPath = join(root, "preview-catalog-acceptance.json");
          catalogAcceptance = await catalogAcceptanceOperation(
            () =>
              operation(
                "catalog-acceptance",
                "scripts/release-preview/catalog-acceptance-cli.ts",
                [],
                {
                  ...runnerEnvironment,
                  GITHUB_ACTIONS: "true",
                  EXECUTOR_COMPILER_PREVIEW_ACCEPTANCE: "true",
                  BASALT_RELEASE_CANDIDATE: identity.head,
                  PREVIEW_CATALOG_ACCEPTANCE_RESULT: catalogPath,
                  PREVIEW_CLAUDE_AUTH_FILE: undefined,
                  PREVIEW_CODEX_SUBSCRIPTION_AUTH_FILE: undefined,
                },
              ),
            catalogPath,
            identity.head,
            { summaryPath: source.GITHUB_STEP_SUMMARY },
          );
        }
        const resultPath = join(privateRoot, "smoke-result.json");
        await operation("native-smoke", "scripts/pool-acceptance.ts", [], {
          ...runnerEnvironment,
          PREVIEW_CLAUDE_AUTH_FILE: undefined,
          PREVIEW_CODEX_SUBSCRIPTION_AUTH_FILE: undefined,
          POOL_ACCEPTANCE_MODE: "preview",
          POOL_ACCEPTANCE_RESULT_PATH: resultPath,
        });
        return JSON.parse(await readFile(resultPath, "utf8")) as unknown;
      },
      destroy: () =>
        operation(
          "destroy",
          "scripts/preview/lifecycle.ts",
          ["destroy", String(pullRequest)],
          cleanupEnvironment,
          true,
        ),
      verifyAbsent: () =>
        operation(
          "verify-absence",
          "scripts/preview/lifecycle.ts",
          ["verify", String(pullRequest)],
          cleanupEnvironment,
          true,
        ),
    });
    const receipt = previewReceipt(outcome.smoke, identity, outcome.teardown, catalogAcceptance);
    await writeFile(join(root, "preview-receipt.json"), `${JSON.stringify(receipt)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    console.log("Live preview smoke and remote teardown passed");
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    await rm(privateRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await executePreview(process.cwd(), previewNumber(process.argv[2]), process.env);
  } catch {
    console.error(
      "Release preview failed; no merge receipt was written. Run trusted cleanup if resources remain.",
    );
    process.exitCode = 1;
  }
}
