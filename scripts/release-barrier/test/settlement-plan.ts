import type { TestContext } from "node:test";
import { Effect } from "effect";
import { releaseSettlementFixture } from "./release-settlement-fixture.ts";
import type { BootstrapShape } from "./settlement-bootstrap.ts";
import { planReleaseSettlement } from "../release-settlement-operation.ts";
import type { ReleaseSettlementPlanRequest } from "../release-settlement-contract.ts";

export type SettlementFixture = Awaited<ReturnType<typeof releaseSettlementFixture>>;
type Disposition = (typeof ReleaseSettlementPlanRequest.Type)["disposition"];

export const controllerActiveFixture = (context: TestContext) =>
  releaseSettlementFixture(context, { controllerActive: true });

/** The source after its adopt committed the legacy root, as production's observe found it. */
export const controllerAdoptedFixture = (context: TestContext) =>
  releaseSettlementFixture(context, { controllerActive: true, adopted: true });

/** That adopted root after selected-runtime recovery restarted it twice, as production later found it. */
export const controllerRecoveredFixture = (context: TestContext) =>
  releaseSettlementFixture(context, { controllerActive: true, adopted: true, recovered: true });

/**
 * The recovered root (or, with `recovered: false`, adopt's own epoch-1 selection) after the source
 * then bootstrapped `colors`, as a release stopped past bootstrap or bind and before any startup
 * leaves it.
 */
export const fleetAttachedFixture = (
  context: TestContext,
  bootstrapped: BootstrapShape = { colors: ["blue"] },
  options: { recovered?: boolean } = {},
) =>
  releaseSettlementFixture(context, {
    controllerActive: true,
    adopted: true,
    recovered: options.recovered ?? true,
    bootstrapped,
  });

/** The never-adopted legacy slot the fixture's source controller would retain. */
export const fixtureAdoptionTarget = {
  format: "pool-runtime-slot-v1",
  controllerId: "f".repeat(64),
  instanceId: "f".repeat(64),
  slotId: "legacy",
  applicationId: "pool-app",
  applicationVersion: "1",
  imageDigest: `sha256:${"1".repeat(64)}`,
  imageInput: "a".repeat(16),
} as const;

export const planSettlement = (
  f: SettlementFixture,
  disposition: Disposition | "omitted" = "controller-active-unadopted",
) =>
  Effect.runPromise(
    f.provide(
      planReleaseSettlement(
        f.compiled,
        {
          kind: "release-settlement",
          sourceCandidate: f.sourceCandidate,
          operationId: "settle-controller-active",
          coordinatorGo: "read-only-plan",
          expiresAt: Date.now() + 60_000,
          ...(disposition === "omitted" ? {} : { disposition }),
          ...((disposition === "controller-active-unadopted" ||
            disposition === "controller-active-adopted" ||
            disposition === "fleet-attached-unstarted") &&
          f.sourceController
            ? { sourceController: f.sourceController }
            : {}),
        },
        f.provisioningWriter,
        f.key,
        f.io,
      ),
    ),
  );
