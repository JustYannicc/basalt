import { loadImportConfig } from "./cutover/files.ts";
import { ImportFailure, importAccounts } from "./cutover/import.ts";

try {
  const args = process.argv.slice(2);
  if (args[0] !== "--config" || !args[1] || args.length > 3 || (args[2] !== undefined && args[2] !== "--check")) {
    process.stderr.write("Usage: node scripts/import-pool-accounts.ts --config <private-json-file> [--check]\n");
    process.exitCode = 1;
  } else {
    const config = await loadImportConfig(args[1]);
    if (args[2] === "--check") process.stdout.write(`Validated ${config.accounts.length} login files. No network requests sent.\n`);
    else {
      const result = await importAccounts(config);
      process.stdout.write(`Imported and verified ${result.verified} accounts.\n`);
    }
  }
} catch (error) {
  process.stderr.write(`${error instanceof ImportFailure ? error.message : "Import failed. Inspect the pool before retrying."}\n`);
  process.exitCode = 1;
}
