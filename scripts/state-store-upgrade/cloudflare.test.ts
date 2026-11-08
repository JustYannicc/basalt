import assert from "node:assert/strict";
import { test } from "node:test";
import { cloudflare } from "./cloudflare.ts";
import { candidate, fixture } from "./fixture.ts";
import { operate, type Receipt } from "./operation.ts";
import { UpgradeRefusal } from "./refusal.ts";

for (const phase of ["inventory", "upload", "activate"] as const) {
  test(`a Cloudflare 400 during ${phase} retains its code and safe cause in the receipt`, async () => {
    const f = fixture();
    const receipts: Receipt[] = [];
    let rejected = 0;
    const api = cloudflare("a".repeat(32), "never-log-provider-token", async (input, init) => {
      const url = String(input);
      const matches =
        phase === "inventory"
          ? url.endsWith("/settings")
          : init?.method === "POST" &&
            url.includes(phase === "upload" ? "/versions?" : "/deployments");
      if (matches) {
        rejected++;
        return Response.json(
          {
            success: false,
            errors: [
              {
                code: 10057,
                message: "Binding Store cannot be inherited; metadata.bindings[7].type is invalid.",
              },
            ],
            messages: [{ code: 20001, message: "Use a compatible binding declaration." }],
          },
          { status: 400 },
        );
      }
      return f.fetcher(input, init);
    });
    await assert.rejects(
      operate({
        mode: "apply",
        expected: f.expected,
        candidate,
        api,
        save: async (receipt) => {
          receipts.push(receipt);
        },
      }),
      (error) => {
        assert.ok(error instanceof UpgradeRefusal);
        assert.match(error.message, /10057.*Binding Store cannot be inherited/);
        assert.match(error.message, /20001.*compatible binding declaration/);
        return true;
      },
    );
    const stored = JSON.stringify(receipts.at(-1));
    assert.match(stored, /10057/);
    assert.match(stored, /Binding Store cannot be inherited/);
    assert.ok(!stored.includes("never-log-provider-token"));
    assert.equal(rejected, 1);
  });
}
