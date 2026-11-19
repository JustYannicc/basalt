import assert from "node:assert/strict";
import { test } from "node:test";

interface Channel {
  install(
    configuration: { signingKey: string; managementKey: string },
    policy: {
      pool: string;
      organization: string;
      revision: number;
      expiresAt: number;
      accounts: string[];
      dirty: boolean;
    },
  ): Promise<void>;
}
const channelModule = "./runtime-slots/channel.ts";
const { RuntimeChannel } = (await import(channelModule)) as {
  RuntimeChannel: new (
    ctx: { container: { getTcpPort(port: number): { fetch(): Promise<Response> } } },
    env: object,
  ) => Channel;
};

test("a projection the plugin refuses logs its closed reason inside the runtime", async (context) => {
  const log = context.mock.method(console, "error", () => {});
  // The container clock runs 3.8 s behind the signing Worker, so a 12 s projection looks 15.8 s
  // long against the plugin's 15 s maximum.
  const refused = () =>
    Response.json(
      { error: "invalid_projection", reason: "lease_window", leaseMs: 15_800 },
      { status: 400 },
    );
  const channel = new RuntimeChannel(
    { container: { getTcpPort: () => ({ fetch: async () => refused() }) } },
    {},
  );
  await assert.rejects(
    channel.install(
      { signingKey: "ab".repeat(32), managementKey: "fixture-management-key" },
      {
        pool: "fixture-pool",
        organization: "fixture-organization",
        revision: 3,
        expiresAt: Date.now() + 12_000,
        accounts: ["fixture-account"],
        dirty: false,
      },
    ),
  );
  const lines = log.mock.calls.filter((call) => call.arguments[0] === "pool_guard_failure");
  assert.equal(lines.length, 1);
  assert.deepEqual(
    { ...lines[0]!.arguments[1], elapsedMs: undefined },
    {
      guard: "native_policy_install",
      failure: "response_status",
      backendStatus: 400,
      reason: "lease_window",
      leaseMs: 15_800,
      phase: "acknowledgement",
      elapsedMs: undefined,
      deadlineAborted: false,
    },
  );
  assert.doesNotMatch(JSON.stringify(log.mock.calls), /fixture-(account|management)|abababab/);
});
