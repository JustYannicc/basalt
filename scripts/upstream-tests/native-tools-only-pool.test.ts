// A device approved for tools only reaches the person's own tools. Its access checks and token
// refreshes must keep working while the pool's control plane is down; a device with models still
// asks the pool every time. The pool here is the real control endpoint, served over HTTP.
import assert from "node:assert/strict";
import { test } from "node:test";
import { pool } from "../../src/pool/test/computers.ts";
import { handleSetup } from "../../src/setup/host.ts";
import { device, origin } from "./native-pool-device-fixture.ts";

test("a tools-only device keeps its access check and refresh while the pool's control plane fails", async (t) => {
  const d = await device(t, false);
  d.fail();
  const asked = d.asked();
  const checked = await d.access(d.tokens.access_token);
  assert.equal(checked.status, 200, await checked.clone().text());
  const answer = await checked.json();
  assert.equal(answer.policy.models, false);
  assert.equal(answer.policy.toolsOrganization, d.team);
  assert.deepEqual(answer.display, {
    account: { name: "Device owner", email: "device-owner@example.invalid", emailVerified: true },
    pool: { id: pool.pool, name: "" },
    pools: [],
  });
  const refreshed = await d.refresh(d.tokens.refresh_token);
  assert.equal(refreshed.status, 200, await refreshed.clone().text());
  const next = (await refreshed.json()) as { access_token: string };
  const again = await d.access(next.access_token);
  assert.equal(again.status, 200, await again.clone().text());
  assert.equal(d.asked(), asked, "a tools-only device asks the pool nothing");
});

test("a tools-only device is still refused once it leaves its tools team", async (t) => {
  const d = await device(t, false);
  d.fail();
  await d.f.adapter.deleteMany({
    model: "member",
    where: [
      { field: "userId", value: d.f.userId },
      { field: "organizationId", value: d.team },
    ],
  });
  assert.equal((await d.access(d.tokens.access_token)).status, 401);
  const refreshed = await d.refresh(d.tokens.refresh_token);
  assert.equal(refreshed.status, 400, await refreshed.clone().text());
  assert.equal((await refreshed.json()).error, "invalid_grant");
});

test("a device with models still asks the pool on every check and refresh", async (t) => {
  const d = await device(t, true);
  const before = d.asked();
  const checked = await d.access(d.tokens.access_token);
  assert.equal(checked.status, 200, await checked.clone().text());
  assert.equal(d.asked(), before + 1, "the pool answers for a device with models");
  d.fail();
  const down = d.asked();
  assert.equal((await d.access(d.tokens.access_token)).status, 503);
  assert.equal(d.asked(), down + 1);
  assert.equal((await d.refresh(d.tokens.refresh_token)).status, 503);
  assert.ok(d.asked() > down + 1, "the refresh asked the pool too");
});

test("revoking a tools-only device on Connect signs it out at the tools service", async (t) => {
  const d = await device(t, false);
  const [computer] = Object.keys(await d.p.registry());
  // A device without a model key holds nothing at Home, so a stopped container changes nothing.
  d.p.server.stopped = true;
  const answers: { path: string; status: number; refusal: string }[] = [];
  const removed = await handleSetup(
    new Request(`${origin}/setup/v1/computers/${computer}?intent=${encodeURIComponent(d.intent)}`, {
      method: "DELETE",
      headers: { cookie: d.f.cookies, origin },
    }),
    {
      POOL_APP_SIGNING_KEY: "ab".repeat(32),
      TOOLS_SERVICE: {
        fetch: async (request) => {
          const response = await d.f.handler(request);
          const call = {
            path: new URL(request.url).pathname,
            status: response.status,
            refusal: response.ok ? "" : await response.clone().text(),
          };
          answers.push(call);
          return response;
        },
      },
      POOL_SERVICE: {
        fetch: (request) => {
          d.p.advance(Date.now() - d.p.now());
          return d.p.setup(request);
        },
      },
    },
  );
  assert.equal(removed.status, 200, `${await removed.clone().text()} ${JSON.stringify(answers)}`);
  const grant = await d.f.adapter.findOne<{ revoked: boolean }>({
    model: "mcpGrant",
    where: [{ field: "userId", value: d.f.userId }],
  });
  assert.equal(grant?.revoked, true, "the device's grant is revoked as the person");
  assert.equal((await d.access(d.tokens.access_token)).status, 401);
  assert.equal((await d.refresh(d.tokens.refresh_token)).status, 400);
  assert.equal((await d.p.registry())[computer!]?.state, "revoked");
});
