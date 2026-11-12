import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { auditDeployToken } from "./token-audit.ts";

const token = "synthetic-private-deployment-token";
const account = "a".repeat(32),
  id = "b".repeat(32);
const writeGroup = { id: "5bc3f8b21c554832afc660159ab75fa4", name: "Account API Tokens Write" };
const readGroup = { id: "cfd39eebc07c4e3ea849e4b3d2644637", name: "Workers Containers Read" };
const policy = (effect = "allow", target = account) => ({
  effect,
  resources: { [`com.cloudflare.api.account.${target}`]: "*" },
  permission_groups: [writeGroup, readGroup],
});
const reply = (result: unknown, status = 200) =>
  Response.json({ success: true, errors: [], result }, { status });

function fixture(
  options: {
    accountOwned?: boolean;
    status?: string;
    policies?: unknown[];
    wrongId?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const fetcher = async (input: string, init: RequestInit) => {
    const url = new URL(input);
    assert.equal(url.origin, "https://api.cloudflare.com");
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${token}`);
    assert.ok(init.signal);
    calls.push(url.pathname);
    const root = options.accountOwned ? `/client/v4/accounts/${account}` : "/client/v4/user";
    if (!url.pathname.startsWith(`${root}/tokens/`)) return new Response(null, { status: 403 });
    if (url.pathname.endsWith("/verify"))
      return reply({ id, status: options.status ?? "active", value: token });
    assert.equal(url.pathname, `${root}/tokens/${id}`);
    return reply({
      id: options.wrongId ? "c".repeat(32) : id,
      status: "active",
      policies: options.policies ?? [policy()],
      value: token,
      name: token,
    });
  };
  return { calls, fetcher, run: () => auditDeployToken(token, account, fetcher) };
}

test("user and account token audits only read self metadata and disclose names plus status", async () => {
  for (const accountOwned of [false, true]) {
    const f = fixture({ accountOwned });
    assert.deepEqual(await f.run(), {
      status: "active_with_account_token_write",
      permissionGroups: ["Account API Tokens Write", "Workers Containers Read"],
    });
    const output = JSON.stringify(await f.run());
    for (const privateValue of [token, account, id])
      assert.equal(output.includes(privateValue), false);
    assert.equal(
      f.calls.some((path) => path.endsWith("/value")),
      false,
    );
    assert.equal(f.calls.length, accountOwned ? 6 : 4);
  }
});

test("foreign-account and denied grants do not establish permission to create account tokens", async () => {
  for (const policies of [
    [policy("allow", "c".repeat(32))],
    [policy(), policy("deny")],
    [{ ...policy(), permission_groups: [readGroup] }],
  ]) {
    assert.equal((await fixture({ policies }).run()).status, "active_without_account_token_write");
  }
  const wildcard = { ...policy(), resources: { "com.cloudflare.api.account.*": "*" } };
  assert.equal(
    (await fixture({ policies: [wildcard] }).run()).status,
    "active_with_account_token_write",
  );
});

test("inactive, malformed and unreadable metadata remains unverified", async () => {
  for (const status of ["expired", "disabled"] as const)
    assert.deepEqual(await fixture({ status }).run(), { status, permissionGroups: [] });
  assert.equal((await fixture({ wrongId: true }).run()).status, "metadata_unavailable");
  assert.equal(
    (
      await fixture({
        policies: [{ ...policy(), permission_groups: [{ ...writeGroup, name: token }] }],
      }).run()
    ).status,
    "metadata_unavailable",
  );
  const unavailable = await auditDeployToken(token, account, async () => {
    throw new Error(token);
  });
  assert.deepEqual(unavailable, { status: "verification_unavailable", permissionGroups: [] });
});

test("oversized provider bodies are cancelled and never become an audit result", async () => {
  let cancelled = 0;
  const result = await auditDeployToken(
    token,
    account,
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(524_289));
          },
          cancel() {
            cancelled++;
          },
        }),
      ),
  );
  assert.equal(result.status, "verification_unavailable");
  assert.equal(cancelled, 2);
});

test("missing credentials and invalid account IDs never make a request", async () => {
  const fetcher = async () => {
    throw new Error("must not call");
  };
  assert.equal((await auditDeployToken("", account, fetcher)).status, "invalid_input");
  assert.equal((await auditDeployToken(token, "not-an-account", fetcher)).status, "invalid_input");
});

test("the command never prints a raw error containing the credential", () => {
  const script = new URL("./token-audit-run.ts", import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `globalThis.fetch=async()=>{throw new Error(process.env.CLOUDFLARE_API_TOKEN)}; await import(${JSON.stringify(script)});`,
    ],
    {
      encoding: "utf8",
      env: { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account },
    },
  );
  assert.equal(child.status, 1);
  assert.equal(child.stderr, "");
  assert.deepEqual(JSON.parse(child.stdout), {
    status: "verification_unavailable",
    permissionGroups: [],
  });
  assert.equal(child.stdout.includes(token), false);
});
