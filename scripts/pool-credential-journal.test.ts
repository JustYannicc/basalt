import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { armBootstrap, recordBootstrap } from "./pool-credential-bootstrap/journal.ts";
import { fixtureNow, fixturePlan } from "./pool-credential-bootstrap/fixture.ts";
import {
  planDigest,
  secretName,
  type BootstrapPacket,
  type BootstrapPlan,
} from "./pool-credential-bootstrap/contract.ts";
import { programDigest } from "./pool-credential-bootstrap/program.ts";

function packet(plan = fixturePlan()): BootstrapPacket {
  const actions =
    plan.mode === "create"
      ? (["mint", "store"] as const)
      : plan.mode === "rotate"
        ? (["rotate", "store"] as const)
        : (["revoke"] as const);
  return {
    plan,
    approvals: actions.map((action, index) => ({
      id: `${index + 4}4444444-4444-4444-8444-444444444444`,
      action,
      coordinatorGo: true,
      writerLease: "synthetic-writer",
      planDigest: planDigest(plan),
      programDigest: programDigest(plan),
      expiresAt: plan.expiresAt,
    })),
  };
}

async function journal(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "pool-credential-journal-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("emission requires separate exact mint and store approvals", async () =>
  journal(async (directory) => {
    const input = packet();
    for (const approvals of [
      [],
      [input.approvals[0]!],
      [input.approvals[1]!],
      [input.approvals[0]!, input.approvals[0]!],
    ])
      await assert.rejects(
        armBootstrap(directory, { ...input, approvals }, fixtureNow),
        /separate-exact-approvals-required/,
      );
    const changed = {
      ...input,
      approvals: input.approvals.map((approval, index) =>
        index === 0 ? { ...approval, programDigest: "f".repeat(64) } : approval,
      ),
    };
    await assert.rejects(
      armBootstrap(directory, changed, fixtureNow),
      /separate-exact-approvals-required/,
    );
    await assert.rejects(
      armBootstrap(directory, input, input.plan.expiresAt),
      /operation-window-invalid/,
    );
    assert.deepEqual(await readdir(directory), []);
  }));

test("the durable create marker blocks repeated and concurrent emissions, including a new attempt", async () =>
  journal(async (directory) => {
    const input = packet();
    const attempts = await Promise.allSettled([
      armBootstrap(directory, input, fixtureNow),
      armBootstrap(directory, input, fixtureNow),
    ]);
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    const invocation = attempts.find((result) => result.status === "fulfilled");
    assert.equal(invocation?.status, "fulfilled");
    if (invocation?.status === "fulfilled") {
      assert.equal(invocation.value.path, "tools.cloudflare.mcp.execute");
      assert.equal(invocation.value.input.accountId, input.plan.target.connectionId);
      assert.equal(invocation.value.input.input.account_id, input.plan.target.accountId);
      assert.ok(!JSON.stringify(invocation.value).includes("synthetic-private-value"));
    }
    const changed = { ...input.plan, attemptId: "77777777-7777-4777-8777-777777777777" };
    await assert.rejects(
      armBootstrap(directory, packet(changed), fixtureNow),
      /submission-retained-inspect-only/,
    );
    const [scope] = await readdir(directory);
    const retained = JSON.parse(
      await readFile(join(directory, scope!, "create.submission.json"), "utf8"),
    );
    assert.equal(retained.planDigest, planDigest(input.plan));
    assert.equal(retained.programDigest, programDigest(input.plan));
  }));

test("recovery cannot claim a token using only an inspection without an original create submission", async () =>
  journal(async (directory) => {
    const plan: BootstrapPlan = {
      ...fixturePlan(),
      mode: "rotate",
      tokenId: "1".padStart(32, "0"),
    };
    await assert.rejects(
      armBootstrap(directory, packet(plan), fixtureNow),
      /original-create-submission-required/,
    );
    const inspect: BootstrapPlan = { ...plan, mode: "inspect" };
    await assert.rejects(
      recordBootstrap(directory, inspect, {
        tokenId: plan.tokenId,
        secretName: secretName(plan.target),
        outcome: "owned_token",
      }),
      /original-create-submission-required/,
    );
    await assert.rejects(
      armBootstrap(directory, packet(plan), fixtureNow),
      /original-create-submission-required/,
    );
  }));

test("only a retained inspection of the exact owned token permits a separate recovery emission", async () =>
  journal(async (directory) => {
    const create = fixturePlan();
    await armBootstrap(directory, packet(create), fixtureNow);
    const id = "1".padStart(32, "0");
    const rotate: BootstrapPlan = {
      ...create,
      attemptId: "88888888-8888-4888-8888-888888888888",
      mode: "rotate",
      tokenId: id,
    };
    await assert.rejects(
      armBootstrap(directory, packet(rotate), fixtureNow),
      /owned-token-inspection-required/,
    );
    const inspect: BootstrapPlan = {
      ...create,
      attemptId: "99999999-9999-4999-8999-999999999999",
      mode: "inspect",
      tokenId: null,
    };
    await assert.rejects(
      recordBootstrap(directory, inspect, {
        tokenId: id,
        secretName: secretName(create.target),
        outcome: "stored",
      }),
      /inspection-cannot-prove-custody/,
    );
    await recordBootstrap(directory, inspect, {
      tokenId: id,
      secretName: secretName(create.target),
      outcome: "owned_token",
    });
    const invocation = await armBootstrap(directory, packet(rotate), fixtureNow);
    assert.equal(invocation.path, "tools.cloudflare.mcp.execute");
    await assert.rejects(
      armBootstrap(directory, packet(rotate), fixtureNow),
      /submission-retained-inspect-only/,
    );
    await assert.rejects(
      recordBootstrap(directory, rotate, {
        tokenId: id,
        secretName: secretName(create.target),
        outcome: "stored",
        value: "synthetic-private-value",
      }),
    );
    await recordBootstrap(directory, rotate, {
      tokenId: id,
      secretName: secretName(create.target),
      outcome: "stored",
    });
    const [scope] = await readdir(directory);
    for (const file of await readdir(join(directory, scope!)))
      assert.ok(
        !(await readFile(join(directory, scope!, file), "utf8")).includes(
          "synthetic-private-value",
        ),
      );
  }));

test("the CLI exposes review metadata and suppresses raw parsing errors containing values", async () =>
  journal(async (directory) => {
    const plan = fixturePlan(),
      input = join(directory, "plan.json"),
      resultFile = join(directory, "result.json");
    await writeFile(input, JSON.stringify(plan));
    const cli = fileURLToPath(new URL("./pool-credential-bootstrap.ts", import.meta.url));
    const reviewed = spawnSync(process.execPath, [cli, "review", input], { encoding: "utf8" });
    assert.equal(reviewed.status, 0);
    const metadata: unknown = JSON.parse(reviewed.stdout);
    assert.deepEqual(metadata, {
      planDigest: planDigest(plan),
      programDigest: programDigest(plan),
      secretName: secretName(plan.target),
      mode: "create",
    });
    await writeFile(resultFile, '{"value":"synthetic-private-value",invalid');
    const refused = spawnSync(process.execPath, [cli, "record", input, directory, resultFile], {
      encoding: "utf8",
    });
    assert.equal(refused.status, 1);
    assert.equal(refused.stdout, "");
    assert.equal(
      refused.stderr.trim(),
      "Pool credential bootstrap refused: invalid-input-or-journal",
    );
    assert.ok(!refused.stderr.includes("synthetic-private-value"));
  }));
