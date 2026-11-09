import assert from "node:assert/strict";
import { test } from "node:test";
import * as Plan from "alchemy/Plan";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import { Stack, evalStack } from "alchemy/Stack";
import { State } from "alchemy/State/State";
import { InMemoryService } from "alchemy/State/InMemoryState";
import type { Bucket } from "alchemy/Cloudflare/R2";
import { Effect, Layer } from "effect";
import { decodeDeclaredChanges } from "./declared-change-schema.ts";
import { assertSupportedPlan } from "./plan-admission.ts";
import { withReleaseRuntime } from "./runtime.ts";
import { BarrierRefusal } from "./manifest.ts";

const props = {
  jurisdiction: "eu",
  storageClass: "Standard",
  publicAccess: false,
  forceDestroy: false,
  domains: [],
  cors: [],
  lifecycleRules: [],
} satisfies Bucket["Props"];

const declaration = () =>
  decodeDeclaredChanges({
    schemaVersion: 1,
    stack: "basalt",
    retentionOwner: "Fixture storage owner",
    changes: [
      {
        action: "create-bucket",
        type: "Cloudflare.R2.Bucket",
        fqn: "DriveRecords",
        props,
        removalPolicy: "retain",
        retention: { data: true, nativeStateRow: true, recoveryDescriptor: true },
      },
    ],
  });

async function bucketPlan(overrides: Partial<Bucket["Props"]> = {}) {
  const effects: string[] = [];
  interface FixtureBucket extends Resource<
    "Cloudflare.R2.Bucket",
    Bucket["Props"],
    Bucket["Attributes"]
  > {}
  const FixtureBucket = Resource<FixtureBucket>("Cloudflare.R2.Bucket");
  const stack = Stack(
    "basalt",
    {
      providers: Provider.succeed(FixtureBucket, {
        diff: () => Effect.succeed({ action: "update" }),
        reconcile: () => Effect.die("Admission must not create the bucket"),
        delete: () => Effect.sync(() => effects.push("delete")),
      }),
      state: Layer.effect(State, Effect.map(InMemoryService(), Effect.succeed)),
    },
    FixtureBucket("DriveRecords", { ...props, ...overrides }).pipe(RemovalPolicy.retain()),
  );
  const plan = await Effect.runPromise(
    evalStack(stack, Plan.make, { stage: "production" }).pipe(withReleaseRuntime),
  );
  return { plan, effects };
}

test("a declared exact retained EU bucket passes pure admission without provider mutation", async () => {
  const { plan, effects } = await bucketPlan();
  assert.equal(plan.resources.DriveRecords?.action, "create");
  assert.doesNotThrow(() => assertSupportedPlan(plan, new Map(), declaration()));
  assert.deepEqual(effects, []);
});

test("two declarations cannot claim the same planned bucket", async () => {
  const { plan } = await bucketPlan();
  const intent = declaration();
  assert.throws(
    () =>
      assertSupportedPlan(plan, new Map(), {
        ...intent,
        changes: [...intent.changes, ...intent.changes],
      }),
    BarrierRefusal,
  );
});

test("a declaration whose resource is missing from the native plan refuses", async () => {
  const { plan } = await bucketPlan();
  assert.throws(
    () => assertSupportedPlan({ ...plan, resources: {} }, new Map(), declaration()),
    BarrierRefusal,
  );
});

test("a logical bucket declaration cannot authorize an undeclared physical name", async () => {
  const { plan, effects } = await bucketPlan({ name: "foreign-bucket" });
  assert.throws(() => assertSupportedPlan(plan, new Map(), declaration()), BarrierRefusal);
  assert.deepEqual(effects, []);
});

test("a class declaration refuses creating a Worker instead of expanding a settled one", async () => {
  const { plan } = await bucketPlan();
  const node = plan.resources.DriveRecords!;
  const intent = declaration();
  const declarations = decodeDeclaredChanges({
    ...intent,
    changes: [
      {
        action: "add-sqlite-class",
        type: "Cloudflare.Worker",
        fqn: "DriveRecords",
        newSqliteClasses: ["DriveObject"],
        addedBindings: [
          {
            type: "durable_object_namespace",
            name: "DriveObject",
            className: "DriveObject",
            location: "local",
          },
        ],
        retention: { data: true, nativeStateRow: true, recoveryDescriptor: true },
      },
    ],
  });
  assert.throws(
    () =>
      assertSupportedPlan(
        {
          ...plan,
          resources: {
            DriveRecords: { ...node, resource: { ...node.resource, Type: "Cloudflare.Worker" } },
          },
        },
        new Map(),
        declarations,
      ),
    (error) =>
      error instanceof BarrierRefusal &&
      error.refusals?.some((item) => item.reason === "declaration-does-not-match-plan") === true,
  );
});

test("a noop cannot silently ignore an unmatched bucket declaration", async () => {
  const { plan } = await bucketPlan({ publicAccess: true });
  const node = plan.resources.DriveRecords!;
  const noop: Plan.Apply = {
    ...node,
    action: "noop",
    state: {
      status: "created",
      fqn: "DriveRecords",
      logicalId: "DriveRecords",
      instanceId: "a".repeat(32),
      resourceType: "Cloudflare.R2.Bucket",
      providerVersion: 0,
      namespace: undefined,
      downstream: [],
      bindings: [],
      removalPolicy: "retain",
      props: node.resource.Props,
      attr: { accountId: "fixture", bucketName: "fixture" },
    },
  };
  assert.throws(
    () =>
      assertSupportedPlan({ ...plan, resources: { DriveRecords: noop } }, new Map(), declaration()),
    (error) =>
      error instanceof BarrierRefusal &&
      error.refusals?.some((item) => item.reason === "declaration-does-not-match-plan") === true,
  );
});

test("class declaration refusal identifies resource type, action and native state separately", async () => {
  const { plan } = await bucketPlan();
  const declarations = decodeDeclaredChanges({
    schemaVersion: 1,
    stack: "basalt",
    retentionOwner: "Fixture",
    changes: [
      {
        action: "add-sqlite-class",
        type: "Cloudflare.Worker",
        fqn: "DriveRecords",
        newSqliteClasses: ["DriveObject"],
        addedBindings: [
          {
            type: "durable_object_namespace",
            name: "DRIVE",
            className: "DriveObject",
            location: "local",
          },
        ],
        retention: { data: true, nativeStateRow: true, recoveryDescriptor: true },
      },
    ],
  });
  assert.throws(
    () => assertSupportedPlan(plan, new Map(), declarations),
    (error) => {
      assert.ok(error instanceof BarrierRefusal);
      const refusal = error.refusals?.find(
        (item) => item.reason === "declaration-does-not-match-plan",
      );
      assert.ok(refusal && "changed" in refusal);
      assert.ok(
        refusal.changed.some(
          (item) =>
            item.path === "$declaration.type" &&
            "new" in item &&
            item.old === "Cloudflare.Worker" &&
            item.new === "Cloudflare.R2.Bucket",
        ),
      );
      assert.ok(
        refusal.changed.some(
          (item) => item.path === "$declaration.action" && "new" in item && item.new === "create",
        ),
      );
      assert.ok(
        refusal.changed.some(
          (item) =>
            item.path === "$declaration.native.status" && "new" in item && item.new === null,
        ),
      );
      assert.ok(!refusal.changed.some((item) => item.path === "$declaration.lifecycle"));
      return true;
    },
  );
});
