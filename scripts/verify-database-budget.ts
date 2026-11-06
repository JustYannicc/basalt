export {
  checkDatabaseBackends,
  databaseVerificationOverallMs,
  type DatabaseClient,
} from "./database-budget-postgres.ts";
import { DatabaseBudgetFailure } from "./database-budget-receipt.ts";

if (import.meta.main) {
  let output: unknown;
  let code = 0;
  try {
    const { runDatabaseBudgetCommand } = await import("./database-budget-command.ts");
    output = await runDatabaseBudgetCommand(process.env, process.argv.slice(2));
  } catch (error) {
    output = error instanceof DatabaseBudgetFailure ? error.receipt : { outcome: "receipt-error" };
    code = 1;
  }
  const stream = code ? process.stderr : process.stdout;
  await new Promise<void>((resolve, reject) => {
    stream.write(JSON.stringify(output) + "\n", (error) => (error ? reject(error) : resolve()));
  });
  // A bridge that ignores bounded disposal must not hold the one-shot command open.
  process.exit(code);
}
