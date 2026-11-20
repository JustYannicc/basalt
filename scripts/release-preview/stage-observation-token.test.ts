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
  mintProgram,
  observationPermission,
} from "./stage-observation-token.ts";

const account = "a".repeat(32);
const tokenId = "b".repeat(32);

/** A fake operator connection: the program text runs against `cloudflare.request` and these rows. */
function connection(rows: { id: string; name: string; policies?: unknown[] }[]) {
  const sent: string[] = [];
  const cloudflare = {
    request: async (options: { method: string; path: string; body?: { name: string } }) => {
      sent.push(`${options.method} ${options.path}`);
      if (options.method === "GET" && options.path.endsWith("/tokens"))
        return { success: true, result: rows };
      if (options.method === "POST") {
        const row = {
          id: tokenId,
          name: options.body!.name,
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
      if (options.method === "GET")
        return { success: true, result: rows.find((row) => options.path.endsWith(row.id)) };
      if (options.method === "DELETE") {
        rows.splice(
          rows.findIndex((row) => options.path.endsWith(row.id)),
          1,
        );
        return { success: true, result: null };
      }
      return { success: false };
    },
  };
  const transport = {
    run: async (program: string) =>
      // The operator's runner evaluates the program with `cloudflare` in scope.
      (new Function("cloudflare", `return (${program})();`) as (c: unknown) => Promise<unknown>)(
        cloudflare,
      ),
  };
  return { transport, sent, rows };
}

test("the mint creates the lane's token with production's one policy, sets the job's secret on stdin, and keeps only the id", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "lane-token-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const record = join(dir, "token.json");
  const { transport, sent } = connection([]);
  const secrets: [string, string][] = [];
  const result = await mintLaneToken({
    accountId: account,
    lane: 2,
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
  assert.deepEqual(result, { outcome: "gone", secretDeleted: "REHEARSAL_OBSERVATION_TOKEN_2" });
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
    assert.throws(() => mintProgram(account, lane), /lane is 1 to 9/u);
  assert.throws(() => mintProgram("production", 2), /account id/u);
  assert.throws(() => deleteProgram(account, 2, "not-an-id"), /token id/u);
});
