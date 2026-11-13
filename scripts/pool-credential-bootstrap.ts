import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BootstrapRefusal,
  decodePlan,
  planDigest,
  secretName,
} from "./pool-credential-bootstrap/contract.ts";
import {
  armBootstrap,
  inspectBootstrap,
  recordBootstrap,
} from "./pool-credential-bootstrap/journal.ts";
import { programDigest } from "./pool-credential-bootstrap/program.ts";

async function json(path: string) {
  const text = await readFile(path, "utf8");
  if (Buffer.byteLength(text) > 65_536) throw new BootstrapRefusal("input-too-large");
  return JSON.parse(text) as unknown;
}

export async function bootstrapCommand(args: string[]) {
  const [command, input, directory, resultFile] = args;
  if (!input) throw new BootstrapRefusal("input-file-required");
  if (command === "review" && args.length === 2) {
    const plan = decodePlan(await json(input));
    return {
      planDigest: planDigest(plan),
      programDigest: programDigest(plan),
      secretName: secretName(plan.target),
      mode: plan.mode,
    };
  }
  if (command === "inspect" && args.length === 2)
    return inspectBootstrap(decodePlan(await json(input)));
  if (command === "arm" && directory && args.length === 3)
    return armBootstrap(resolve(directory), await json(input));
  if (command === "record" && directory && resultFile && args.length === 4)
    return recordBootstrap(
      resolve(directory),
      decodePlan(await json(input)),
      await json(resultFile),
    );
  throw new BootstrapRefusal("invalid-command");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(await bootstrapCommand(process.argv.slice(2))));
  } catch (error) {
    // Parsing errors and unexpected tool replies can contain credentials; print only our closed failures.
    console.error(
      error instanceof BootstrapRefusal
        ? error.message
        : "Pool credential bootstrap refused: invalid-input-or-journal",
    );
    process.exitCode = 1;
  }
}
