import assert from "node:assert/strict";
import { test } from "node:test";
import { ordinaryReleaseWriter } from "./runtime-release-writer.ts";
import { provisioningAuthority } from "./provisioning-contract.ts";

const environment = () => ({
  GITHUB_ACTIONS: "true",
  GITHUB_REF: "refs/heads/main",
  GITHUB_JOB: "deploy",
  GITHUB_REPOSITORY: "JustYannicc/basalt",
  GITHUB_WORKFLOW_REF: "JustYannicc/basalt/.github/workflows/deploy.yml@refs/heads/main",
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "2",
  BASALT_RELEASE_CANDIDATE: "a".repeat(40),
  ALCHEMY_STAGE: "production",
});

test("ordinary writer authority is confined to the production deploy jobs and exact candidate", () => {
  for (const file of ["deploy.yml", "release-main.yml", "release-manual.yml"]) {
    const env = {
      ...environment(),
      GITHUB_WORKFLOW_REF: `JustYannicc/basalt/.github/workflows/${file}@refs/heads/main`,
    };
    const enable = ordinaryReleaseWriter(env).enable("b".repeat(64));
    assert.equal(enable.coordinatorGo, undefined);
    assert.equal(enable.writerLease, "deploy-production:123:2");
    assert.equal(provisioningAuthority(enable, env.BASALT_RELEASE_CANDIDATE), true);
    assert.equal(provisioningAuthority(enable, "c".repeat(40)), false);
    assert.equal(
      provisioningAuthority({ ...enable, writerLease: "other" }, env.BASALT_RELEASE_CANDIDATE),
      false,
    );
  }
  for (const changes of [
    { GITHUB_ACTIONS: "false" },
    { GITHUB_REF: "refs/pull/1/merge" },
    { GITHUB_JOB: "backup" },
    { GITHUB_REPOSITORY: "other/basalt" },
    { GITHUB_WORKFLOW_REF: "JustYannicc/basalt/.github/workflows/check.yml@refs/heads/main" },
    { GITHUB_RUN_ID: "" },
    { GITHUB_RUN_ATTEMPT: "0" },
    { ALCHEMY_STAGE: "test" },
    { BASALT_RELEASE_CANDIDATE: "main" },
  ])
    assert.throws(
      () => ordinaryReleaseWriter({ ...environment(), ...changes }),
      /runtime-release-exclusive-writer-unavailable/,
    );
});

test("exclusive work serializes writes, propagates failures and rejects expired or changed ownership", async () => {
  const env = environment();
  let now = 100;
  const writer = ordinaryReleaseWriter(env, () => now);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered: string[] = [];
  const first = writer.exclusive(async () => {
    entered.push("first");
    await held;
    throw new Error("synthetic failed write");
  });
  const rejected = assert.rejects(first, /synthetic failed write/);
  const second = writer.exclusive(async () => {
    entered.push("second");
  });
  await Promise.resolve();
  assert.deepEqual(entered, ["first"]);
  release();
  await rejected;
  await second;
  assert.deepEqual(entered, ["first", "second"]);
  env.GITHUB_RUN_ATTEMPT = "3";
  await assert.rejects(
    writer.exclusive(async () => {
      entered.push("foreign");
    }),
    /runtime-release-writer-expired/,
  );
  env.GITHUB_RUN_ATTEMPT = "2";
  now += 6 * 60 * 60_000;
  assert.throws(() => writer.enable("b".repeat(64)), /runtime-release-writer-expired/);
  assert.deepEqual(entered, ["first", "second"]);
});
