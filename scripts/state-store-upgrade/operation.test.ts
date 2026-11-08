import assert from "node:assert/strict";
import { test } from "node:test";
import { candidate, fixture } from "./fixture.ts";
import { operate, type Receipt } from "./operation.ts";
import { digest, makePlan, UpgradeRefusal } from "./plan.ts";

function setup() {
  const f = fixture();
  const receipts: Receipt[] = [];
  const run = (mode: "dry-run" | "apply" = "apply", extra = {}) =>
    operate({
      mode,
      expected: f.expected,
      candidate,
      api: f.api,
      save: async (receipt) => {
        receipts.push(receipt);
      },
      ...extra,
    });
  return {
    ...f,
    receipts,
    run,
    writes: () => f.requests.filter((request) => request.method !== "GET"),
  };
}
test("dry-run only reads metadata and /version and names the entire unchanged binding plan", async () => {
  const f = setup();
  const result = await f.run("dry-run");
  assert.equal(result.phase, "planned");
  assert.equal(f.writes().length, 0);
  assert.equal(result.plan?.fromVersion, 7);
  assert.equal(result.plan?.toVersion, 8);
  assert.deepEqual(
    result.plan?.bindings.map((binding) => binding.name),
    f.initial.bindings.map((binding) => binding.name).sort(),
  );
  assert.match(
    result.plan?.secretsStore ?? "",
    /No Secrets Store resource is created, updated or deleted/,
  );
  for (const request of f.requests) {
    if (new URL(request.url).hostname.endsWith("workers.dev")) {
      assert.equal(new URL(request.url).pathname, "/version");
      assert.equal(request.authorized, false);
    }
  }
  const text = JSON.stringify(f.receipts);
  assert.ok(!text.includes("never-log-provider-token"));
  assert.ok(!text.includes("never-print-this-binding-value"));
  assert.equal(result.planSha256, digest(f.plan));
});
test("apply uploads inherited bindings once, activates once and verifies all identities", async () => {
  const f = setup();
  const result = await f.run();
  assert.equal(result.phase, "verified");
  assert.equal(result.verifiedVersion, 8);
  assert.deepEqual(
    f.writes().map((request) => new URL(request.url).pathname.split("/").at(-1)),
    ["versions", "deployments"],
  );
  const metadata = f.writes()[0]!.body;
  assert.deepEqual(metadata, {
    main_module: "Api.js",
    bindings: f.initial.bindings.map(({ name }) => ({ name, type: "inherit" })),
    compatibility_date: "2026-08-31",
    compatibility_flags: ["new_module_registry"],
    placement: { mode: "off" },
    observability: { enabled: true },
    annotations: {},
  });
  assert.deepEqual(
    f.receipts.map((receipt) => receipt.phase),
    [
      "inventory",
      "planned",
      "upload-intent",
      "uploaded",
      "activation-intent",
      "activated",
      "verified",
    ],
  );
  assert.deepEqual(f.state.namespace, f.initial.namespace);
  assert.deepEqual(f.state.encryptionKey, f.initial.encryptionKey);
});
for (const field of ["workerId", "deploymentId", "namespaceId", "version", "planSha256"] as const) {
  test(`apply refuses missing ${field} before any write`, async () => {
    const f = setup();
    f.expected[field] = "";
    await assert.rejects(f.run(), UpgradeRefusal);
    assert.equal(f.writes().length, 0);
  });
  test(`apply names a changed ${field} and makes no write`, async () => {
    const f = setup();
    f.expected[field] = "wrong";
    await assert.rejects(f.run(), /expected wrong, observed/);
    assert.equal(f.writes().length, 0);
  });
}
test("an unserved latest upload refuses before inheritance or activation", async () => {
  const f = setup();
  f.state.latestVersionId = "unserved-version";
  await assert.rejects(f.run(), /latest-uploaded-version/);
  assert.equal(f.writes().length, 0);
});
for (const protocol of [6, 8, 9])
  test(`version ${protocol} refuses before any write`, async () => {
    const f = setup();
    f.state.protocol = protocol;
    await assert.rejects(f.run(), /state-store-version/);
    assert.equal(f.writes().length, 0);
  });
test("a changed encryption key between plan and upload refuses by identity", async () => {
  const f = setup();
  f.hooks.read = (count) => {
    if (count === 11) f.state.encryptionKey.modified_on = "2026-11-08T01:00:00Z";
  };
  await assert.rejects(f.run(), /StateStoreEncryptionKey: modified_on/);
  assert.equal(f.writes().length, 0);
});
test("a raced binding change in the inherited version refuses activation", async () => {
  const f = setup();
  f.hooks.uploaded = () => {
    f.state.bindings[0] = { ...f.state.bindings[0]!, text: "changed" };
  };
  await assert.rejects(f.run(), /ALCHEMY_PHASE: text/);
  assert.equal(f.writes().length, 1);
  assert.equal(f.receipts.at(-1)?.uploadedVersionId, "new-version");
});
test("a second uploader between upload and activation refuses by latest version", async () => {
  const f = setup();
  f.hooks.uploaded = () => {
    f.state.latestVersionId = "other-version";
  };
  await assert.rejects(f.run(), /latest-upload-before-activation/);
  assert.equal(f.writes().length, 1);
});
for (const action of ["upload", "activate"] as const)
  test(`an uncertain ${action} is retained and never retried`, async () => {
    const f = setup();
    f.hooks[action === "upload" ? "uploadError" : "activateError"] = true;
    await assert.rejects(f.run(), /transport-or-decode-failure/);
    assert.equal(f.writes().length, action === "upload" ? 1 : 2);
    assert.equal(
      f.receipts.at(-1)?.phase,
      action === "upload" ? "upload-intent" : "activation-intent",
    );
    assert.ok(!JSON.stringify(f.receipts).includes("never-log-provider-token"));
  });
test("post-activation key drift is named and stops without another activation", async () => {
  const f = setup();
  f.hooks.activated = () => {
    f.state.encryptionKey.modified_on = "2026-11-08T01:00:00Z";
  };
  await assert.rejects(f.run(), /StateStoreEncryptionKey: modified_on/);
  assert.equal(f.writes().length, 2);
});
test("version propagation is bounded to sixty seconds with controlled time", async () => {
  const f = setup();
  f.hooks.activated = () => {
    f.state.protocol = 7;
  };
  let time = 0;
  await assert.rejects(
    f.run("apply", {
      now: () => time,
      delay: async (milliseconds: number) => {
        time += milliseconds;
      },
    }),
    /state-store-version-after-activation/,
  );
  assert.equal(time, 60_000);
  assert.equal(f.writes().length, 2);
});
test("failure to retain an upload intent prevents the upload", async () => {
  const f = setup();
  await assert.rejects(
    f.run("apply", {
      save: async (receipt: Receipt) => {
        if (receipt.phase === "upload-intent") throw new Error("disk failure");
      },
    }),
  );
  assert.equal(f.writes().length, 0);
});
test("a candidate code change invalidates the reviewed plan", async () => {
  const f = setup();
  const changed = {
    ...candidate,
    files: [{ ...candidate.files[0]!, bytes: new TextEncoder().encode("changed") }],
  };
  assert.notEqual(digest(makePlan(f.initial, changed)), f.expected.planSha256);
  await assert.rejects(f.run("apply", { candidate: changed }), /plan-sha256/);
  assert.equal(f.writes().length, 0);
});

test("immutable runtime limits survive when the settings endpoint omits them", async () => {
  const f = setup();
  f.initial.runtimeSettings.limits = { cpu_ms: 30_000, subrequests: 50_000 };
  f.state.runtimeSettings = structuredClone(f.initial.runtimeSettings);
  f.expected.planSha256 = digest(makePlan(f.initial, candidate));
  await f.run();
  assert.deepEqual(
    (f.writes()[0]!.body as Record<string, unknown>).limits,
    f.initial.runtimeSettings.limits,
  );
  assert.equal(f.state.settings.limits, undefined);
});

test("different immutable limits in the uploaded version refuse activation", async () => {
  const f = setup();
  f.hooks.uploaded = () => {
    f.state.runtimeSettings.limits = { subrequests: 1_000 };
  };
  await assert.rejects(f.run(), /uploaded runtime: limits.subrequests/);
  assert.equal(f.writes().length, 1);
});

for (const startup of [751, -1, null, "unknown"])
  test(`startup evidence ${startup} refuses activation`, async () => {
    const f = setup();
    f.hooks.startup = startup;
    await assert.rejects(f.run(), /startup-time-ms/);
    assert.equal(f.writes().length, 1);
    assert.equal(f.receipts.at(-1)?.uploadedVersionId, "new-version");
  });

for (const change of ["class", "storage", "binding"] as const)
  test(`an unsupported ${change} plan refuses before upload`, async () => {
    const f = setup();
    if (change === "class") f.state.namespace.class = "OtherStore";
    if (change === "storage") f.state.namespace.use_sqlite = false;
    if (change === "binding") {
      const binding = { name: "NEW_TYPE", type: "service", service: "other-worker" };
      f.initial.bindings.push(binding);
      f.state.bindings.push(binding);
      f.state.settings.bindings = f.state.bindings;
    }
    await assert.rejects(f.run(), UpgradeRefusal);
    assert.equal(f.writes().length, 0);
  });

test("simultaneous drift names every changed resource and field without binding contents", async () => {
  const f = setup();
  f.hooks.read = (count) => {
    if (count === 11) {
      f.state.settings.observability = { enabled: false };
      f.state.settings.logpush = true;
      f.state.settings.annotations = {
        "workers/message": "private-message",
        "workers/tag": "private-tag",
      };
      f.state.bindings[1]!.text = "changed-private-binding";
      f.state.namespace.class = "OtherStore";
      f.state.encryptionKey.modified_on = "2026-11-08T01:00:00Z";
    }
  };
  await assert.rejects(f.run(), (error) => {
    assert.ok(error instanceof UpgradeRefusal);
    assert.match(error.message, /observability.enabled expected true, observed false/);
    assert.match(error.message, /logpush expected false, observed true/);
    assert.match(
      error.message,
      /annotations.workers\/message expected absent, observed sha256:[a-f0-9]+/,
    );
    assert.match(
      error.message,
      /annotations.workers\/tag expected absent, observed sha256:[a-f0-9]+/,
    );
    assert.ok(!error.message.includes("private-message"));
    assert.ok(!error.message.includes("private-tag"));
    assert.match(
      error.message,
      /PRIVATE_VALUE: text expected sha256:[a-f0-9]+, observed sha256:[a-f0-9]+/,
    );
    assert.match(error.message, /Store: class/);
    assert.match(error.message, /StateStoreEncryptionKey: modified_on/);
    assert.ok(!error.message.includes("changed-private-binding"));
    assert.deepEqual(f.receipts.at(-1)?.error?.changes, error.changes);
    return true;
  });
  assert.equal(f.writes().length, 0);
});

test("uploaded binding and runtime drift are reported together without activation", async () => {
  const f = setup();
  f.hooks.uploaded = () => {
    f.state.bindings[1]!.text = "changed-private-binding";
    f.state.runtimeSettings.limits = { subrequests: 1000 };
  };
  await assert.rejects(f.run(), (error) => {
    assert.ok(error instanceof UpgradeRefusal);
    assert.match(error.message, /PRIVATE_VALUE: text/);
    assert.match(error.message, /uploaded runtime: limits.subrequests/);
    assert.ok(!error.message.includes("changed-private-binding"));
    return true;
  });
  assert.equal(f.writes().length, 1);
});
