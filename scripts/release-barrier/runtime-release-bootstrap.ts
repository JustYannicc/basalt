import type { CompiledStack } from "alchemy/Stack";
import { State } from "alchemy/State/State";
import { sha256Object } from "alchemy/Util/sha256";
import { Config, Effect, Redacted, Schema } from "effect";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { digest, canonical, BarrierRefusal } from "./manifest.ts";
import { decodeRuntimeCreate } from "./runtime-create-schema.ts";
import {
  RuntimeProvisioningManifest,
  provisioningManifestDigest,
} from "./provisioning-contract.ts";
import { runtimeNamespaceReader } from "./runtime-namespace-read.ts";
import { runtimeNamespaceRequest } from "./provisioning-namespace.ts";
import { provisionDeclaredRuntime } from "./provisioning-declarations.ts";
import { stateProvisioningStore } from "./provisioning-state.ts";
import { inspectPoolImage } from "../deploy-safety/pool-image-metadata.ts";
import type { RuntimeReleaseClient } from "./runtime-release-client.ts";
import type { RuntimeReleaseWriter } from "./runtime-release-writer.ts";
import type { RuntimeReleaseRecord } from "./runtime-release-journal.ts";
import { runtimeApplicationPins } from "./runtime-release-state.ts";
import { readRuntimeProviderProof } from "./runtime-slot-provider-proof.ts";
import { applicationTemplateDigest, expectedApplicationRequest } from "./provisioning-wire.ts";

/** Create one source-declared idle application through the existing namespace-first, one-send journal. */
export const bootstrapReleaseApplication = (
  stack: CompiledStack,
  input: {
    color: "blue" | "green";
    record: RuntimeReleaseRecord;
    writer: RuntimeReleaseWriter;
    client: RuntimeReleaseClient;
    encryptionKey: string;
    save(record: RuntimeReleaseRecord): Promise<void>;
  },
) =>
  Effect.gen(function* () {
    const { color, record, writer, client } = input;
    const name = color === "blue" ? "PoolRuntimeBlue" : "PoolRuntimeGreen";
    const state = yield* yield* State;
    let manifest = record.bootstrap[color];
    if (!manifest) {
      const resource = stack.resources[name];
      if (!resource)
        throw new BarrierRefusal("runtime-release-bootstrap-declaration-missing", name);
      const root = record.baseline.applications.root;
      const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
      const metadata = yield* Effect.promise(() =>
        inspectPoolImage(root.image.image, root.image.digest, {
          accountId: root.attributes.accountId,
          apiToken: Redacted.value(token),
        }),
      );
      const imageInput = (yield* sha256Object({
        image: root.image.image,
        imageName: undefined,
      })).slice(0, 16);
      const require = createRequire(import.meta.url);
      const sdk = new URL(
        "../src/Cloudflare/Containers/ContainerProvider.ts",
        pathToFileURL(require.resolve("alchemy")),
      );
      const declaration = decodeRuntimeCreate({
        action: "create-container",
        type: "Cloudflare.Container",
        fqn: name,
        disposition: "provision-only",
        baseline: "absent",
        accountId: root.attributes.accountId,
        instanceId: digest(`${writer.candidate}:${name}`).slice(0, 32),
        namespace: { workerFqn: "PoolWorker", className: name, binding: name },
        props: resource.Props,
        publication: {
          inputHash: imageInput,
          imageConfigDigest: metadata.configDigest,
          platform: metadata.platform,
          capabilityLabel: metadata.capabilityLabel,
        },
        sdkSourceDigest: digest(readFileSync(sdk)),
        removalPolicy: "retain",
        retention: { data: true, nativeStateRow: true, recoveryDescriptor: true },
      });
      const namespace = yield* runtimeNamespaceReader(
        root.attributes.accountId,
        record.baseline.target.worker,
      );
      const baseline = yield* Effect.promise(() => namespace.baseline());
      const operationId = `bootstrap-${color}-${writer.candidate}`;
      const request = runtimeNamespaceRequest(baseline, declaration, operationId);
      const snapshot = yield* Effect.promise(() => client.inspect());
      const active = snapshot.selection?.active.identity;
      if (!active) throw new BarrierRefusal("runtime-release-bootstrap-active-missing", name);
      const current = Object.values(record.baseline.applications).find(
        (app) => app?.attributes.applicationId === active.applicationId,
      );
      if (!current) throw new BarrierRefusal("runtime-release-bootstrap-active-not-retained", name);
      const pins = runtimeApplicationPins(current.attributes, active.imageInput);
      manifest = Schema.decodeUnknownSync(RuntimeProvisioningManifest)({
        schemaVersion: 3,
        disposition: "provision-only",
        candidate: writer.candidate,
        stack: stack.name,
        stage: stack.stage,
        operationId,
        declaration,
        namespaceBaselineDigest: digest(canonical(baseline)),
        namespaceRequestDigest: digest(canonical(request)),
        applicationTemplateDigest: digest(canonical(declaration.props)),
        active: {
          applicationId: active.applicationId,
          namespaceId: pins.namespaceId,
          version: Number(active.applicationVersion),
          configurationDigest: pins.applicationConfigDigest,
          bootId: active.bootId,
          selectionEpoch: snapshot.selection!.epoch,
        },
      });
      manifest = {
        ...manifest,
        applicationTemplateDigest: applicationTemplateDigest(
          expectedApplicationRequest(manifest, "$namespace-receipt"),
          "$namespace-receipt",
        ),
      };
      yield* Effect.promise(() =>
        input.save({ ...record, bootstrap: { ...record.bootstrap, [color]: manifest! } }),
      );
    }
    const frozen = manifest;
    const context =
      yield* Effect.context<Effect.Services<ReturnType<typeof readRuntimeProviderProof>>>();
    const run = Effect.runPromiseWith(context);
    const store = stateProvisioningStore(state, stack, input.encryptionKey, writer.exclusive);
    return yield* provisionDeclaredRuntime(stack, {
      manifest: frozen,
      enable: writer.enable(provisioningManifestDigest(frozen)),
      scriptName: record.baseline.target.worker,
      store,
      active: async () => {
        const snapshot = await client.inspect();
        const identity = snapshot.selection?.active.identity;
        if (
          !identity ||
          identity.applicationId !== frozen.active.applicationId ||
          identity.bootId !== frozen.active.bootId ||
          snapshot.selection?.epoch !== frozen.active.selectionEpoch
        )
          throw new BarrierRefusal("runtime-release-bootstrap-active-drift", name);
        await client.health();
        await run(
          readRuntimeProviderProof(
            {
              target: identity,
              provider: {
                accountId: frozen.declaration.accountId,
                namespaceId: frozen.active.namespaceId,
                applicationConfigDigest: frozen.active.configurationDigest,
              },
            },
            "runtime",
          ),
        );
        return frozen.active;
      },
    });
  });
