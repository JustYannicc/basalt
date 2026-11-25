import assert from "node:assert/strict";
import { test } from "node:test";
import {
  alchemyPreviewStateReader,
  capturePreviewInventory,
  inventoryKindsLine,
  inventoryResourceCount,
  mergePreviewInventories,
  parsePreviewInventory,
  previewStacks,
  readNumberedRehearsalStages,
  readProductionRecords,
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
    if (args.includes("list")) {
      // Each stack lists its stage directories; only then is the one stage listed recursively.
      const at = args[args.indexOf("list") + 1];
      if (at === "--config")
        return { status: 0, stdout: "basalt/\nbasalt-preview-database/\nbasalt-rehearsal/\n" };
      if (at === "basalt") return { status: 0, stdout: `basalt/test-pr-99/\nbasalt/${stage}/\n` };
      if (at === "basalt-preview-database")
        return { status: 0, stdout: `basalt-preview-database/${stage}/\n` };
      if (at === `basalt/${stage}`)
        return {
          status: 0,
          stdout:
            [...primary.map((entry) => entry.path), `basalt/${stage}/output`].join("\n") + "\n",
        };
      if (at === `basalt-preview-database/${stage}`)
        return { status: 0, stdout: database.map((entry) => entry.path).join("\n") };
      throw new Error(`unexpected list ${at}`);
    }
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

test("a rehearsal reads its own stack name and refuses records from a PR stack", async () => {
  const rehearsal = "test-rehearsal-17";
  const router = {
    ...row("Router", "Cloudflare.Worker"),
    path: `basalt-rehearsal/${rehearsal}/Router`,
  };
  const reads: string[] = [];
  const reader = alchemyPreviewStateReader({
    command: (args) => {
      if (args.includes("list")) {
        const at = args[args.indexOf("list") + 1];
        // The fixture stack was never written: it is absent from the stack names, never listed.
        if (at === "--config")
          return { status: 0, stdout: "basalt/\nbasalt-rehearsal/\nbasalt-preview-database/\n" };
        if (at === "basalt-rehearsal-fixture")
          return { status: 1, stdout: "error: basalt-rehearsal-fixture: path does not exist" };
        if (at === "basalt-rehearsal")
          return { status: 0, stdout: `basalt-rehearsal/${rehearsal}/\n` };
        if (at === `basalt-rehearsal/${rehearsal}`)
          return { status: 0, stdout: `${router.path}\n` };
        return { status: 0, stdout: "" };
      }
      reads.push(args.find((value) => value.includes("/"))!);
      return { status: 0, stdout: JSON.stringify(router.value) };
    },
    environment: {},
  });
  const inventory = await capturePreviewInventory(
    { stage: rehearsal },
    reader,
    "2026-10-24T00:00:00.000Z",
  );
  assert.deepEqual(Object.keys(inventory.stacks), [
    "basalt-rehearsal",
    "basalt-preview-database",
    "basalt-rehearsal-fixture",
  ]);
  assert.deepEqual(reads, [`basalt-rehearsal/${rehearsal}`]);
  assert.equal(inventoryResourceCount(inventory), 1);
  assert.deepEqual(previewStacks(stage), ["basalt", "basalt-preview-database"]);
  assert.throws(
    () =>
      parsePreviewInventory(
        {
          ...inventory,
          stacks: {
            basalt: inventory.stacks["basalt-rehearsal"],
            "basalt-preview-database": [],
            "basalt-rehearsal-fixture": [],
          },
        },
        rehearsal,
      ),
    /unexpected fields/,
  );
  for (const other of ["production", "test-e2e-17", "test-pr-0"])
    await assert.rejects(reader.read(other));
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

test("the state reader runs the CLI with this process's PATH, and a failure shows both output streams", async () => {
  const { alchemyPreviewStateReader } = await import("./inventory.ts");
  const seen: NodeJS.ProcessEnv[] = [];
  const reader = alchemyPreviewStateReader({
    environment: { CLOUDFLARE_API_TOKEN: "fixture-secret-token" },
    command: (_args, _cwd, env) => {
      seen.push(env);
      return {
        status: 1,
        stdout: "Error: Cloudflare State store not found",
        stderr: "used fixture-secret-token",
      };
    },
  });
  await assert.rejects(
    reader.read("test-rehearsal-7"),
    (error: Error) =>
      /exit 1/.test(error.message) &&
      /State store not found/.test(error.message) &&
      /used \[redacted\]/.test(error.message) &&
      !error.message.includes("fixture-secret-token"),
  );
  assert.equal(seen[0]!.PATH, process.env.PATH);
  assert.equal(seen[0]!.ALCHEMY_STAGE, "test-rehearsal-7");
});

test("a listing line outside the stage is refused and named, with secrets redacted", async () => {
  const reader = alchemyPreviewStateReader({
    environment: { CLOUDFLARE_API_TOKEN: "fixture-secret-token" },
    command: (args) => {
      const at = args[args.indexOf("list") + 1];
      if (at === "--config") return { status: 0, stdout: "basalt/\n" };
      if (at === "basalt") return { status: 0, stdout: `basalt/${stage}/\n` };
      if (at === `basalt/${stage}`)
        return { status: 0, stdout: "basalt/production/Router fixture-secret-token\n" };
      return { status: 0, stdout: "" };
    },
  });
  await assert.rejects(
    reader.read(stage),
    (error: Error) =>
      error.message.includes("malformed remote state path") &&
      error.message.includes("[redacted]") &&
      !error.message.includes("fixture-secret-token"),
  );
});

test("a brand-new stage whose stacks the store never held reads as empty without listing them", async () => {
  const listed: string[] = [];
  const reader = alchemyPreviewStateReader({
    environment: {},
    command: (args) => {
      const at = args[args.indexOf("list") + 1]!;
      listed.push(at);
      if (at === "--config") return { status: 0, stdout: "basalt/\nbasalt-preview-database/\n" };
      if (at === "basalt" || at === "basalt-preview-database")
        return { status: 0, stdout: `${at}/production/\n` };
      return { status: 1, stdout: `error: ${at}: path does not exist` };
    },
  });
  assert.deepEqual(await reader.read("test-rehearsal-9"), {
    "basalt-rehearsal": [],
    "basalt-preview-database": [],
    "basalt-rehearsal-fixture": [],
  });
  assert.deepEqual(listed, ["--config", "basalt-preview-database"]);
});

test("alchemy's progress lines on stdout are not state paths", async () => {
  const reader = alchemyPreviewStateReader({
    environment: {},
    command: (args) => {
      const at = args[args.indexOf("list") + 1];
      const progress =
        "• Refreshing Cloudflare State Store credentials\n✓ Refreshing Cloudflare State Store credentials\n";
      if (at === "--config") return { status: 0, stdout: `${progress}basalt/\n` };
      if (at === "basalt") return { status: 0, stdout: `${progress}basalt/production/\n` };
      return { status: 1, stdout: "" };
    },
  });
  assert.deepEqual(await reader.read(stage), { basalt: [], "basalt-preview-database": [] });
});

test("progress lines before a state read's JSON are not part of the document", async () => {
  const router = row("Router", "Cloudflare.Worker");
  const progress =
    "• Refreshing Cloudflare State Store credentials\n✓ Refreshing Cloudflare State Store credentials\n";
  const reader = alchemyPreviewStateReader({
    environment: {},
    command: (args) => {
      if (args.includes("read"))
        return { status: 0, stdout: `${progress}${JSON.stringify(router.value)}\n` };
      const at = args[args.indexOf("list") + 1];
      if (at === "--config") return { status: 0, stdout: `${progress}basalt/\n` };
      if (at === "basalt") return { status: 0, stdout: `${progress}basalt/${stage}/\n` };
      if (at === `basalt/${stage}`) return { status: 0, stdout: `${progress}${router.path}\n` };
      return { status: 1, stdout: "" };
    },
  });
  const stacks = await reader.read(stage);
  assert.deepEqual(
    stacks.basalt.map((entry) => entry.path),
    [router.path],
  );
});

test("the numbered rehearsal stages are listed and read, never written, with rows by kind", async () => {
  const lane = "test-rehearsal-1";
  const bucket = (stack: string, stage: string, fqn: string) => ({
    path: `${stack}/${stage}/${fqn}`,
    value: row(fqn, "Cloudflare.R2.Bucket").value,
  });
  const old = [
    bucket("basalt-rehearsal", "test-rehearsal-1234", "AppBuilds"),
    bucket("basalt-rehearsal", "test-rehearsal-1234", "SiteAssets"),
  ];
  const calls: string[][] = [];
  const command: StateCommand = (args, _cwd, env) => {
    calls.push([...args]);
    assert.equal(env.ALCHEMY_STAGE, lane);
    const verb = args[args.indexOf("state") + 1];
    const at = args[args.indexOf("state") + 2];
    if (verb === "list" && at === "--config")
      return { status: 0, stdout: "basalt/\nbasalt-rehearsal/\nbasalt-preview-database/\n" };
    if (verb === "list" && at === "basalt-rehearsal")
      // A lane, a stage of each other width, and two four-digit stages.
      return {
        status: 0,
        stdout: [1, 12, 1234, 5678, 12345]
          .map((n) => `basalt-rehearsal/test-rehearsal-${n}/`)
          .join("\n"),
      };
    if (verb === "list" && at === "basalt-preview-database")
      return { status: 0, stdout: "basalt-preview-database/test-rehearsal-1234/\n" };
    if (verb === "list" && at === "basalt-rehearsal/test-rehearsal-1234")
      return {
        status: 0,
        stdout: [
          ...old.map((entry) => entry.path),
          "basalt-rehearsal/test-rehearsal-1234/output",
        ].join("\n"),
      };
    if (verb === "list" && at === "basalt-preview-database/test-rehearsal-1234")
      return { status: 0, stdout: "basalt-preview-database/test-rehearsal-1234/Branch\n" };
    if (verb === "list" && at === "basalt-rehearsal/test-rehearsal-5678")
      return { status: 0, stdout: "" };
    if (verb === "read" && at === "basalt-rehearsal/test-rehearsal-1234")
      return {
        status: 0,
        stdout: JSON.stringify({
          ...Object.fromEntries(old.map((entry) => [entry.path, entry.value])),
          "basalt-rehearsal/test-rehearsal-1234/output": null,
        }),
      };
    if (verb === "read" && at === "basalt-preview-database/test-rehearsal-1234")
      return { status: 0, stdout: JSON.stringify(row("Branch", "Planetscale.Branch").value) };
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  const stages = await readNumberedRehearsalStages(lane, { command, environment: {} });
  assert.deepEqual(stages, [
    {
      stage: "test-rehearsal-1234",
      stacks: {
        "basalt-rehearsal": { "Cloudflare.R2.Bucket": 2, output: 1 },
        "basalt-preview-database": { "Planetscale.Branch": 1 },
      },
    },
    { stage: "test-rehearsal-5678", stacks: { "basalt-rehearsal": {} } },
  ]);
  // Only lists and reads: nothing here can change the store.
  assert.ok(calls.every((args) => ["list", "read"].includes(args[args.indexOf("state") + 1]!)));
  await assert.rejects(readNumberedRehearsalStages("test-pr-17", { command, environment: {} }));
});

test("a destroy's first line counts what State records by kind, and names nothing", () => {
  const line = inventoryKindsLine({
    version: 1,
    capturedAt: "2026-11-24T00:00:00.000Z",
    stacks: {
      "basalt-rehearsal": [
        {
          path: "basalt-rehearsal/test-rehearsal-1/AppBuilds",
          value: row("AppBuilds", "Cloudflare.R2.Bucket").value,
        },
        {
          path: "basalt-rehearsal/test-rehearsal-1/SiteAssets",
          value: row("SiteAssets", "Cloudflare.R2.Bucket").value,
        },
        {
          path: "basalt-rehearsal/test-rehearsal-1/Api",
          value: row("Api", "Cloudflare.Worker").value,
        },
        { path: "basalt-rehearsal/test-rehearsal-1/output", value: null },
      ],
      "basalt-preview-database": [],
    },
    providers: {
      complete: true,
      containers: [{ applicationId: "app-1", applicationName: "basalt-rehearsal-poolcontainer-x" }],
      domains: [],
    },
  });
  assert.equal(
    line,
    "The destroy is about to delete what State records, by kind: basalt-rehearsal: Cloudflare.R2.Bucket 2, Cloudflare.Worker 1; basalt-preview-database: none. The provider read found 1 container application(s) and 0 domain(s).",
  );
  assert.doesNotMatch(line, /AppBuilds|app-1|poolcontainer|test-rehearsal-1/u);
});

test("a numbered stage that cannot be read is marked, and the others are still read", async () => {
  const command: StateCommand = (args) => {
    const verb = args[args.indexOf("state") + 1];
    const at = args[args.indexOf("state") + 2];
    if (verb === "list" && at === "--config") return { status: 0, stdout: "basalt-rehearsal/\n" };
    if (verb === "list" && at === "basalt-rehearsal")
      return {
        status: 0,
        stdout: "basalt-rehearsal/test-rehearsal-1111/\nbasalt-rehearsal/test-rehearsal-2222/\n",
      };
    // The first stage lists a path outside itself; the second holds nothing.
    if (verb === "list" && at === "basalt-rehearsal/test-rehearsal-1111")
      return { status: 0, stdout: "basalt-rehearsal/test-rehearsal-9999/Api\n" };
    if (verb === "list" && at === "basalt-rehearsal/test-rehearsal-2222")
      return { status: 0, stdout: "" };
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  const [first, second] = await readNumberedRehearsalStages("test-rehearsal-1", {
    command,
    environment: {},
  });
  assert.equal(first?.stage, "test-rehearsal-1111");
  assert.match(first?.unreadable ?? "", /malformed remote state path/u);
  assert.deepEqual(second, { stage: "test-rehearsal-2222", stacks: { "basalt-rehearsal": {} } });
});

test("the lanes are read beside the four-digit stages only when asked", async () => {
  const command: StateCommand = (args) => {
    const verb = args[args.indexOf("state") + 1];
    const at = args[args.indexOf("state") + 2];
    if (verb === "list" && at === "--config") return { status: 0, stdout: "basalt-rehearsal/\n" };
    if (verb === "list" && at === "basalt-rehearsal")
      return {
        status: 0,
        stdout: [2, 12, 2313].map((n) => `basalt-rehearsal/test-rehearsal-${n}/`).join("\n"),
      };
    if (verb === "list") return { status: 0, stdout: "" };
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  const stages = (lanes: boolean) =>
    readNumberedRehearsalStages("test-rehearsal-1", { command, environment: {}, lanes }).then(
      (rows) => rows.map(({ stage }) => stage),
    );
  assert.deepEqual(await stages(false), ["test-rehearsal-2313"]);
  assert.deepEqual(await stages(true), ["test-rehearsal-2", "test-rehearsal-2313"]);
});

test("production's databases, ids and names are read once from its State, privately", async () => {
  const at = "basalt/production";
  const rows: Record<string, unknown> = {
    [`${at}/Database`]: {
      ...(row("Database", "Planetscale.PostgresDatabase").value as object),
      attr: { id: "prod-id", name: "basalt" },
    },
    [`${at}/Api`]: {
      ...(row("Api", "Cloudflare.Worker").value as object),
      attr: { workerName: "basalt-api-production" },
    },
    [`${at}/Ca`]: {
      ...(row("Ca", "Cloudflare.MtlsCertificate").value as object),
      attr: { id: "shared-ca" },
    },
  };
  const command =
    (shown: Record<string, unknown>, fail = false): StateCommand =>
    (args) => {
      const verb = args[args.indexOf("state") + 1]!;
      assert.ok(["list", "read"].includes(verb));
      if (fail && verb === "read") return { status: 1, stdout: "secret value" };
      return verb === "list"
        ? { status: 0, stdout: Object.keys(shown).join("\n") }
        : { status: 0, stdout: JSON.stringify(shown) };
    };
  const records = await readProductionRecords("test-rehearsal-1", {
    command: command(rows),
    environment: {},
  });
  assert.deepEqual(records.databases, [{ id: "prod-id", name: "basalt" }]);
  // The shared trust root is never production's alone, so it is no proof against a stage.
  assert.deepEqual([...records.identities].sort(), ["basalt", "basalt-api-production", "prod-id"]);
  await assert.rejects(
    readProductionRecords("test-rehearsal-1", { command: command(rows, true), environment: {} }),
    (error: Error) => error.message === "Production's State could not be read",
  );
  const { [`${at}/Database`]: _database, ...noDatabase } = rows;
  await assert.rejects(
    readProductionRecords("test-rehearsal-1", { command: command(noDatabase), environment: {} }),
    /records no PlanetScale database/,
  );
});
