import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import {
  findOperation,
  operationInputSha256,
  readKindDrift,
  type ReadKindPins,
} from "./catalog-read-kinds.ts";

// Compares each carried app's reviewed POST reads with the vendor's live document. A changed
// input surface fails until a reviewer confirms the operation is still a read and re-pins it with
// `--write`, which records the current values for the operations already pinned.
const pinsPath = new URL("../src/catalog/read-kinds.json", import.meta.url);
const pins: ReadKindPins = JSON.parse(readFileSync(pinsPath, "utf8"));
const write = process.argv.includes("--write");

const fetchDocument = async (url: string) => {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`${url} answered ${response.status}`);
      return (await response.json()) as Record<string, never>;
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((retry) => setTimeout(retry, attempt * 2_000));
    }
  }
};

const problems: string[] = [];
const next: Record<string, ReadKindPins[string]> = {};
for (const [app, pin] of Object.entries(pins)) {
  let document: Record<string, never>;
  try {
    document = await fetchDocument(pin.source);
  } catch (error) {
    problems.push(`${app}: could not read ${pin.source} (${String(error)})`);
    continue;
  }
  if (write) {
    const operations = Object.fromEntries(
      Object.keys(pin.operations).map((operationId) => {
        const found = findOperation(document, operationId);
        if (found === undefined)
          throw new Error(`${app}/${operationId} is not declared by exactly one operation`);
        const { method, path } = found;
        return [operationId, { method, path, inputSha256: operationInputSha256(document, found) }];
      }),
    );
    next[app] = { source: pin.source, operations };
  } else problems.push(...readKindDrift(app, pin, document));
}

if (write) writeFileSync(pinsPath, `${JSON.stringify(next, null, 2)}\n`);
const report = JSON.stringify(
  {
    apps: Object.keys(pins).length,
    reads: Object.values(pins).reduce(
      (count, pin) => count + Object.keys(pin.operations).length,
      0,
    ),
    problems,
  },
  null,
  2,
);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    "## Catalog POST reads against their reviewed inputs\n\n```json\n" + report + "\n```\n",
  );
console.log(report);
if (problems.length > 0) process.exitCode = 1;
