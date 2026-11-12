import assert from "node:assert/strict";
import { access, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { command } from "./support.ts";
import { fixture } from "./native-client-fixture.ts";

test("a failed CLI shutdown still removes its owned peer and private profile", async (t) => {
  const f = await fixture({ services: () => ({ status: 200 }) });
  t.after(async () => {
    await f.stop().catch(() => undefined);
    await f.remote.close();
    await rm(f.home, { recursive: true, force: true });
  });
  await f.login();
  await command(["agent", "add", "both", "models"], f.home);
  const preload = join(f.home, "failed-shutdown.mjs");
  await writeFile(preload, 'process.once("SIGTERM",()=>{process.exitCode=17;});');
  const origin = await f.start(["--import", preload]);
  const response = await fetch(`${origin}/v1/models`, {
    headers: { authorization: `Bearer ${await f.token()}` },
  });
  assert.equal(response.status, 200);
  await response.body?.cancel();
  await assert.rejects(f.close(), { name: "AggregateError" });
  await assert.rejects(access(f.home), { code: "ENOENT" });
  await assert.rejects(fetch(f.remote.origin), /fetch failed/);
});
