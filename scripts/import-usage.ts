import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { exportFile, homeExportPages, privateCredential, serviceOrigin } from "./usage-import-source.ts";
import { historyObject, timestamp } from "../src/pool/model-history/record.ts";

const { values } = parseArgs({ options: {
  target: { type: "string" }, "pool-token-file": { type: "string" }, caller: { type: "string" }, source: { type: "string" },
  format: { type: "string" }, file: { type: "string", multiple: true }, prices: { type: "string" }, models: { type: "string" },
  "home-url": { type: "string" }, "home-key-file": { type: "string" }, from: { type: "string" }, to: { type: "string" },
  report: { type: "string" }, "apply-report": { type: "string" }, approve: { type: "string" },
} });
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

interface PageReport { input: string; result: Record<string, unknown> }
interface ImportReport { version: 1; target: string; source: string; pages: PageReport[] }

async function main() {
  if (!values.target || !values["pool-token-file"] || !values.caller || !values.source)
    throw new Error("Provide target, pool-token-file, caller and one stable source UUID");
  const target = serviceOrigin(values.target);
  const token = await privateCredential(values["pool-token-file"]);
  const prices: unknown = values.prices ? JSON.parse(await readFile(values.prices, "utf8")) : undefined;
  const models: unknown = values.models ? JSON.parse(await readFile(values.models, "utf8")) : undefined;
  const applying = values["apply-report"] !== undefined;
  if (applying === (values.report !== undefined) || applying && !values.approve)
    throw new Error("Choose report for a dry run, or apply-report and its approved SHA-256");
  let approved: ImportReport | undefined;
  if (applying) {
    const text = await readFile(values["apply-report"]!, "utf8");
    if (digest(text) !== values.approve) throw new Error("The approved import report does not match");
    approved = JSON.parse(text);
    if (approved?.version !== 1 || approved.target !== target.origin || approved.source !== values.source || !Array.isArray(approved.pages))
      throw new Error("The approved import belongs to another target or source");
  }
  async function* sources() {
    if (values["home-url"]) {
      if (values.format && values.format !== "home-v8-jsonl" || values.file || !values["home-key-file"] || !values.from || !values.to)
        throw new Error("Home import requires home-key-file, from and to, without file");
      const from = timestamp(values.from), to = timestamp(values.to);
      if (from >= to) throw new Error("Home export requires an ordered time range");
      yield* homeExportPages({ origin: serviceOrigin(values["home-url"]),
        managementKey: await privateCredential(values["home-key-file"]), from, to });
    } else {
      if (!values.file?.length || !["home-v8-jsonl", "cpa-v6"].includes(values.format ?? ""))
        throw new Error("Provide file and format: home-v8-jsonl or cpa-v6");
      for (const file of values.file) yield await exportFile(file);
    }
  }
  const report: ImportReport = { version: 1, target: target.origin, source: values.source, pages: [] };
  let pageIndex = 0, inserted = 0;
  for await (const data of sources()) {
    let offset: number | null = 0;
    do {
      const input = { source: values.source, format: values["home-url"] ? "home-v8-jsonl" : values.format,
        data, offset, prices, models };
      const inputHash = digest(JSON.stringify(input));
      const prior = approved?.pages[pageIndex];
      if (applying && prior?.input !== inputHash) throw new Error("Source data changed since the approved report");
      const body = { ...input, mode: applying ? "apply" : "dry-run", approval: prior?.result.approval };
      const response = await globalThis.fetch(new URL("/pool/v1/usage/import", target), {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { authorization: `Bearer ${token}`, "x-signalbox-caller": values.caller!, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Import refused with HTTP ${response.status}`); }
      const result = historyObject(await response.json());
      if (result.next !== null && (typeof result.next !== "number" || !Number.isSafeInteger(result.next) || result.next <= offset!))
        throw new Error("Invalid import continuation");
      report.pages.push({ input: inputHash, result });
      if (typeof result.inserted === "number") inserted += result.inserted;
      offset = result.next as number | null;
      pageIndex++;
    } while (offset !== null);
  }
  if (applying && pageIndex !== approved!.pages.length) throw new Error("Source page count changed since the approved report");
  if (applying) console.log(JSON.stringify({ pages: pageIndex, inserted }));
  else {
    const output = `${JSON.stringify(report, null, 2)}\n`;
    await writeFile(values.report!, output, { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ pages: pageIndex, sha256: digest(output), writes: false }));
  }
}

try { await main(); }
catch {
  console.error("Usage import failed; source exports, credentials and HTTP bodies are not logged");
  process.exitCode = 1;
}
