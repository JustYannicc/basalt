import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { failureReport } from "./public-report.ts";
import { composeRootPin, RootPinRefused, rootPinMismatch, setRootPin } from "./root-pin.ts";

const account = "0".repeat(32);
const repository = "pool-root";
const digest = `sha256:${"e".repeat(64)}`;
const image = `registry.cloudflare.com/${account}/${repository}@${digest}`;
const input = "0123456789abcdef";
const rootRow = (recorded: unknown = image) => ({
  attr: { configuration: { image: recorded }, hash: { image: "a".repeat(16) } },
});
const workerRow = { props: { env: { POOL_IMAGE_HASH: input } } };
const pin = (value: object) => JSON.stringify(value);
const why = (refusal: RootPinRefused | undefined) => `${refusal?.rule}: ${refusal?.why}`;

test("the preflight admits only the pin State records the root running", () => {
  assert.equal(rootPinMismatch(pin({ image, input }), rootRow(), workerRow), undefined);
  // Unset, unreadable, or naming nothing State records.
  for (const unset of [undefined, ""])
    assert.match(why(rootPinMismatch(unset, rootRow(), workerRow)), /^root-pin-not-set: /u);
  for (const malformed of ["{", "null", "[]", "42"])
    assert.match(
      why(rootPinMismatch(malformed, rootRow(), workerRow)),
      /^root-pin-malformed: /u,
      malformed,
    );
  assert.match(
    why(rootPinMismatch(pin({ image, input }), undefined, workerRow)),
    /^root-pin-state-unreadable: .*State records the image absent; POOL_IMAGE_HASH present/u,
  );
  assert.match(
    why(rootPinMismatch(pin({ image, input: "fedcba9876543210" }), rootRow(), workerRow)),
    /^root-pin-differs: .*image equal, input differs/u,
  );
  // The pinned row's own hash names the reference, not the build: it is never the input.
  assert.match(
    why(rootPinMismatch(pin({ image, input: "a".repeat(16) }), rootRow(), workerRow)),
    /input differs/u,
  );
});

test("a differing image says which part differs and how State records it, in words", () => {
  const other = (from: string, to: string) => pin({ image: image.replace(from, to), input });
  const cases = [
    [other("e".repeat(64), "f".repeat(64)), rootRow(), "equal", "equal", "differs", "by digest"],
    [other(account, "1".repeat(32)), rootRow(), "differs", "equal", "equal", "by digest"],
    [
      other("registry.cloudflare.com", "docker.io"),
      rootRow(),
      "differs",
      "equal",
      "equal",
      "by digest",
    ],
    [other(repository, "pool-other"), rootRow(), "equal", "differs", "equal", "by digest"],
    // State recorded by tag: no digest can match it.
    [
      pin({ image, input }),
      rootRow(`registry.cloudflare.com/${account}/${repository}:latest`),
      "equal",
      "equal",
      "differs",
      "by tag",
    ],
  ] as const;
  for (const [given, row, place, repo, dig, form] of cases)
    assert.match(
      why(rootPinMismatch(given, row, workerRow)),
      new RegExp(
        `^root-pin-differs: .*image differs \\(registry and account ${place}, repository ${repo}, digest ${dig}; State records it ${form}\\), input equal`,
        "u",
      ),
    );
});

test("the pin is composed from its public parts and the account, and refuses anything else", () => {
  const parts = pin({ repository, digest, input });
  assert.equal(composeRootPin(undefined, account), undefined);
  assert.equal(composeRootPin(" ", account), undefined);
  const composed = composeRootPin(parts, account);
  assert.deepEqual(JSON.parse(composed!), { image, input });
  assert.equal(rootPinMismatch(composed, rootRow(), workerRow), undefined);
  for (const malformed of [
    "{",
    pin({ repository, digest }),
    pin({ repository, digest, input, image }),
    pin({ repository, digest: digest.slice(0, -1), input }),
    pin({ repository, digest, input: "0123" }),
    // The registry or the account in the public variable.
    pin({ repository: `registry.cloudflare.com/${account}/${repository}`, digest, input }),
    pin({ repository: `${account}/${repository}`, digest, input }),
    // A name the stack's declaration would refuse after the preflight passed.
    pin({ repository: "pool.root", digest, input }),
  ])
    assert.throws(
      () => composeRootPin(malformed, account),
      (error: unknown) => error instanceof RootPinRefused && error.rule === "root-pin-malformed",
      malformed,
    );
  for (const [given, rule] of [
    [undefined, "root-pin-no-account"],
    ["", "root-pin-no-account"],
    // Set, but not an account: a stray newline in the secret is not a missing secret.
    [`${account}\n`, "root-pin-bad-account"],
    ["not-an-account", "root-pin-bad-account"],
  ] as const)
    assert.throws(
      () => composeRootPin(parts, given),
      (error: unknown) => error instanceof RootPinRefused && error.rule === rule,
      rule,
    );
});

test("the composed pin goes where the stack reads it, and a second source is refused", () => {
  const env: Record<string, string | undefined> = {
    POOL_ROOT_PIN: pin({ repository, digest, input }),
    CLOUDFLARE_ACCOUNT_ID: account,
  };
  setRootPin(env);
  assert.deepEqual(JSON.parse(env.POOL_ROOT_IMAGE!), { image, input });
  assert.throws(
    () => setRootPin(env),
    (error: unknown) => error instanceof RootPinRefused && error.rule === "root-pin-ambiguous",
  );
  const unset: Record<string, string | undefined> = { CLOUDFLARE_ACCOUNT_ID: account };
  setRootPin(unset);
  assert.deepEqual(unset, { CLOUDFLARE_ACCOUNT_ID: account });
});

test("a pin refusal's public text names the rule and the words, never a value", async () => {
  const refusal = rootPinMismatch(
    pin({ image: image.replace("e".repeat(64), "f".repeat(64)), input }),
    rootRow(`registry.cloudflare.com/${account}/${repository}:latest`),
    workerRow,
  );
  const error = await Effect.runPromise(Effect.fail(refusal!)).catch((cause: unknown) => cause);
  const { publicText } = failureReport(error, { phase: "preflight", resources: [] });
  assert.match(publicText, /rule=root-pin-differs/u);
  assert.match(publicText, /digest differs; State records it by tag\), input equal/u);
  for (const value of [account, "e".repeat(64), "f".repeat(64), repository, input])
    assert.doesNotMatch(publicText, new RegExp(value, "u"), value);
});
