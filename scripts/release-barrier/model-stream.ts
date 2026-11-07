import { appendFile } from "node:fs/promises";
import { PoolAcceptanceClient } from "../pool-acceptance/client.ts";

export async function verifyOptionalModelStream(options: {
  key?: string;
  model?: string;
  expectedBoot?: string;
  summary?: string;
  origin: string;
  client?: Pick<PoolAcceptanceClient, "modelCatalog" | "sendTurn">;
  log?: (message: string) => void;
}) {
  const note = async (message: string) => {
    (options.log ?? console.log)(message);
    if (options.summary) await appendFile(options.summary, `Model stream: ${message}\n\n`);
  };
  if (!options.key?.trim()) {
    await note("not configured; dedicated acceptance credential is absent");
    return { status: "not-configured" as const };
  }
  try {
    const client = options.client ?? new PoolAcceptanceClient({ origin: options.origin });
    const catalog = await client.modelCatalog(options.key);
    if (options.expectedBoot && catalog.boot !== options.expectedBoot) throw new Error();
    const model = options.model ?? (catalog.ids.length === 1 ? catalog.ids[0] : undefined);
    if (!model || !catalog.ids.includes(model)) throw new Error();
    const stream = await client.sendTurn(options.key, model, {
      id: crypto.randomUUID(),
      expectedRecords: 1,
    });
    if (stream.boot !== catalog.boot) throw new Error();
    await note("passed; a complete model stream used the verified pool boot");
    return { status: "passed" as const, bootId: stream.boot };
  } catch {
    await note("failed; configured model stream did not verify");
    throw new Error("Configured release model stream failed");
  }
}
