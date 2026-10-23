import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { discoverStack, discoverStackDetails, discoverStackInventory, resourceId } from "./native-stack.ts";
import { declarationFetch, fixtureAccount, inventoryDeclarations, safeName, validateInventory } from "./native-stack-fixtures.ts";
import { nativeFixture } from "./native-stack-fixture-helpers.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()));
function fixture(body: string) {
  const fixture = nativeFixture(join(root, "node_modules"), body);
  cleanups.push(fixture.dispose);
  return fixture;
}
const worker = (exports: Record<string, unknown> = {}) => ({
  Type: "Cloudflare.Worker", FQN: "Parent/Worker", LogicalId: "Worker", Props: { exports },
});

test("resource keys hash the full type and FQN with one NUL separator", () => {
  expect(resourceId("Cloudflare.Worker", "Api")).toBe("resource-7f364888022c1c43fcbe11b269aa78fde2db078d4edcdaf288f4eeb3e6952091");
  expect(resourceId("Other.Worker", "Api")).not.toBe(resourceId("Cloudflare.Worker", "Api"));
  expect(resourceId("A", "B\0C")).toBe(`resource-${createHash("sha256").update("A\0B\0C").digest("hex")}`);
});

test("only declared class exports add resources; remote namespaces and migration data do not", () => {
  const w = worker({ Local: { kind: "durableObject", constructor: "never serialize" }, Flow: { kind: "workflow" }, Migrations: { kind: "sqlMigrations", snapshot: "never serialize" }, default: () => {} });
  const inventory = inventoryDeclarations([w, { Type: "Cloudflare.Workflow", FQN: "Parent/Flow", LogicalId: "Flow" }], {
    "Parent/Worker": [{ data: { bindings: [{ name: "Remote", type: "durable_object_namespace", scriptName: "never serialize" }] } }],
  });
  expect(inventory.resources).toContainEqual({ type: "Cloudflare.DurableObject", fqn: "Parent/Worker/exports/Local", declaredName: "Local" });
  expect(inventory.resources).toHaveLength(3);
  expect(inventory.workers[0]!.bindings).toEqual([{ name: "Remote", kind: "durable_object_namespace:remote" }]);
  expect(JSON.stringify(inventory)).not.toContain("never serialize");
  expect(() => inventoryDeclarations([worker({ Future: { kind: "futureClass" } })], {})).toThrow("Unknown native Worker export kind");
  expect(() => inventoryDeclarations([worker({ Flow: { kind: "workflow" } })], {})).toThrow("Unmatched native workflow export");
});

test("binding values and deferred Outputs stay opaque", () => {
  const deferred = () => { throw new Error("must not execute"); };
  const w = { ...worker(), Props: { env: { SECRET: "https://secret.invalid", OMITTED: undefined }, bindings: [deferred], exports: {} } };
  const result = inventoryDeclarations([w], {}, value => value === deferred);
  expect(result.workers).toEqual([{ fqn: "Parent/Worker", bindings: [{ name: "SECRET", kind: "env" }], deferredBindingCount: 1 }]);
  expect(JSON.stringify(result)).not.toContain("secret.invalid");
});

test("local namespace classes use className and deduplicate exports and binding contributions", () => {
  const w = { ...worker({ Local: { kind: "durableObject" } }), Props: {
    exports: { Local: { kind: "durableObject" } },
    bindings: [{ name: "LocalAlias", type: "durable_object_namespace", className: "Local" }],
  } };
  const result = inventoryDeclarations([w], {
    "Parent/Worker": [{ data: { bindings: [
      { name: "RepeatedAlias", type: "durable_object_namespace", className: "Local" },
      { name: "ExternalClassAlias", type: "durable_object_namespace", className: "ExternalClass" },
      { name: "RemoteAlias", type: "durable_object_namespace", className: "RemoteClass", scriptName: "remote-worker" },
      { name: "NamespaceIdOnly", type: "durable_object_namespace", namespaceId: "opaque" },
    ] } }],
  });
  expect(result.resources.filter(resource => resource.type === "Cloudflare.DurableObject")).toEqual([
    { type: "Cloudflare.DurableObject", fqn: "Parent/Worker/exports/ExternalClass", declaredName: "ExternalClass" },
    { type: "Cloudflare.DurableObject", fqn: "Parent/Worker/exports/Local", declaredName: "Local" },
  ]);
  expect(result.workers[0]!.bindings).toContainEqual({ name: "RemoteAlias", kind: "durable_object_namespace:remote" });
  expect(JSON.stringify(result)).not.toContain("opaque");
});

test("deferred namespace metadata cannot invent local classes and remains counted", () => {
  const deferred = () => { throw new Error("must not execute"); };
  const result = inventoryDeclarations([worker()], {
    "Parent/Worker": [{ data: { bindings: [deferred,
      { name: "UnknownHost", type: "durable_object_namespace", className: "UnknownClass", scriptName: deferred },
      { name: "UnknownClass", type: "durable_object_namespace", className: deferred },
    ] } }],
  }, value => value === deferred);
  expect(result.resources).toHaveLength(1);
  expect(result.workers[0]).toEqual({ fqn: "Parent/Worker", deferredBindingCount: 3, bindings: [
    { name: "UnknownClass", kind: "durable_object_namespace:unresolved" },
    { name: "UnknownHost", kind: "durable_object_namespace:unresolved" },
  ] });
});

test("an actual external Worker Container binding declares its class without Props.exports", () => {
  const f = fixture(`
    const image = Cloudflare.Container("Image", { image: "fixture/image:local", className: "ContainerClass" });
    yield* Cloudflare.Worker("ExternalWorker", {
      main: new URL("./worker.ts", import.meta.url).pathname,
      env: { ContainerAlias: image },
    });
  `);
  const result = discoverStackDetails(f.root);
  expect(result.inventory).toEqual(expect.arrayContaining([
    { id: resourceId("Cloudflare.Container", "Image"), kind: "Container", source: "alchemy.run.ts", declaredName: "Image" },
    { id: resourceId("Cloudflare.DurableObject", "ExternalWorker/exports/ContainerClass"), kind: "DurableObject", source: "alchemy.run.ts", declaredName: "ContainerClass", ownerId: resourceId("Cloudflare.Worker", "ExternalWorker") },
  ]));
  expect(result.workers).toEqual([{ fqn: "ExternalWorker", deferredBindingCount: 0, bindings: [
    { name: "ContainerAlias", kind: "durable_object_namespace:local" },
    { name: "ContainerAlias", kind: "env" },
  ] }]);
}, 40_000);

test("invalid names, duplicate identities and extra envelope fields fail closed", () => {
  for (const name of ["https://secret.invalid", "two words", "line\nbreak", "x\0y"])
    expect(() => safeName(name)).toThrow("Invalid native declaration name");
  expect(() => inventoryDeclarations([worker(), worker()], {})).toThrow("Duplicate native resource identity");
  const valid = inventoryDeclarations([worker()], {});
  expect(() => validateInventory({ ...valid, props: "secret" })).toThrow("Invalid native inventory fields");
  expect(() => validateInventory({ ...valid, resources: [{ ...valid.resources[0], url: "https://secret.invalid" }] })).toThrow("Invalid native inventory fields");
});

test("only exact GET fixtures are accepted and caught denials still poison evaluation", async () => {
  const allowed = declarationFetch("fixture.invalid");
  const url = `https://api.cloudflare.com/client/v4/zones?account.id=${fixtureAccount}&name=fixture.invalid&per_page=1`;
  expect((await (await allowed.fetch(url)).json()).result).toHaveLength(1);
  expect((await (await allowed.fetch(`https://api.cloudflare.com/client/v4/accounts/${fixtureAccount}/workers/scripts`)).json()).result).toEqual([]);
  allowed.assertAllowed();
  for (const [target, init] of [[url + "&per_page=1", undefined], [url, { method: "POST" }], ["https://other.invalid/secret", undefined], [url + "&token=secret", undefined]] as const) {
    const denied = declarationFetch("fixture.invalid");
    await expect(denied.fetch(target, init)).rejects.toThrow("unexpected request");
    expect(() => denied.assertAllowed()).toThrow("unexpected request");
  }
});

test("actual root keeps Workers and their stateful classes in the inventory", () => {
  const result = discoverStackDetails(root);
  const workers = result.inventory.filter(resource => resource.kind === "Worker");
  expect(workers.length).toBeGreaterThanOrEqual(14);
  expect(workers.map(resource => resource.declaredName)).toEqual(expect.arrayContaining(["Api", "Router", "PoolWorker"]));
  const objects = result.inventory.filter(resource => resource.kind === "DurableObject");
  expect(objects.map(resource => resource.declaredName)).toEqual(expect.arrayContaining(["ScheduleCoordinator", "AppDataSupervisor", "McpSession", "PoolContainer"]));
  expect(objects.find(resource => resource.declaredName === "PoolContainer")).toEqual({
    id: resourceId("Cloudflare.DurableObject", "PoolWorker/exports/PoolContainer"), kind: "DurableObject", source: "alchemy.run.ts", declaredName: "PoolContainer", ownerId: resourceId("Cloudflare.Worker", "PoolWorker"),
  });
  expect(result.workers.find(worker => worker.fqn === "PoolWorker")!.bindings).toContainEqual({ name: "PoolContainer", kind: "durable_object_namespace:local" });
  for (const object of objects) expect(workers.some(worker => worker.id === object.ownerId)).toBe(true);
  expect(new Set(result.inventory.map(resource => resource.id)).size).toBe(result.inventory.length);
  expect(result.workers.flatMap(worker => worker.bindings).length).toBeGreaterThan(0);
  expect(result.workers.every(worker => Number.isInteger(worker.deferredBindingCount))).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/https?:\/\/|fixture-api-token|never serialize/);
}, 40_000);

test("subprocess ignores inherited settings and library logs, and rereads changed source", () => {
  const f = fixture('console.log("https://secret.invalid"); if (process.env.CLOUDFLARE_API_TOKEN || process.env.HOME) throw new Error("inherited"); yield* Resource("Test.First")("One", {});');
  expect(discoverStackInventory(f.root)).toEqual([{ id: resourceId("Test.First", "One"), kind: "First", source: "alchemy.run.ts", declaredName: "One" }]);
  f.write('yield* Resource("Test.Second")("Two", {});');
  expect(discoverStack(f.root)).toEqual([{ id: resourceId("Test.Second", "Two"), kind: "Second", source: "alchemy.run.ts" }]);
}, 60_000);

test("a caught unmatched fetch still fails with no request values in the error", () => {
  const f = fixture('yield* Effect.promise(async () => { try { await fetch("https://secret.invalid/token-value"); } catch {} });');
  let failure: unknown;
  try { discoverStack(f.root); } catch (error) { failure = error; }
  expect(String(failure)).toMatch(/Native stack inventory evaluate failed/);
  expect(String(failure)).not.toMatch(/secret.invalid|token-value/);
}, 60_000);

