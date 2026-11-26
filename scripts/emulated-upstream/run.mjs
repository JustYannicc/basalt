// Deploys, checks, expires and removes the keyed emulated upstream; the decisions live in stage.mjs.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runEntry } from "./entry-output.mjs";
import { main } from "./stage.mjs";

const output = process.env.EMULATED_OUTPUT ?? ".local/emulated-upstream";
mkdirSync(output, { recursive: true, mode: 0o700 });

process.exitCode = await main(process.env, {
  save: (name, value) =>
    writeFileSync(join(output, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    }),
  summary: (line) => {
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  },
  deployEntry: (deleteBy) => runEntry(deleteBy, process.env),
});
