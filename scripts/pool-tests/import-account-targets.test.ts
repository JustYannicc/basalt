import assert from "node:assert/strict";
import { test } from "node:test";
import { HomeClient } from "../../src/pool/control.ts";
import { fixture } from "../../src/pool/test/control.ts";
import { importAccountTargets } from "../../src/pool/model-history/import-account-targets.ts";

test("operator targets come only from enabled destination pool members and refresh removals", async () => {
  const f = await fixture();
  f.home.addFile("selected", "codex");
  f.home.addFile("disabled", "codex", { disabled: true });
  f.home.addFile("elsewhere", "claude");
  f.home.addFile("unselected", "codex");
  f.home.addGroup("pool-a", 1, ["selected", "disabled", "missing"]);
  f.home.addGroup("pool-b", 2, ["elsewhere"]);
  const client = new HomeClient(f.deps.home);
  assert.deepEqual(await importAccountTargets(client, "pool-a"), [
    { id: "selected", provider: "codex" },
  ]);
  f.home.members = f.home.members.filter((member) => member.auth_id !== "selected");
  assert.deepEqual(await importAccountTargets(client, "pool-a"), []);
  assert.ok(f.home.calls.every((call) => call.method === "GET"));
  assert.ok(f.home.calls.every((call) => !call.path.includes("/auth-files")));
});
