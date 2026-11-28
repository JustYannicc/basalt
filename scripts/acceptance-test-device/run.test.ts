import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { brand } from "../../brand.ts";
import { createRecipient, decryptArtifact, sealArtifact } from "../production-ops/artifact.ts";
import type { AcceptanceTestDevice } from "../release/acceptance-test-device.ts";
import { keptResult, receiptIdSha256 } from "../acceptance-pool/artifact.ts";
import { runFromEnvironment, type TestDeviceDeps } from "./run.ts";

const app = "app_acceptance0load1";
const accounts = ["acc_test0a", "acc_test0b"];
const planSha256 = "a".repeat(64);
const signingKey = "ab".repeat(32);
const device: AcceptanceTestDevice = {
  computer: "computer-test-4f1e",
  grant: "native:acceptance-test-9c2d",
  user: "acceptance",
  pool: app,
  owner: "acceptance",
  organization: "acceptance",
};
const verified = (
  extra: { receipt?: object; verification?: object; completed?: boolean } = {},
) => ({
  action: "verify",
  kind: "setup",
  planSha256,
  completed: extra.completed ?? true,
  receipt: {
    migration: "acceptance-pool-setup-v1",
    organization: "acceptance",
    status: "applied",
    app,
    accounts,
    ...extra.receipt,
  },
  verification: {
    ok: true,
    checks: { identity: true, onePool: true, twoAccounts: true, membership: true },
    ...extra.verification,
  },
});

/** A run's working directories, a recipient key, and fakes that record what they were asked. */
/** `operation: null` leaves the setup run's record out. */
async function stage(
  answer: unknown = verified(),
  // What the setup apply's own run keeps, through the writer that run uses.
  operation: unknown = keptResult({
    action: "apply",
    kind: "setup",
    receipt: {
      migration: "acceptance-pool-setup-v1",
      organization: "acceptance",
      status: "applied",
      app,
      accounts: ["acct_test0one", "acct_test0two"],
    },
  }),
  setupRun: unknown = {
    path: ".github/workflows/acceptance-pool.yml",
    head_branch: "main",
    event: "workflow_dispatch",
    conclusion: "success",
  },
) {
  const root = await mkdtemp(join(tmpdir(), "test-device-"));
  const setup = join(root, "setup");
  const output = join(root, "out");
  const summary = join(root, "summary.md");
  await mkdir(setup, { recursive: true });
  if (operation !== null) await writeFile(join(setup, "operation.json"), JSON.stringify(operation));
  const keyFile = join(root, "recipient.pem");
  const recipient = createRecipient(keyFile);
  const calls = { verify: 0, register: [] as unknown[], revoke: [] as unknown[] };
  const deps: TestDeviceDeps = {
    verify: async (input) => {
      calls.verify++;
      assert.equal(input.action, "verify");
      assert.equal(input.planSha256, planSha256);
      if (answer instanceof Error) throw answer;
      return answer as Record<string, unknown>;
    },
    setupRun: async (id) => {
      assert.equal(id, "4242");
      if (setupRun instanceof Error) throw setupRun;
      return setupRun;
    },
    register: async (target) => {
      calls.register.push(target);
      return device;
    },
    revoke: async (target) => {
      calls.revoke.push(target);
    },
    seal: sealArtifact,
  };
  const env = (extra: Record<string, string> = {}) => ({
    TEST_DEVICE_ACTION: "register",
    TEST_DEVICE_GO: "coordinator-2026-11-28-test-device",
    POOL_APP_SIGNING_KEY: signingKey,
    TEST_DEVICE_SETUP_PLAN_SHA256: planSha256,
    TEST_DEVICE_SETUP_RUN: "4242",
    TEST_DEVICE_SETUP_DIRECTORY: setup,
    TEST_DEVICE_RECIPIENT: recipient,
    TEST_DEVICE_OUTPUT_DIRECTORY: output,
    GITHUB_STEP_SUMMARY: summary,
    ...extra,
  });
  return { root, output, summary, keyFile, recipient, calls, deps, env };
}

/** Every file and line a run leaves: its output directory, the step summary and stdout. */
async function everything(run: Awaited<ReturnType<typeof stage>>, printed: readonly string[]) {
  const texts = [...printed];
  for (const file of await readdir(run.output).catch(() => []))
    texts.push(await readFile(join(run.output, file), "utf8"));
  texts.push(await readFile(run.summary, "utf8").catch(() => ""));
  return texts.join("\n");
}
const leaks = [app, ...accounts, device.computer, device.grant, brand.host, brand.zone];
const assertNoId = (text: string) => {
  for (const id of leaks) assert.ok(!text.includes(id), `an id in clear: ${id}`);
  assert.doesNotMatch(text, /\bapp_[A-Za-z0-9_-]+/u, "an app id in clear");
  assert.doesNotMatch(text, /[^\s@]+@[^\s@]+\.[^\s@]+/u, "an email in clear");
};

test("register proves the setup by the tools service's own answer, and the ids leave only sealed", async () => {
  const run = await stage();
  try {
    const printed: string[] = [];
    assert.equal(
      await runFromEnvironment(run.env(), run.deps, (line) => printed.push(line)),
      false,
    );
    assert.equal(run.calls.verify, 1);
    assert.equal(run.calls.register.length, 1);
    assert.deepEqual(
      (({ pool, owner, organization, user, stage }) => ({
        pool,
        owner,
        organization,
        user,
        stage,
      }))(run.calls.register[0] as Record<string, unknown> as never),
      {
        pool: app,
        owner: "acceptance",
        organization: "acceptance",
        user: "acceptance",
        stage: "production",
      },
    );
    // Only the recipient's private key reads the ids back.
    const sealed = JSON.parse(await readFile(join(run.output, "device.sealed.json"), "utf8"));
    const opened = decryptArtifact(
      sealed,
      await readFile(run.keyFile, "utf8"),
      "acceptance-test-device",
    );
    assert.deepEqual(JSON.parse(opened), device);
    assert.deepEqual(printed, [
      `test_device action=register outcome=registered pool_sha256=${receiptIdSha256("app", app)} sealed_sha256=${sealed.sha256}`,
    ]);
    assertNoId(await everything(run, printed));
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("revoke reads the device from its secret, proves the setup first, and writes no id", async () => {
  const run = await stage();
  try {
    const printed: string[] = [];
    const refused = await runFromEnvironment(
      run.env({
        TEST_DEVICE_ACTION: "revoke",
        TEST_DEVICE_RECIPIENT: "",
        POOL_ACCEPTANCE_TEST_DEVICE: JSON.stringify(device),
      }),
      run.deps,
      (line) => printed.push(line),
    );
    assert.equal(refused, false);
    assert.equal(run.calls.register.length, 0);
    assert.deepEqual((run.calls.revoke[0] as { device: unknown }).device, device);
    assert.deepEqual(printed, [
      `test_device action=revoke outcome=revoked pool_sha256=${receiptIdSha256("app", app)}`,
    ]);
    assertNoId(await everything(run, printed));
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("each refusal sends nothing, signs nothing for the device, and names only its closed word", async (t) => {
  const cases: [string, Parameters<typeof stage>, Record<string, string>, string][] = [
    ["no GO", [], { TEST_DEVICE_GO: "go" }, "go_invalid"],
    ["an unknown action", [], { TEST_DEVICE_ACTION: "both" }, "config"],
    ["a malformed checksum", [], { TEST_DEVICE_SETUP_PLAN_SHA256: "abc" }, "config"],
    ["no recipient", [], { TEST_DEVICE_RECIPIENT: "" }, "config"],
    ["a verify that fails", [new Error(`refused for ${app}`)], {}, "verify_failed"],
    ["a verify answer of another shape", [{ action: "verify" }], {}, "verify_failed"],
    ["an incomplete setup", [verified({ completed: false })], {}, "setup_not_applied"],
    [
      "a teardown receipt",
      [verified({ receipt: { migration: "acceptance-pool-teardown-v1" } })],
      {},
      "setup_not_applied",
    ],
    [
      "another organization",
      [verified({ receipt: { organization: "organization-a" } })],
      {},
      "setup_not_applied",
    ],
    [
      "a receipt not applied",
      [verified({ receipt: { status: "incomplete" } })],
      {},
      "setup_not_applied",
    ],
    ["a receipt with no app", [verified({ receipt: { app: null } })], {}, "setup_not_applied"],
    ["a verification not ok", [verified({ verification: { ok: false } })], {}, "setup_unverified"],
    [
      "one check false",
      [verified({ verification: { checks: { identity: true, membership: false } } })],
      {},
      "setup_unverified",
    ],
    ["no checks", [verified({ verification: { checks: {} } })], {}, "setup_unverified"],
    [
      "another check false beside the required ones",
      [
        verified({
          verification: {
            checks: { onePool: true, twoAccounts: true, membership: true, recordedApps: false },
          },
        }),
      ],
      {},
      "setup_unverified",
    ],
    ["no setup run record", [verified(), null], {}, "pool_digest_missing"],
    [
      "a setup record with no digest",
      [
        verified(),
        {
          action: "apply",
          kind: "setup",
          receipt: { migration: "acceptance-pool-setup-v1", status: "applied" },
        },
      ],
      {},
      "pool_digest_missing",
    ],
    [
      "another apply's app",
      [
        verified(),
        {
          action: "apply",
          kind: "setup",
          receipt: {
            migration: "acceptance-pool-setup-v1",
            status: "applied",
            appSha256: receiptIdSha256("app", "app_someone0else"),
          },
        },
      ],
      {},
      "pool_digest_differs",
    ],
    [
      "a verify answer for another plan",
      [{ ...verified(), planSha256: "b".repeat(64) }],
      {},
      "verify_failed",
    ],
    [
      "a required check absent",
      [
        verified({
          verification: { checks: { identity: true, onePool: true, twoAccounts: true } },
        }),
      ],
      {},
      "setup_unverified",
    ],
    ["an upper-case signing key", [], { POOL_APP_SIGNING_KEY: "AB".repeat(32) }, "config"],
    ["no setup run id", [], { TEST_DEVICE_SETUP_RUN: "" }, "config"],
    [
      "a teardown's record, which carries the same digest",
      [
        verified(),
        {
          action: "apply",
          kind: "setup",
          receipt: {
            migration: "acceptance-pool-teardown-v1",
            status: "applied",
            appSha256: receiptIdSha256("app", app),
          },
        },
      ],
      {},
      "setup_run_invalid",
    ],
    [
      "a setup record not applied",
      [
        verified(),
        {
          action: "apply",
          kind: "setup",
          receipt: {
            migration: "acceptance-pool-setup-v1",
            status: "incomplete",
            appSha256: receiptIdSha256("app", app),
          },
        },
      ],
      {},
      "setup_run_invalid",
    ],
    [
      "a setup record of another plan",
      [
        verified(),
        {
          action: "apply",
          kind: "setup",
          planSha256: "c".repeat(64),
          receipt: {
            migration: "acceptance-pool-setup-v1",
            status: "applied",
            appSha256: receiptIdSha256("app", app),
          },
        },
      ],
      {},
      "setup_run_invalid",
    ],
    [
      "a setup record of a dry run",
      [
        verified(),
        {
          action: "dry-run",
          kind: "setup",
          receipt: {
            migration: "acceptance-pool-setup-v1",
            status: "applied",
            appSha256: receiptIdSha256("app", app),
          },
        },
      ],
      {},
      "setup_run_invalid",
    ],
    ...(
      [
        ["another workflow", { path: ".github/workflows/production-ops.yml" }],
        ["another branch", { head_branch: "feature" }],
        ["another event", { event: "push" }],
        ["a run that failed", { conclusion: "failure" }],
      ] as const
    ).map(
      ([name, field]) =>
        [
          `a setup run of ${name}`,
          [
            verified(),
            {
              action: "apply",
              kind: "setup",
              receipt: {
                migration: "acceptance-pool-setup-v1",
                status: "applied",
                appSha256: receiptIdSha256("app", app),
              },
            },
            {
              path: ".github/workflows/acceptance-pool.yml",
              head_branch: "main",
              event: "workflow_dispatch",
              conclusion: "success",
              ...field,
            },
          ],
          {},
          "setup_run_invalid",
        ] as [string, Parameters<typeof stage>, Record<string, string>, string],
    ),
    [
      "a setup run the repository can't name",
      [verified(), undefined, new Error("not found")],
      {},
      "setup_run_invalid",
    ],
  ];
  for (const [name, stageArgs, extra, reason] of cases)
    await t.test(name, async () => {
      const run = await stage(...stageArgs);
      try {
        const printed: string[] = [];
        assert.equal(
          await runFromEnvironment(run.env(extra), run.deps, (line) => printed.push(line)),
          true,
        );
        assert.deepEqual(printed, [`test_device action=register outcome=refused reason=${reason}`]);
        assert.equal(
          run.calls.register.length + run.calls.revoke.length,
          0,
          "nothing registered or revoked",
        );
        assertNoId(await everything(run, printed));
      } finally {
        await rm(run.root, { recursive: true, force: true });
      }
    });
  await t.test("revoke with no test device in its secret", async () => {
    const run = await stage();
    try {
      const printed: string[] = [];
      assert.equal(
        await runFromEnvironment(run.env({ TEST_DEVICE_ACTION: "revoke" }), run.deps, (line) =>
          printed.push(line),
        ),
        true,
      );
      assert.deepEqual(printed, [
        "test_device action=revoke outcome=refused reason=device_missing",
      ]);
      assert.equal(run.calls.verify, 0, "nothing is asked before the device is read");
    } finally {
      await rm(run.root, { recursive: true, force: true });
    }
  });
  await t.test("a registration the pool refuses, and a revoke it refuses", async () => {
    const run = await stage();
    try {
      const refusing: TestDeviceDeps = {
        ...run.deps,
        register: async () => {
          throw new Error(`refused ${app}`);
        },
        revoke: async () => {
          throw new Error(`refused ${device.computer}`);
        },
      };
      const printed: string[] = [];
      await runFromEnvironment(run.env(), refusing, (line) => printed.push(line));
      await runFromEnvironment(
        run.env({
          TEST_DEVICE_ACTION: "revoke",
          POOL_ACCEPTANCE_TEST_DEVICE: JSON.stringify(device),
        }),
        refusing,
        (line) => printed.push(line),
      );
      assert.deepEqual(printed, [
        "test_device action=register outcome=refused reason=registration_refused",
        "test_device action=revoke outcome=refused reason=revoke_refused",
      ]);
      assertNoId(await everything(run, printed));
    } finally {
      await rm(run.root, { recursive: true, force: true });
    }
  });
});

test("an error of the run's own machinery is reported by its closed word, never by its text", async () => {
  const run = await stage();
  try {
    // An output path that cannot be a directory, and whose own name an error would repeat.
    const blocked = join(run.root, `${app}-not-a-directory`);
    await writeFile(blocked, "");
    const printed: string[] = [];
    assert.equal(
      await runFromEnvironment(
        run.env({ TEST_DEVICE_OUTPUT_DIRECTORY: blocked }),
        run.deps,
        (line) => printed.push(line),
      ),
      true,
    );
    assert.deepEqual(printed, ["test_device action=register outcome=refused reason=config"]);
    assertNoId([...printed, await readFile(run.summary, "utf8").catch(() => "")].join("\n"));
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("a recipient the ids can't be sealed for is refused before anything is registered", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const spki = (options: { modulusLength: number; publicExponent?: number }) =>
    generateKeyPairSync("rsa", options)
      .publicKey.export({ type: "spki", format: "der" })
      .toString("base64");
  for (const recipient of [
    spki({ modulusLength: 2048 }),
    spki({ modulusLength: 3072, publicExponent: 3 }),
    "not-a-key",
  ]) {
    const run = await stage();
    try {
      const printed: string[] = [];
      assert.equal(
        await runFromEnvironment(run.env({ TEST_DEVICE_RECIPIENT: recipient }), run.deps, (line) =>
          printed.push(line),
        ),
        true,
      );
      assert.equal(run.calls.verify, 0, "nothing is asked");
      assert.equal(run.calls.register.length, 0, "nothing is registered");
      assert.deepEqual(printed, ["test_device action=register outcome=refused reason=config"]);
    } finally {
      await rm(run.root, { recursive: true, force: true });
    }
  }
});

test("a registered device whose ids cannot be sealed is revoked again, and says so if it can't be", async () => {
  for (const [revokes, reason] of [
    [true, "config"],
    [false, "unsealed_left_registered"],
  ] as const) {
    const run = await stage();
    try {
      const failing: TestDeviceDeps = {
        ...run.deps,
        seal: () => {
          throw new Error(`cannot seal ${device.computer}`);
        },
        revoke: async (target) => {
          run.calls.revoke.push(target);
          if (!revokes) throw new Error(`refused ${device.grant}`);
        },
      };
      const printed: string[] = [];
      assert.equal(
        await runFromEnvironment(run.env(), failing, (line) => printed.push(line)),
        true,
      );
      assert.equal(run.calls.register.length, 1);
      assert.deepEqual((run.calls.revoke[0] as { device: unknown }).device, device);
      assert.deepEqual(printed, [`test_device action=register outcome=refused reason=${reason}`]);
      assertNoId(await everything(run, printed));
    } finally {
      await rm(run.root, { recursive: true, force: true });
    }
  }
});

test("revoke needs only the applied receipt, so a setup whose checks degraded can still revoke", async () => {
  const run = await stage(verified({ verification: { ok: false, checks: { membership: false } } }));
  try {
    const printed: string[] = [];
    assert.equal(
      await runFromEnvironment(
        run.env({
          TEST_DEVICE_ACTION: "revoke",
          POOL_ACCEPTANCE_TEST_DEVICE: JSON.stringify(device),
        }),
        run.deps,
        (line) => printed.push(line),
      ),
      false,
    );
    assert.equal(run.calls.revoke.length, 1);
    assert.deepEqual(printed, [
      `test_device action=revoke outcome=revoked pool_sha256=${receiptIdSha256("app", app)}`,
    ]);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("a sealed artifact opens only with its recipient's key and for its own target", async () => {
  const root = await mkdtemp(join(tmpdir(), "seal-"));
  try {
    const recipient = createRecipient(join(root, "a.pem"));
    createRecipient(join(root, "b.pem"));
    const sealed = sealArtifact("the plaintext", recipient, "target-a");
    assert.ok(!JSON.stringify(sealed).includes("the plaintext"));
    const own = await readFile(join(root, "a.pem"), "utf8");
    assert.equal(decryptArtifact(sealed, own, "target-a"), "the plaintext");
    // Another key, or the same sealed copy opened for another target, reads nothing.
    const other = await readFile(join(root, "b.pem"), "utf8");
    assert.throws(() => decryptArtifact(sealed, other, "target-a"));
    assert.throws(() => decryptArtifact(sealed, own, "target-b"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the workflow runs only from main, in the production-ops group, and gives revoke alone the device", async () => {
  const { parse } = createRequire(new URL("../architecture/package.json", import.meta.url))("yaml");
  const workflow = parse(
    await readFile(
      new URL("../../.github/workflows/acceptance-test-device.yml", import.meta.url),
      "utf8",
    ),
  ) as {
    on: Record<string, unknown> & {
      workflow_dispatch?: { inputs: Record<string, { required?: boolean }> };
    };
    concurrency: { group: string; "cancel-in-progress": boolean };
    jobs: Record<
      string,
      {
        if: string;
        environment?: { name: string };
        steps: { env?: Record<string, string>; with?: { path?: string } }[];
      }
    >;
  };
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.equal(workflow.on.workflow_dispatch?.inputs.go?.required, true);
  assert.deepEqual(workflow.concurrency, { group: "production-ops", "cancel-in-progress": false });
  const { register, revoke } = workflow.jobs;
  assert.equal(register?.if, "github.ref == 'refs/heads/main' && inputs.action == 'register'");
  assert.equal(revoke?.if, "github.ref == 'refs/heads/main' && inputs.action == 'revoke'");
  assert.equal(register?.environment, undefined);
  assert.equal(revoke?.environment?.name, "emulated-upstream");
  const envOf = (job: typeof register) =>
    Object.assign({}, ...job!.steps.map((step) => step.env ?? {}));
  assert.equal(
    envOf(register).POOL_ACCEPTANCE_TEST_DEVICE,
    undefined,
    "register never reads the device",
  );
  assert.equal(
    envOf(revoke).POOL_ACCEPTANCE_TEST_DEVICE,
    "${{ secrets.POOL_ACCEPTANCE_TEST_DEVICE }}",
  );
  for (const job of [register, revoke]) {
    assert.equal(
      envOf(job).POOL_ACCEPTANCE_DEVICE,
      undefined,
      "the release's device is never read",
    );
    // Only the run's own output directory is published: the sealed ids and the report.
    const published = job!.steps.flatMap((step) => (step.with?.path ? [step.with.path] : []));
    // A re-run gets its own artifact, so a second attempt never loses its sealed ids to a conflict.
    const names = job!.steps.flatMap((step) =>
      (step.with as { name?: string } | undefined)?.name?.startsWith("acceptance-test-device-")
        ? [(step.with as { name: string }).name]
        : [],
    );
    assert.deepEqual(names, [
      "acceptance-test-device-${{ github.run_id }}-${{ github.run_attempt }}",
    ]);
    assert.ok(published.includes("${{ runner.temp }}/test-device"), JSON.stringify(published));
  }
});
