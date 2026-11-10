import { Schema } from "effect";
import {
  SlotIdentity,
  PromotionReceipt,
  RetirementReceipt,
} from "../../src/pool/runtime-slots/contract.ts";
import { canonical, digest } from "./manifest.ts";
import {
  assertFirstHandoffConfiguration,
  assertFirstHandoffEnable,
  decodeHandoffWorker,
  firstHandoffDigest,
  freezeFirstHandoff,
  type FirstHandoffManifest,
} from "./first-handoff-contract.ts";
import {
  assertHandoffVersion,
  sameHandoffWorkerValue,
  firstHandoffVersionRequest,
  type FirstHandoffWorker,
} from "./first-handoff-worker.ts";
import {
  decodeHandoffGrant,
  readFirstHandoffAdoption,
  type FirstHandoffRuntime,
} from "./first-handoff-runtime.ts";
import type { ProvisioningEnable } from "./provisioning-contract.ts";
import { provisioningJournal, type ProvisioningStore } from "./provisioning-journal.ts";
import {
  decodeProvisioningInput,
  provisioningRefusal,
  sameProvisioningValue,
} from "./provisioning-refusal.ts";

const stagedVersion = decodeProvisioningInput(
  Schema.Struct({ versionId: Schema.NonEmptyString, startupTimeMs: Schema.Number }),
  "firstHandoff.staged",
);
const deployment = decodeProvisioningInput(
  Schema.Struct({ deploymentId: Schema.NonEmptyString }),
  "firstHandoff.deployment",
);
const identity = decodeProvisioningInput(SlotIdentity, "firstHandoff.identity");
const promotion = decodeProvisioningInput(PromotionReceipt, "firstHandoff.promotion");
const retirement = decodeProvisioningInput(RetirementReceipt, "firstHandoff.retirement");
const hash = (value: unknown) => digest(canonical(value));

/** Exact source enable is supplied separately; this service installs no CLI, automation or live caller. */
export async function activateFirstHandoff(input: {
  manifest: FirstHandoffManifest;
  enable: ProvisioningEnable | undefined;
  store: ProvisioningStore;
  worker: FirstHandoffWorker;
  runtime: FirstHandoffRuntime;
  now?: () => number;
}) {
  const manifest = freezeFirstHandoff(input.manifest);
  const now = input.now ?? Date.now;
  const fingerprint = firstHandoffDigest(manifest);
  const enabled = () => {
    assertFirstHandoffEnable(manifest, input.enable, now());
    sameProvisioningValue(
      "firstHandoff.frozenManifest",
      fingerprint,
      firstHandoffDigest(input.manifest),
    );
  };
  enabled();
  await assertFirstHandoffConfiguration(manifest);
  const journal = provisioningJournal(input.store, manifest.candidate.candidate, fingerprint);
  const once = <A>(
    name: string,
    request: unknown,
    perform: () => Promise<A>,
    parse: (value: unknown) => A,
  ) =>
    journal.once(
      name,
      hash(request),
      async () => {
        enabled();
        return perform();
      },
      parse,
    );
  const { worker, runtime } = input;
  const baseline = await once(
    "handoff-baseline",
    manifest.baseline,
    () => worker.observe(),
    decodeHandoffWorker,
  );
  sameHandoffWorkerValue("firstHandoff.baseline", manifest.baseline, baseline);
  const preserve = firstHandoffVersionRequest(manifest, "preserve");
  const installed = await once(
    "handoff-code-stage",
    preserve,
    async () => {
      sameHandoffWorkerValue("firstHandoff.beforeCodeInstall", baseline, await worker.observe());
      await runtime.legacyBaseline();
      await runtime.candidateApplication();
      return worker.stage(preserve);
    },
    stagedVersion,
  );
  assertHandoffVersion(
    manifest,
    preserve,
    await worker.version(installed.versionId),
    installed.versionId,
  );
  const activated = await once(
    "handoff-code-activation",
    installed,
    async () => {
      sameHandoffWorkerValue("firstHandoff.beforeCodeActivation", baseline, await worker.observe());
      await runtime.legacyBaseline();
      return worker.activate(installed.versionId);
    },
    deployment,
  );
  const installedCurrent = async () => {
    const current = await worker.observe();
    sameProvisioningValue(
      "firstHandoff.installed.deployment",
      activated.deploymentId,
      current.deploymentId,
    );
    assertHandoffVersion(manifest, preserve, current.version, installed.versionId);
    await runtime.legacyCode();
  };
  const authorization = await once(
    "handoff-adoption-authorization",
    manifest.legacy,
    async () => {
      await installedCurrent();
      return runtime.authorizeLegacy();
    },
    decodeHandoffGrant,
  );
  if (authorization.proof.kind !== "unattested-active")
    throw provisioningRefusal(
      "first-handoff-adoption-kind",
      "firstHandoff.authorization.kind",
      "unattested-active",
      authorization.proof.kind,
    );
  const original = authorization.proof;
  const readAdoption = (value: unknown) => readFirstHandoffAdoption({ result: value }, original);
  const ack = await once(
    "handoff-adoption-ack",
    authorization,
    async () => {
      await installedCurrent();
      return runtime.adopt(authorization);
    },
    readAdoption,
  );
  const readback = await once(
    "handoff-adoption-readback",
    authorization,
    async () => {
      await installedCurrent();
      return runtime.readback(authorization);
    },
    readAdoption,
  );
  sameProvisioningValue("firstHandoff.adoption.ackAndReadback", ack, readback);
  const advanced = firstHandoffVersionRequest(manifest, "advance");
  const beforeAdvance = async () => {
    await installedCurrent();
    sameProvisioningValue(
      "firstHandoff.adoption.beforeAdvance",
      ack,
      readAdoption(await runtime.readback(authorization)),
    );
  };
  const staged = await once(
    "handoff-env-stage",
    advanced,
    async () => {
      await beforeAdvance();
      return worker.stage(advanced);
    },
    stagedVersion,
  );
  assertHandoffVersion(
    manifest,
    advanced,
    await worker.version(staged.versionId),
    staged.versionId,
  );
  const current = await once(
    "handoff-env-activation",
    staged,
    async () => {
      await beforeAdvance();
      return worker.activate(staged.versionId);
    },
    deployment,
  );
  const candidateCurrent = async () => {
    enabled();
    const observed = await worker.observe();
    sameProvisioningValue(
      "firstHandoff.current.deployment",
      current.deploymentId,
      observed.deploymentId,
    );
    assertHandoffVersion(manifest, advanced, observed.version, staged.versionId);
  };
  await candidateCurrent();
  const start = await once(
    "handoff-start-authorization",
    manifest.candidate,
    () => runtime.authorizeStart(),
    decodeHandoffGrant,
  );
  const started = await once(
    "handoff-candidate-start",
    start,
    async () => {
      await candidateCurrent();
      return runtime.start(start);
    },
    identity,
  );
  const joined = await once(
    "handoff-candidate-join",
    started,
    () => runtime.join(),
    decodeHandoffGrant,
  );
  const promoted = await once(
    "handoff-candidate-promotion",
    { joined, started, operationId: manifest.promotionOperationId },
    async () => {
      await candidateCurrent();
      return runtime.promote(joined, started);
    },
    promotion,
  );
  const drained = await once(
    "handoff-legacy-drain",
    { promoted, operationId: manifest.drainOperationId },
    async () => {
      await candidateCurrent();
      return runtime.drain();
    },
    retirement,
  );
  await candidateCurrent();
  await runtime.selected(started);
  const receipt = {
    schemaVersion: 3 as const,
    disposition: "first-handoff-complete" as const,
    candidate: manifest.candidate.candidate,
    manifest: fingerprint,
    installedVersion: installed.versionId,
    currentVersion: staged.versionId,
    adoption: hash({ ack, readback }),
    active: started,
    promotion: hash(promoted),
    retirement: hash(drained),
  };
  await journal.finish(hash(receipt));
  return receipt;
}
