import assert from "node:assert/strict";
import { test } from "node:test";
import { resolvePathFlags } from "./entry-paths.ts";

test("the named path flags resolve against the directory the command started in", () => {
  const values = {
    out: ".local/release/serving.json",
    from: ".local/release/plan.json",
    "root-boot": "root-boot.json",
    stage: "production",
    fqn: "PoolWorker",
  };
  resolvePathFlags(values, ["out", "from", "root-boot"], "/repo");
  assert.deepEqual(values, {
    out: "/repo/.local/release/serving.json",
    from: "/repo/.local/release/plan.json",
    "root-boot": "/repo/root-boot.json",
    stage: "production",
    fqn: "PoolWorker",
  });
});

test("an absolute, empty or missing path flag is left as given", () => {
  const values: { out?: string; from?: string; serving?: string } = {
    out: "/elsewhere/out.json",
    from: "",
  };
  resolvePathFlags(values, ["out", "from", "serving"], "/repo");
  assert.deepEqual(values, { out: "/elsewhere/out.json", from: "" });
});
