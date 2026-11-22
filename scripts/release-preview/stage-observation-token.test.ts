import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  deleteLaneToken,
  deleteProgram,
  laneTokenName,
  mintLaneToken,
  requireExpiry,
  mintKeys,
  mintProgram,
  observationPermission,
  toolsServiceTransport,
} from "./stage-observation-token.ts";

const account = "a".repeat(32);
const tokenId = "b".repeat(32);
const expiresOn = new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d{3}Z$/u, "Z");

/** A fake operator connection: the program text runs against `cloudflare.request` and these rows. */
function connection(
  rows: { id: string; name: string; policies?: unknown[]; expires_on?: string }[],
  options: { failProofRead?: boolean; pageSize?: number } = {},
) {
  const sent: string[] = [];
  const cloudflare = {
    request: async (request: {
      method: string;
      path: string;
      body?: { name: string; expires_on?: string };
      query?: { page?: number; per_page?: number };
    }) => {
      sent.push(`${request.method} ${request.path}`);
      if (request.method === "GET" && request.path.endsWith("/tokens")) {
        const size = options.pageSize ?? 1000;
        const page = request.query?.page ?? 1;
        return {
          success: true,
          result: rows.slice((page - 1) * size, page * size),
          result_info: { page, total_pages: Math.max(1, Math.ceil(rows.length / size)) },
        };
      }
      if (request.method === "POST") {
        const row = {
          id: tokenId,
          name: request.body!.name,
          expires_on: request.body!.expires_on,
          policies: [
            {
              effect: "allow",
              permission_groups: [{ id: observationPermission }],
              resources: { [`com.cloudflare.api.account.${account}`]: "*" },
            },
          ],
        };
        rows.push(row);
        return { success: true, result: { ...row, value: "minted-value" } };
      }
      if (request.method === "GET") {
        if (options.failProofRead) return { success: false };
        return { success: true, result: rows.find((row) => request.path.endsWith(row.id)) };
      }
      if (request.method === "DELETE") {
        rows.splice(
          rows.findIndex((row) => request.path.endsWith(row.id)),
          1,
        );
        return { success: true, result: null };
      }
      return { success: false };
    },
  };
  const seen: unknown[] = [];
  const transport = {
    run: async (program: string) => {
      // The operator's runner evaluates the program with `cloudflare` in scope.
      const reply = await (
        new Function("cloudflare", `return (${program})();`) as (c: unknown) => Promise<unknown>
      )(cloudflare);
      seen.push(reply);
      return reply;
    },
  };
  return { transport, sent, rows, seen };
}

test("the mint creates the lane's token with production's one policy, sets the job's secret on stdin, and keeps only the id", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "lane-token-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const record = join(dir, "token.json");
  const { transport, sent, seen } = connection([]);
  const secrets: [string, string][] = [];
  const result = await mintLaneToken({
    accountId: account,
    lane: 2,
    expiresOn,
    record,
    transport,
    setSecret: async (name, value) => void secrets.push([name, value]),
  });
  assert.deepEqual(result, {
    outcome: "minted",
    recorded: true,
    secret: "REHEARSAL_OBSERVATION_TOKEN_2",
  });
  assert.deepEqual(secrets, [["REHEARSAL_OBSERVATION_TOKEN_2", "minted-value"]]);
  // What crossed the operator's connection carried no plaintext value.
  assert.ok(!seen.some((reply) => JSON.stringify(reply).includes("minted-value")));
  assert.ok(!JSON.stringify(result).includes("minted-value"));
  const kept = await readFile(record, "utf8");
  assert.deepEqual(JSON.parse(kept), { lane: 2, tokenId });
  assert.ok(!kept.includes("minted-value"));
  assert.equal((await stat(record)).mode & 0o777, 0o600);
  assert.deepEqual(sent, [
    `GET /accounts/${account}/tokens`,
    `POST /accounts/${account}/tokens`,
    `GET /accounts/${account}/tokens/${tokenId}`,
  ]);
});

test("the mint refuses a lane that already has a token of that name, and sets no secret", async () => {
  const { transport, sent } = connection([{ id: "c".repeat(32), name: laneTokenName(2) }]);
  let set = false;
  const result = await mintLaneToken({
    accountId: account,
    lane: 2,
    expiresOn,
    record: join(tmpdir(), "never-written.json"),
    transport,
    setSecret: async () => void (set = true),
  });
  assert.equal(result.outcome, "refused_existing");
  assert.equal(set, false);
  assert.deepEqual(sent, [`GET /accounts/${account}/tokens`]);
});

test("the delete removes only the recorded id, proves it gone by a list read, then deletes the job's secret", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "lane-token-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const record = join(dir, "token.json");
  const { transport, sent } = connection([]);
  await mintLaneToken({
    accountId: account,
    lane: 2,
    expiresOn,
    record,
    transport,
    setSecret: async () => {},
  });
  const deleted: string[] = [];
  const result = await deleteLaneToken({
    accountId: account,
    lane: 2,
    record,
    transport,
    deleteSecret: async (name) => void deleted.push(name),
  });
  assert.deepEqual(result, {
    outcome: "gone",
    secretDeleted: "REHEARSAL_OBSERVATION_TOKEN_2",
    byName: false,
  });
  assert.deepEqual(deleted, ["REHEARSAL_OBSERVATION_TOKEN_2"]);
  assert.deepEqual(sent.slice(-3), [
    `GET /accounts/${account}/tokens`,
    `DELETE /accounts/${account}/tokens/${tokenId}`,
    `GET /accounts/${account}/tokens`,
  ]);
  await assert.rejects(readFile(record, "utf8"));
});

test("the delete refuses a recorded id that names another token, and a record for another lane", async (t) => {
  const { transport, sent } = connection([
    { id: tokenId, name: "basalt-production-pool-provider-observation" },
  ]);
  const program = deleteProgram(account, 2, tokenId);
  assert.deepEqual(await transport.run(program), { outcome: "refused_ownership" });
  assert.ok(!sent.some((line) => line.startsWith("DELETE")));
  const dir = await mkdtemp(join(tmpdir(), "lane-token-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const record = join(dir, "token.json");
  await writeFile(record, JSON.stringify({ lane: 3, tokenId }));
  await assert.rejects(
    deleteLaneToken({ accountId: account, lane: 2, record, transport }),
    /another lane/u,
  );
});

test("only lanes 1 to 9 and a real account id make a program", () => {
  for (const lane of [0, 10, 2.5])
    assert.throws(() => mintProgram(account, lane, {}, expiresOn), /lane is 1 to 9/u);
  assert.throws(() => mintProgram("production", 2, {}, expiresOn), /account id/u);
  // The expiry is required, a whole-second UTC instant, in the future and within a day.
  const now = Date.parse("2026-11-22T00:20:00Z");
  for (const bad of [
    "",
    "2026-11-22T00:19:59Z",
    "2026-11-23T00:20:01Z",
    "2026-11-22T07:00Z",
    "tomorrow",
  ])
    assert.throws(() => requireExpiry(bad, now), /expiry/u, bad);
  assert.equal(requireExpiry("2026-11-22T07:00:00Z", now), "2026-11-22T07:00:00Z");
  assert.throws(() => deleteProgram(account, 2, "not-an-id"), /token id/u);
});

test("the tools-service transport accepts a pause only for its own program, and returns the program's result", async () => {
  const replies = (code: string, status: string) => {
    const queue = [
      {},
      {},
      {
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "approval-required",
                requestId: "apr_1",
                invocation: { input: { accountId: "acc_x", input: { code, account_id: account } } },
              }),
            },
          ],
        },
      },
      {
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status,
                execution: {
                  ok: true,
                  value: {
                    ok: true,
                    value: { content: [{ type: "text", text: '{"outcome":"gone"}' }] },
                  },
                },
              }),
            },
          ],
        },
      },
    ];
    const sent: unknown[] = [];
    const fake = (async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify(queue.shift() ?? {}), {
        headers: { "Mcp-Session-Id": "s1" },
      });
    }) as unknown as typeof fetch;
    return { fake, sent };
  };
  const program = "async () => ({outcome:'gone'})";
  const own = replies(program, "completed");
  const transport = toolsServiceTransport({
    url: "http://tools.invalid/mcp",
    headers: {},
    connection: "acc_x",
    accountId: account,
    fetch: own.fake,
  });
  assert.deepEqual(await transport.run(program), { outcome: "gone" });
  assert.deepEqual((own.sent[3] as { params: { name: string; arguments: unknown } }).params, {
    name: "resume",
    arguments: { requestId: "apr_1", response: { action: "accept", content: {} } },
  });
  const other = replies("async () => 'something else'", "completed");
  await assert.rejects(
    toolsServiceTransport({
      url: "http://tools.invalid/mcp",
      headers: {},
      connection: "acc_x",
      accountId: account,
      fetch: other.fake,
    }).run(program),
    /not the one this process submitted/u,
  );
  assert.equal(other.sent.length, 3);
  const failed = replies(program, "failed");
  await assert.rejects(
    toolsServiceTransport({
      url: "http://tools.invalid/mcp",
      headers: {},
      connection: "acc_x",
      accountId: account,
      fetch: failed.fake,
    }).run(program),
    /did not complete/u,
  );
});

test("a token created before a later step fails still comes back with its id, so it can be deleted", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "lane-token-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const record = join(dir, "token.json");
  const { transport } = connection([], { failProofRead: true });
  const result = await mintLaneToken({
    accountId: account,
    lane: 2,
    expiresOn,
    record,
    transport,
    setSecret: async () => assert.fail("no secret after a failed mint"),
  });
  assert.equal(result.outcome, "unknown");
  assert.equal(result.recorded, true);
  assert.deepEqual(JSON.parse(await readFile(record, "utf8")), { lane: 2, tokenId });
});

test("with no record the delete takes the lane's one token by name, and refuses two", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "lane-token-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const record = join(dir, "missing.json");
  const one = connection([{ id: tokenId, name: laneTokenName(2) }]);
  const result = await deleteLaneToken({
    accountId: account,
    lane: 2,
    record,
    transport: one.transport,
    deleteSecret: async () => {},
  });
  assert.deepEqual(result, {
    outcome: "gone",
    secretDeleted: "REHEARSAL_OBSERVATION_TOKEN_2",
    byName: true,
  });
  const two = connection([
    { id: tokenId, name: laneTokenName(2) },
    { id: "c".repeat(32), name: laneTokenName(2) },
  ]);
  assert.deepEqual(
    await deleteLaneToken({ accountId: account, lane: 2, record, transport: two.transport }),
    { outcome: "refused_inventory" },
  );
});

test("the mint's existence check reads every page of tokens", async () => {
  const many = Array.from({ length: 100 }, (_, index) => ({
    id: index.toString(16).padStart(32, "0"),
    name: `other-${index}`,
  }));
  const { transport, sent } = connection([...many, { id: tokenId, name: laneTokenName(2) }], {
    pageSize: 100,
  });
  const reply = (await transport.run(mintProgram(account, 2, mintKeys().publicJwk, expiresOn))) as {
    outcome: string;
  };
  assert.equal(reply.outcome, "refused_existing");
  assert.ok(sent.filter((line) => line === `GET /accounts/${account}/tokens`).length >= 2);
});
