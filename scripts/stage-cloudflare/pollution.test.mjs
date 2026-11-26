// Every field the stage module reads, set on Object.prototype with a hostile value: each operation
// must send exactly the requests, and return exactly the answers, it does on a clean prototype, and
// nothing outside the stage. This file runs in its own process; the prototype is restored after
// each field.
import assert from "node:assert/strict";
import { test } from "node:test";
import { stageCloudflare } from "./api.mjs";
import { accountId, outsideCalls, sharedAccount, stageReach } from "./test/stage-reach.mjs";

const prefix = "basalt-180-scale";
const production = "/../basalt-production-poolworker";
/**
 * Each field name the module, its requests, options, steps, tables and answers read. `headers` is
 * left out: Node's own Response constructor reads it through its init's prototype, so setting it
 * breaks the account's answers instead of testing the module, which builds its headers itself.
 */
const FIELDS = [
  ["kind", "operation", "target", "reference", "body", "access"],
  ["accountId", "token", "prefix", "owns", "owned", "fetcher", "signal"],
  ["below", "method", "list", "path", "url", "query", "label", "absent", "registry", "accept"],
  ["entry", "readBack", "byName", "owner", "operations", "known", "tags", "digests"],
  ["id", "name", "script", "class", "configuration", "image", "result", "result_info"],
  ["total_pages", "success", "errors", "code", "message", "subdomain", "repositories"],
  ["manifests", "digest", "children", "username", "user", "password", "permissions"],
  ["credentials", "status", "ok", "link", "data", "send"],
].flat();
/** What each field is set to: a function where the module calls one, otherwise a hostile value. */
const hostile = (field, called) =>
  ["fetcher", "signal", "owns", "owned", "send"].includes(field)
    ? () => {
        called.push(field);
        return true;
      }
    : ["absent", "readBack", "byName", "success", "ok"].includes(field)
      ? true
      : ["total_pages", "status", "code"].includes(field)
        ? 1
        : ["result", "repositories", "tags", "manifests", "children", "errors"].includes(field)
          ? [production]
          : ["result_info", "configuration", "known", "entry", "headers", "body"].includes(field)
            ? { id: "prod-app", image: production, total_pages: 1 }
            : field === "method"
              ? "DELETE"
              : field === "list"
                ? `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/basalt-production-poolworker/content`
                : production;

/** A fresh account, and the oracle of what the stage may reach in it, built on a clean prototype. */
function account() {
  const fake = sharedAccount(prefix);
  return { fake, reach: stageReach(fake, prefix) };
}

/** Every operation of the stage API on `fake`: what was sent and what came back. */
async function everyOperation(fake) {
  const answers = [];
  const settle = async (label, attempt) => {
    try {
      answers.push([label, JSON.stringify(await attempt())]);
    } catch (error) {
      answers.push([label, `threw ${error.message}`]);
    }
  };
  const api = stageCloudflare({
    accountId,
    token: "t",
    prefix,
    fetcher: fake.fetcher,
    signal: () => undefined,
  });
  const found = await api.inventory([
    "applications",
    "namespaces",
    "scripts",
    "drives",
    "certificates",
  ]);
  answers.push(["inventory", JSON.stringify(found)]);
  const app = found.applications.find((row) => row.id === "own-app");
  const [image] = await api.images();
  await settle("read", () => api.read("applications", app));
  await settle("settings by name", () => api.settings(`${prefix}-gateway`));
  await settle("settings by row", () => api.settings(found.scripts[0]));
  await settle("patch", () => api.patch("applications", app, { max_instances: 1 }));
  await settle("rollout", () => api.rollout("applications", app, { description: "x" }));
  await settle("subdomain", () => api.subdomain());
  await settle("imageReferences", () => api.imageReferences());
  await settle("removeImage", () => api.removeImage(image));
  await settle("images", () => api.images());
  await settle("remove namespace", () => api.remove("namespaces", found.namespaces[0]));
  await settle("remove drive", () => api.remove("drives", found.drives[0]));
  await settle("remove certificate", () => api.remove("certificates", found.certificates[0]));
  await settle("remove application", () => api.remove("applications", app));
  await settle("remove Worker", () => api.remove("scripts", found.scripts[0]));
  return answers;
}
const sentTo = (fake) => fake.calls.map((call) => `${call.method} ${call.url}`);

test("a field set on Object.prototype changes no request and no answer", async () => {
  const clean = account();
  const cleanAnswers = await everyOperation(clean.fake);
  assert.deepEqual(outsideCalls(clean.fake, prefix, clean.reach), []);
  assert.ok(sentTo(clean.fake).some((call) => call.startsWith("DELETE ")));
  for (const field of FIELDS) {
    const called = [];
    const had = Object.hasOwn(Object.prototype, field);
    assert.equal(had, false, `Object.prototype already has ${field}`);
    const polluted = account();
    let answers;
    Object.prototype[field] = hostile(field, called);
    try {
      answers = await everyOperation(polluted.fake);
    } finally {
      delete Object.prototype[field];
    }
    assert.deepEqual(outsideCalls(polluted.fake, prefix, polluted.reach), [], field);
    assert.deepEqual(sentTo(polluted.fake), sentTo(clean.fake), field);
    assert.deepEqual(answers, cleanAnswers, field);
    assert.deepEqual(called, [], field);
  }
});
