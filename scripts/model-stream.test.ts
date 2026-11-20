import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyOptionalModelStream } from "./model-stream.ts";

test("an absent acceptance credential skips without requests and writes the step summary", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "stream-summary-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const summary = join(directory, "summary.md");
  const result = await verifyOptionalModelStream({
    origin: "https://fixture.invalid",
    summary,
    log: () => {},
    client: {
      modelCatalog: async () => {
        throw new Error("No request without credentials");
      },
      sendTurn: async () => {
        throw new Error();
      },
    },
  });
  assert.equal(result.status, "not-configured");
  assert.match(await readFile(summary, "utf8"), /not configured/);
});

for (const failure of [false, true])
  test(`a configured model stream is required to finish on the same boot: failure=${failure}`, async () => {
    const run = verifyOptionalModelStream({
      key: "synthetic-never-sent",
      origin: "https://fixture.invalid",
      model: "fixture",
      log: () => {},
      client: {
        modelCatalog: async () => ({ boot: "boot", ids: ["fixture"], completedAt: 0 }),
        sendTurn: async () => ({
          boot: failure ? "other-boot" : "boot",
          firstByteMs: 1,
          totalMs: 2,
        }),
      },
    });
    if (failure) await assert.rejects(run, /Configured release model stream failed/);
    else assert.equal((await run).status, "passed");
  });
