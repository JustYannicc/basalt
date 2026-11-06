import * as Command from "alchemy/Command";
import * as Output from "alchemy/Output";
import type { Input } from "alchemy/Input";
import type { Redacted } from "effect";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** This read-only acceptance job starts after the replacement Worker has deployed. */
export const verifyRuntimeDatabaseBudget = (
  id: string,
  options: {
    adminUrl: Input<Redacted.Redacted<string>>;
    runtimeLogin: Output.Output<string, never>;
    databases: string[];
    deployment: Output.Output<unknown, never>;
  },
) => {
  const script = fileURLToPath(new URL("../../scripts/verify-database-budget.ts", import.meta.url));
  return Command.Exec(id, {
    command: `node ${basename(script)}`,
    cwd: dirname(script),
    env: {
      DATABASE_BUDGET_ADMIN_URL: options.adminUrl,
      DATABASE_BUDGET_RUNTIME_LOGINS: options.runtimeLogin.pipe(
        Output.map((login) => JSON.stringify([login])),
      ),
      DATABASE_BUDGET_DATABASES: JSON.stringify(options.databases),
      DATABASE_BUDGET_DEPLOYMENT: Output.all(options.deployment).pipe(Output.map(() => "ready")),
    },
    memo: false,
    timeout: "2 minutes",
  });
};
