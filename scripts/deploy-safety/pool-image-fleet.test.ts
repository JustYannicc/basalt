import assert from "node:assert/strict";
import test from "node:test";
import { assertContainerImage, assertPoolImage, waitForPoolImage } from "./pool-image.ts";

const candidate = "a".repeat(40);
const digest = (value: string) => `sha256:${value.repeat(64)}`;
const image = (value: string, account = "fixture") =>
  `registry.cloudflare.com/${account}/pool@${digest(value)}`;
const receipt = {
  candidate,
  applicationId: "root",
  accountId: "fixture",
  workerName: "worker",
  inputHash: "b".repeat(16),
  digest: digest("1"),
  configDigest: digest("2"),
  platform: "linux/amd64",
  capabilityLabel: "1",
};
const credentials = { accountId: "fixture", apiToken: "synthetic-never-sent" };
const binding = (name: string, text: string) => ({ name, type: "plain_text", text });
const bindings = () => [
  binding("POOL_IMAGE_HASH", receipt.inputHash),
  binding("POOL_DESIRED_IMAGE_INPUT", "c".repeat(16)),
  binding("POOL_BLUE_APPLICATION_ID", "blue"),
  binding("POOL_BLUE_IMAGE_HASH", "c".repeat(16)),
  binding("POOL_GREEN_APPLICATION_ID", "green"),
  binding("POOL_GREEN_IMAGE_HASH", "d".repeat(16)),
];
const instance = (application: string, value: string) => ({
  id: `${application}-instance`,
  application_id: application,
  image: image(value),
  status: { state: "running" },
});
const configured: Record<string, string> = { root: "1", blue: "3", green: "4" };
const application = (id: string) => ({
  id,
  account_id: "fixture",
  configuration: { image: image(configured[id]!) },
});

interface Fixture {
  bindings?: unknown[];
  instances?: Record<string, unknown[]>;
  fleetApplication?: (id: string) => unknown;
}

function fixture(options: Fixture = {}) {
  const calls: string[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method ?? "GET", "GET");
    const url = new URL(String(input));
    calls.push(url.pathname);
    const reply = (result: unknown) =>
      Response.json({ success: true, errors: [], result, result_info: {} });
    if (url.pathname.endsWith("/settings"))
      return reply({ bindings: options.bindings ?? bindings() });
    if (url.pathname.endsWith("/instances-v2")) {
      const id = url.pathname.split("/").at(-2)!;
      return reply(
        (options.instances ?? { root: [], blue: [instance("blue", "3")], green: [] })[id] ?? [],
      );
    }
    const id = url.pathname.split("/").at(-1)!;
    return reply(id === "root" ? application(id) : (options.fleetApplication ?? application)(id));
  };
  return { calls, fetcher };
}

test("a retired root accepts the fleet serving the desired input on its own configured digest", async () => {
  const f = fixture();
  const result = await assertPoolImage(receipt, candidate, credentials, f.fetcher);
  assert.equal(result.verifiedPath, "bound-fleet");
  assert.deepEqual(result.instances, ["blue-instance"]);
  assert.deepEqual(
    result.fleet?.map((app) => [app.color, app.applicationId, app.digest, app.instances.length]),
    [
      ["BLUE", "blue", digest("3"), 1],
      ["GREEN", "green", digest("4"), 0],
    ],
  );
  assert.equal(f.calls.filter((path) => path.endsWith("/applications/green")).length, 1);
});

test("an active root keeps the original verification path and reads no fleet application", async () => {
  const f = fixture({ instances: { root: [instance("root", "1")] } });
  const result = await assertPoolImage(receipt, candidate, credentials, f.fetcher);
  assert.equal(result.verifiedPath, "root");
  assert.deepEqual(result.instances, ["root-instance"]);
  assert.ok(f.calls.every((path) => !path.includes("blue") && !path.includes("green")));
});

test("each missing, stale, foreign or inconsistent fleet fact refuses with its own reason", async () => {
  const without = (name: string) => bindings().filter((value) => value.name !== name);
  const replace = (name: string, text: string) =>
    bindings().map((value) => (value.name === name ? { ...value, text } : value));
  const cases: (Fixture & { reason: RegExp })[] = [
    {
      bindings: [binding("POOL_IMAGE_HASH", receipt.inputHash)],
      reason: /: Pool has no running instance to verify$/,
    },
    {
      instances: { root: [], blue: [], green: [] },
      reason:
        /no running instance in its root or in a bound fleet application on POOL_DESIRED_IMAGE_INPUT/,
    },
    {
      instances: { root: [], green: [instance("green", "4")] },
      reason: /on POOL_DESIRED_IMAGE_INPUT c{16}/,
    },
    {
      instances: { root: [], blue: [instance("blue", "5")] },
      reason: /: Pool BLUE fleet application instance image differs from its configured digest$/,
    },
    {
      instances: { root: [], blue: [{ ...instance("blue", "3"), status: { state: "stopping" } }] },
      reason:
        /no running instance in its root or in a bound fleet application on POOL_DESIRED_IMAGE_INPUT/,
    },
    {
      instances: { root: [], blue: [{ ...instance("blue", "3"), application_id: "other" }] },
      reason:
        /: Pool BLUE fleet application instance list contains a duplicate or foreign instance/,
    },
    {
      instances: {
        root: [],
        blue: [instance("blue", "3")],
        green: [{ ...instance("blue", "4"), application_id: "green" }],
      },
      reason: /listed by both fleet applications/,
    },
    {
      bindings: [...bindings(), binding("POOL_BLUE_APPLICATION_ID", "other")],
      reason: /: Pool Worker binding POOL_BLUE_APPLICATION_ID is duplicated$/,
    },
    {
      bindings: without("POOL_BLUE_IMAGE_HASH"),
      reason:
        /: Pool Worker binding POOL_BLUE_IMAGE_HASH is missing while POOL_BLUE_APPLICATION_ID is set$/,
    },
    {
      bindings: without("POOL_GREEN_APPLICATION_ID"),
      reason:
        /: Pool Worker binding POOL_GREEN_APPLICATION_ID is missing while POOL_GREEN_IMAGE_HASH is set$/,
    },
    {
      bindings: replace("POOL_BLUE_IMAGE_HASH", "mutable"),
      reason: /: Pool Worker binding POOL_BLUE_IMAGE_HASH is not a 16-hex image input$/,
    },
    {
      bindings: replace("POOL_GREEN_APPLICATION_ID", "blue"),
      reason:
        /: Pool Worker binding POOL_GREEN_APPLICATION_ID reuses the root or the other color's application$/,
    },
    {
      bindings: replace("POOL_BLUE_APPLICATION_ID", "root"),
      reason:
        /: Pool Worker binding POOL_BLUE_APPLICATION_ID reuses the root or the other color's application$/,
    },
    {
      bindings: without("POOL_DESIRED_IMAGE_INPUT"),
      reason: /: Pool Worker binding POOL_DESIRED_IMAGE_INPUT is missing/,
    },
    {
      bindings: bindings().map((value) =>
        value.name === "POOL_BLUE_IMAGE_HASH" ? { ...value, type: "secret_text" } : value,
      ),
      reason: /: Pool Worker binding POOL_BLUE_IMAGE_HASH is not plain text$/,
    },
    {
      fleetApplication: (id) => ({ ...application(id), id: "other" }),
      reason:
        /: Pool BLUE fleet application identity differs from its PoolWorker binding POOL_BLUE_APPLICATION_ID: id$/,
    },
    {
      fleetApplication: (id) => ({ ...application(id), account_id: "foreign" }),
      reason:
        /: Pool BLUE fleet application identity differs from its PoolWorker binding POOL_BLUE_APPLICATION_ID: account_id$/,
    },
    {
      fleetApplication: (id) => ({
        ...application(id),
        configuration: { image: "registry.cloudflare.com/fixture/pool:latest" },
      }),
      reason:
        /: Pool BLUE fleet application configuration.image is not pinned by an immutable digest$/,
    },
    {
      fleetApplication: (id) => ({
        ...application(id),
        configuration: { image: image(configured[id]!, "foreign") },
      }),
      reason:
        /: Pool BLUE fleet application configuration.image is outside this account's registry$/,
    },
  ];
  for (const { reason, ...options } of cases)
    await assert.rejects(
      assertPoolImage(receipt, candidate, credentials, fixture(options).fetcher),
      reason,
      String(reason),
    );
});

test("recorded container recovery never substitutes a fleet for its exact old container", async () => {
  const f = fixture();
  await assert.rejects(
    assertContainerImage(receipt, credentials, f.fetcher),
    /: Pool has no running instance to verify$/,
  );
  assert.ok(f.calls.every((path) => !path.includes("settings") && !path.includes("blue")));
});

test("the post-deploy wait keeps retrying while the fleet starts and then accepts it", async () => {
  let rounds = 0;
  const f = fixture();
  const starting = fixture({ instances: { root: [], blue: [], green: [] } });
  let now = 0;
  const verified = await waitForPoolImage(
    receipt,
    candidate,
    credentials,
    "https://pool.fixture.invalid",
    async (input, init) => {
      if (new URL(String(input)).hostname === "pool.fixture.invalid") {
        rounds++;
        return new Response(null, { status: 401 });
      }
      return (rounds < 3 ? starting : f).fetcher(input, init);
    },
    { now: () => now, sleep: async (ms: number) => void (now += ms) },
  );
  assert.equal(verified.verifiedPath, "bound-fleet");
  assert.equal(rounds, 3);
});

test("a starting or stopping fleet cell does not stall verification while another serves", async () => {
  const stopping = { ...instance("blue", "5"), id: "blue-old", status: { state: "stopping" } };
  const f = fixture({
    instances: { root: [], blue: [stopping, instance("blue", "3")], green: [] },
  });
  const result = await assertPoolImage(receipt, candidate, credentials, f.fetcher);
  assert.deepEqual(result.instances, ["blue-instance"]);
});
