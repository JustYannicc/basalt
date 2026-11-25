import assert from "node:assert/strict";
import { test } from "node:test";
import {
  alchemyPreviewStateReader,
  capturePreviewInventory,
  inventoryResourceCount,
  mergePreviewInventories,
  type PreviewStateEntry,
  type StateCommand,
} from "./inventory.ts";

const stage = "test-pr-17";
const row = (fqn: string, resourceType: string): PreviewStateEntry => ({
  path: `basalt/${stage}/${fqn}`,
  value: {
    kind: "resource",
    resourceType,
    namespace: undefined,
    fqn,
    logicalId: fqn,
    instanceId: "fixture-instance",
    providerVersion: 1,
    status: "created",
    downstream: [],
    bindings: [],
    props: {},
    attr: {},
  },
});

test("reads exact stage rows and resource values from the configured Alchemy state backend", async () => {
  const primary = [
    row("PoolContainer", "Cloudflare.Container"),
    row("Router", "Cloudflare.Worker"),
  ];
  const database = [
    {
      ...row("PreviewDatabaseParent", "Planetscale.PostgresDatabase"),
      path: `basalt-preview-database/${stage}/PreviewDatabaseParent`,
    },
  ];
  const calls: string[] = [];
  const command: StateCommand = (args, _cwd, env) => {
    calls.push(args.join(" "));
    assert.equal(env.ALCHEMY_STAGE, stage);
    assert.equal(env.CI, "true");
    if (args.includes("list"))
      return {
        status: 0,
        stdout:
          [
            ...primary.map((entry) => entry.path),
            `basalt/${stage}/output`,
            ...database.map((entry) => entry.path),
          ].join("\n") + "\n",
      };
    const requested = args.find(
      (value) => value === `basalt/${stage}` || value === `basalt-preview-database/${stage}`,
    );
    if (requested === `basalt/${stage}`)
      return {
        status: 0,
        stdout: JSON.stringify({
          [primary[0]!.path]: primary[0]!.value,
          [primary[1]!.path]: primary[1]!.value,
          [`basalt/${stage}/output`]: null,
        }),
      };
    return { status: 0, stdout: JSON.stringify(database[0]!.value) };
  };

  const inventory = await capturePreviewInventory(
    { stage },
    alchemyPreviewStateReader({ command, environment: { CLOUDFLARE_API_TOKEN: "fixture" } }),
    "2026-10-24T00:00:00.000Z",
  );
  assert.equal(inventoryResourceCount(inventory), 3);
  assert.deepEqual(
    inventory.stacks.basalt.map((entry) => entry.path),
    [`basalt/${stage}/output`, `basalt/${stage}/PoolContainer`, `basalt/${stage}/Router`],
  );
  assert.deepEqual(
    inventory.stacks["basalt-preview-database"].map((entry) => entry.path),
    database.map((entry) => entry.path),
  );
  assert.ok(
    calls.every(
      (call) => call.includes("--backend configured") && call.includes("alchemy.cleanup.ts"),
    ),
  );
});

test("an authenticated empty response differs from a failed remote-state read", async () => {
  const empty = alchemyPreviewStateReader({
    command: () => ({ status: 0, stdout: "" }),
    environment: {},
  });
  assert.deepEqual(await empty.read(stage), { basalt: [], "basalt-preview-database": [] });

  const unavailable = alchemyPreviewStateReader({
    command: () => ({ status: 1, stdout: "" }),
    environment: {},
  });
  await assert.rejects(unavailable.read(stage), /Authenticated Alchemy remote state read failed/);
});

test("a failed remote-state read keeps the command's error output, credentials removed", async () => {
  const reader = alchemyPreviewStateReader({
    command: () => ({
      status: 2,
      stdout: "",
      stderr: "Bearer fixture-secret-value refused\nstate backend unauthorized\n",
    }),
    environment: { CLOUDFLARE_API_TOKEN: "fixture-secret-value" },
  });
  const error = await reader.read(stage).then(
    () => undefined,
    (failure: unknown) => failure,
  );
  assert.ok(error instanceof Error);
  const cause = error.cause;
  assert.ok(cause instanceof Error);
  assert.match(cause.message, /exit 2/);
  assert.match(cause.message, /state backend unauthorized/);
  assert.doesNotMatch(cause.message, /fixture-secret-value/);
});

test("cleanup retries retain the first exact provider readback when later state is partial", async () => {
  const previous = await capturePreviewInventory(
    { stage },
    {
      read: async () => ({
        basalt: [row("Router", "Cloudflare.Worker")],
        "basalt-preview-database": [],
      }),
    },
    "2026-10-24T00:00:00.000Z",
  );
  const current = await capturePreviewInventory(
    { stage },
    {
      read: async () => ({ basalt: [], "basalt-preview-database": [] }),
    },
    "2026-10-24T00:01:00.000Z",
  );
  const merged = mergePreviewInventories(
    {
      ...previous,
      providers: {
        complete: true,
        containers: [{ applicationId: "app-id", applicationName: "app-name" }],
        domains: [{ id: "domain-id", hostname: "preview.example.invalid", service: "router" }],
      },
    },
    current,
    stage,
  );
  assert.equal(merged.providers.complete, true);
  assert.deepEqual(merged.providers.containers, [
    { applicationId: "app-id", applicationName: "app-name" },
  ]);
  assert.deepEqual(merged.providers.domains, [
    { id: "domain-id", hostname: "preview.example.invalid", service: "router" },
  ]);
  assert.deepEqual(
    merged.stacks.basalt.map((entry) => entry.path),
    previous.stacks.basalt.map((entry) => entry.path),
  );
});

test("no script launches a package bin with a bare bun exec, which drops its arguments or misses the bin", async () => {
  const { execFileSync } = await import("node:child_process");
  const { readFileSync } = await import("node:fs");
  const files = execFileSync("git", ["ls-files", "scripts/*.ts", "scripts/**/*.ts"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter((file) => file && !file.endsWith(".test.ts"));
  // "bun" then "exec" then a bare bin name, on one line or split across lines.
  const offenders = files.filter((file) =>
    /"bun",\s*\[?\s*"exec",\s*"[a-z]/u.test(readFileSync(file, "utf8")),
  );
  assert.deepEqual(offenders, []);
});
