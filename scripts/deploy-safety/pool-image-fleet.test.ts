import assert from "node:assert/strict";
import test from "node:test";
import { assertContainerImage, assertPoolImage } from "./pool-image.ts";

const candidate = "a".repeat(40);
const digest = (value: string) => `sha256:${value.repeat(64)}`;
const image = (value: string) => `registry.cloudflare.com/fixture/pool@${digest(value)}`;
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

function fixture(
  options: {
    bindings?: unknown[];
    instances?: Record<string, unknown[]>;
    application?: (id: string) => unknown;
  } = {},
) {
  const calls: string[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method ?? "GET", "GET");
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.pathname.endsWith("/settings"))
      return Response.json({
        success: true,
        errors: [],
        result: { bindings: options.bindings ?? bindings() },
      });
    const id = url.pathname.split("/").at(url.pathname.endsWith("/instances-v2") ? -2 : -1)!;
    const result = url.pathname.endsWith("/instances-v2")
      ? ((options.instances ?? { root: [], blue: [instance("blue", "3")], green: [] })[id] ?? [])
      : (options.application?.(id) ?? {
          id,
          account_id: "fixture",
          configuration: { image: image(id === "root" ? "1" : id === "blue" ? "3" : "4") },
        });
    return Response.json({ success: true, errors: [], result, result_info: {} });
  };
  return { calls, fetcher };
}

test("retired root accepts a serving bound fleet on its own digest and observes every bound app", async () => {
  const f = fixture();
  const result = await assertPoolImage(receipt, candidate, credentials, f.fetcher);
  assert.deepEqual(result.instances, ["blue-instance"]);
  assert.deepEqual(
    result.fleet?.map((app) => [app.applicationId, app.digest]),
    [
      ["blue", digest("3")],
      ["green", digest("4")],
    ],
  );
  assert.ok(f.calls.some((path) => path.includes("green/instances-v2")));
});

test("an active root retains the original verification path", async () => {
  const f = fixture({ instances: { root: [instance("root", "1")] } });
  const result = await assertPoolImage(receipt, candidate, credentials, f.fetcher);
  assert.deepEqual(result.instances, ["root-instance"]);
  assert.equal(result.fleet, undefined);
  assert.ok(f.calls.every((path) => !path.includes("blue") && !path.includes("green")));
});

test("fleet fallback refuses empty, stale, nonrunning, foreign and duplicate evidence", async () => {
  const cases: (NonNullable<Parameters<typeof fixture>[0]> & { reason: RegExp })[] = [
    { instances: { root: [], blue: [], green: [] }, reason: /no running instance/ },
    { instances: { root: [], blue: [instance("blue", "5")] }, reason: /instance image differs/ },
    {
      instances: { root: [], blue: [{ ...instance("blue", "3"), status: { state: "stopping" } }] },
      reason: /not running/,
    },
    {
      instances: { root: [], blue: [{ ...instance("blue", "3"), application_id: "foreign" }] },
      reason: /foreign/,
    },
    { bindings: [binding("POOL_IMAGE_HASH", receipt.inputHash)], reason: /no running instance/ },
    {
      bindings: [...bindings(), binding("POOL_BLUE_APPLICATION_ID", "other")],
      reason: /duplicate/,
    },
    {
      bindings: bindings().filter((value) => value.name !== "POOL_BLUE_IMAGE_HASH"),
      reason: /inconsistent/,
    },
    {
      bindings: bindings().map((value) =>
        value.name === "POOL_GREEN_APPLICATION_ID" ? { ...value, text: "blue" } : value,
      ),
      reason: /inconsistent/,
    },
    {
      application: (id: string) => ({
        id,
        account_id: "foreign",
        configuration: { image: image("3") },
      }),
      reason: /identity/,
    },
    {
      application: (id: string) => ({
        id,
        account_id: "fixture",
        configuration: { image: "mutable-tag" },
      }),
      reason: /image differs|immutable/,
    },
  ];
  for (const { reason, ...options } of cases)
    await assert.rejects(
      assertPoolImage(receipt, candidate, credentials, fixture(options).fetcher),
      reason,
    );
});

test("recorded container recovery never substitutes a fleet for its exact old container", async () => {
  const f = fixture();
  await assert.rejects(
    assertContainerImage(receipt, credentials, f.fetcher),
    /no running instance/,
  );
  assert.ok(f.calls.every((path) => !path.includes("settings") && !path.includes("blue")));
});
