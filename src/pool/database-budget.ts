import * as Command from "alchemy/Command";
import * as Output from "alchemy/Output";
import type { Input } from "alchemy/Input";
import { Effect, type Redacted } from "effect";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const verifyRuntimeDatabaseBudget = (
  id: string,
  options: {
    adminUrl: Input<Redacted.Redacted<string>>;
    runtimeLogin: Output.Output<string, never>;
    databases: string[];
    deployment: Output.Output<unknown, never>;
    candidate: string;
    readiness?: {
      worker: Output.Output<string, never>;
      accountId: Input<string>;
      key: Input<Redacted.Redacted<string>>;
      imageHash: Output.Output<string, never>;
      workerInput: string;
    };
  },
) =>
  Effect.gen(function* () {
    const cwd = dirname(
      fileURLToPath(new URL("../../scripts/verify-database-budget.ts", import.meta.url)),
    );
    const receipt = resolve(cwd, `../.local/database-budget/${id}.json`);
    const readyReceipt = resolve(cwd, `../.local/database-budget/${id}-ready.json`);
    const target = options.readiness;
    const readyEnv = target
      ? {
          DATABASE_BUDGET_WORKER: target.worker,
          CLOUDFLARE_ACCOUNT_ID: target.accountId,
          POOL_DEPLOYMENT_KEY: target.key,
          DATABASE_BUDGET_IMAGE_HASH: target.imageHash,
          DATABASE_BUDGET_WORKER_INPUT: target.workerInput,
        }
      : {};
    const ready = target
      ? yield* Command.Exec(`${id}RuntimeReady`, {
          command: "node verify-database-budget.ts --ready",
          cwd,
          env: {
            ...readyEnv,
            GITHUB_SHA: options.candidate,
            DATABASE_BUDGET_RECEIPT: readyReceipt,
            DATABASE_BUDGET_DEPLOYMENT: options.deployment.pipe(Output.map(() => "deployed")),
          },
          memo: false,
          // The new readiness command reserves teardown time outside the 180-second startup budget.
          timeout: "185 seconds",
        })
      : undefined;
    return yield* Command.Exec(id, {
      command: "node verify-database-budget.ts",
      cwd,
      env: {
        ...readyEnv,
        GITHUB_SHA: options.candidate,
        DATABASE_BUDGET_RECEIPT: receipt,
        DATABASE_BUDGET_READY_RECEIPT: ready ? ready.hash.pipe(Output.map(() => readyReceipt)) : "",
        DATABASE_BUDGET_ADMIN_URL: options.adminUrl,
        DATABASE_BUDGET_RUNTIME_LOGINS: options.runtimeLogin.pipe(
          Output.map((login) => JSON.stringify([login])),
        ),
        DATABASE_BUDGET_DATABASES: JSON.stringify(options.databases),
        DATABASE_BUDGET_DEPLOYMENT: options.deployment.pipe(Output.map(() => "deployed")),
      },
      memo: false,
      timeout: "2 minutes",
    });
  });
