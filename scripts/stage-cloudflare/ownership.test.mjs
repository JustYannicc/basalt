import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { stageCloudflare } from "./api.mjs";
import { RELEASE_FIRST_WORDS, prefixRefusal, stageOwnership } from "./ownership.mjs";

const root = new URL("../../", import.meta.url);
const read = (file) => readFileSync(new URL(file, root), "utf8");
const tracked = (...paths) =>
  execFileSync("git", ["ls-files", "--", ...paths], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((file) => /\.[cm]?[jt]s$/u.test(file));
const shipped = (file) => !/\.test\.|\/test\/|fixture/u.test(file);
const releaseSource = tracked("alchemy.run.ts", "infrastructure", "src").filter(shipped);

// The release stack's own resource ids (Cloudflare.Worker("PoolWorker"), ...), as Alchemy names
// them: lower case, after the app name and the stage.
const releaseIds = [
  ...new Set(
    releaseSource.flatMap((file) =>
      [
        ...read(file).matchAll(
          /\b(?:Worker|Container|DurableObject|DurableObjectNamespace|Hyperdrive|R2Bucket|KVNamespace|Queue|D1Database|Workflow|Website|SecretsStore)\(\s*"([A-Za-z][A-Za-z0-9]*)"/gu,
        ),
      ].map((match) => match[1].toLowerCase()),
    ),
  ),
];
// Every name the release stack and its operators spell out in full, and the production and
// rehearsal names the release tooling's tests use.
const releaseLiterals = [
  ...new Set(
    [...releaseSource, ...tracked("scripts/release", "scripts/pool-fleet")].flatMap((file) =>
      [...read(file).matchAll(/["'`](basalt-[a-z0-9]+(?:-[a-z0-9]+)*)/gu)].map((match) => match[1]),
    ),
  ),
];
const releaseStages = [
  "production",
  "test-rehearsal-2",
  "test-rehearsal-20",
  "test-pr-7",
  "preview-pr-7",
];
const productionNames = [
  ...releaseLiterals,
  ...releaseStages.flatMap((stage) =>
    releaseIds.flatMap((id) => [`basalt-${stage}-${id}`, `basalt-${id}-${stage}`]),
  ),
  "basalt",
  "basalt-api",
  "basalt-pool",
  "basalt-pool-runtime-blue",
  "basalt-poolcontainer-production-0123abcd",
  "production-pool",
];
// The stage tools' own prefixes: scale-180, test-emulated-upstream, test-route-scratch-1 and -2.
// Each must be accepted below, so this list and ownership.mjs's STAGE_PREFIXES cannot drift apart.
const stagePrefixes = [
  "basalt-180-scale",
  "basalt-emulated-upstream",
  "basalt-route-scratch-1",
  "basalt-route-scratch-2",
];

test("the production names come from the release stack's source", () => {
  assert.ok(releaseIds.includes("poolworker") && releaseIds.includes("poolcontainer"), releaseIds);
  assert.ok(releaseLiterals.includes("basalt-production-poolworker"), releaseLiterals.length);
  assert.ok(productionNames.length > 100, productionNames.length);
  // A release id or name with a first word the module does not reserve fails here first.
  for (const id of releaseIds) assert.ok(RELEASE_FIRST_WORDS.includes(id), id);
});

test("no stage prefix owns a production name", () => {
  for (const prefix of stagePrefixes) {
    assert.equal(prefixRefusal(prefix), undefined, prefix);
    const owned = stageOwnership(prefix);
    for (const name of productionNames) assert.equal(owned(name), false, `${prefix} owns ${name}`);
    assert.equal(owned(`${prefix}-gateway`), true);
    assert.equal(owned(prefix), false, "the prefix alone is no resource's name");
    assert.equal(owned(`${prefix}x-gateway`), false, "a longer word is another stage");
  }
});

test("a prefix that could own a production name is refused before any call", () => {
  const refused = new Set(["", "b", "basalt", "basalt-", "basalt-x", "basalt-180", "Basalt-a-b"]);
  // Every production name, and every leading run of its words, as a prefix.
  for (const name of productionNames) {
    const words = name.split("-");
    for (let end = 1; end <= words.length; end++) refused.add(words.slice(0, end).join("-"));
  }
  refused.add("basalt-test-rehearsal-9");
  refused.add("basalt-poolcontainer-staging");
  refused.add(`basalt-${"a".repeat(50)}-b`);
  let calls = 0;
  const fetcher = async () => (calls++, Response.json({}));
  for (const prefix of refused) {
    if (prefix.startsWith("basalt-") && prefix.split("-").length >= 3 && !prefixRefusal(prefix))
      assert.fail(`${prefix} is a production name's start and would be accepted`);
    assert.throws(
      () => stageCloudflare({ accountId: "acct", token: "t", prefix, fetcher }),
      /^Error: Refused stage prefix/u,
      prefix,
    );
  }
  for (const prefix of [undefined, null, 7, ["basalt-a-b"]])
    assert.throws(() => stageOwnership(prefix), /Refused stage prefix/u);
  assert.equal(calls, 0);
});

test("a predicate that accepts a production name is refused at construction", () => {
  const prefix = "basalt-emulated-upstream";
  for (const owns of [
    () => true,
    (name) => name.includes("pool"),
    (name) => name.startsWith("basalt-production"),
    (name) => name.endsWith("-production"),
    (name) => name !== `${prefix}-gateway`,
  ])
    assert.throws(() => stageOwnership(prefix, owns), /predicate accepts a release stack's name/u);
  assert.throws(() => stageOwnership(prefix, "basalt-production"), /owns must be a function/u);
  // A narrowing predicate is accepted, and still cannot reach past the prefix.
  const owned = stageOwnership(prefix, (name) => name.endsWith("-gateway"));
  assert.equal(owned(`${prefix}-gateway`), true);
  assert.equal(owned(`${prefix}-mock`), false);
  assert.equal(owned("basalt-production-gateway"), false);
});

test("no stage owns another stage's names, and an unregistered prefix is no stage's", () => {
  for (const prefix of stagePrefixes)
    for (const other of stagePrefixes)
      if (other !== prefix) {
        assert.ok(!other.startsWith(`${prefix}-`), `${prefix} continues into ${other}`);
        assert.equal(stageOwnership(prefix)(`${other}-gateway`), false, `${prefix} owns ${other}`);
      }
  const fetcher = async () => assert.fail("a refused prefix called the account");
  for (const prefix of ["basalt-route-scratch", "basalt-180-scale-big", "basalt-other-stage"])
    assert.throws(
      () => stageCloudflare({ accountId: "acct", token: "t", prefix, fetcher }),
      /^Error: Refused stage prefix: a stage prefix is one of STAGE_PREFIXES/u,
      prefix,
    );
});
