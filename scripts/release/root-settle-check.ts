/**
 * Whether Alchemy's apply of the root container's planned update sends nothing but reads.
 *
 * The plan check admits the root's row in two shapes whose apply should only read: the image hash
 * the old release layer recorded, and an attachment that waits on the pool Worker. Whether it
 * really sends nothing is decided inside Alchemy's container provider at apply, after the pool
 * Worker's upload: it reads the live application, builds the configuration it would send, and
 * modifies and rolls out the application when the two differ. The wire guard refuses that, so the
 * release would stop half applied. This makes the same read and the same comparison in the
 * production plan, before anything is applied, and names the fields that differ, never values.
 *
 * The comparison is the provider's own (`equalContainerValues`, `equalApplicationSettings`,
 * `makeContainerEnv`). The desired side is built in closures the package does not export, so those
 * few lines are copied below; the test runs the provider itself on the same inputs and fails when
 * the two decide differently.
 */
import * as Containers from "@distilled.cloud/cloudflare/containers";
import { apiTokenCredentials, Credentials } from "@distilled.cloud/cloudflare/Credentials";
import { makeContainerEnv, type AnyContainerApplicationProps } from "alchemy/Cloudflare/Containers";
// The publication hook re-exports the provider's own comparison (carry 0386), from the module the
// provider imports.
import {
  equalApplicationSettings,
  equalContainerValues,
} from "alchemy/Cloudflare/Containers/ContainerPublicationHook";
import { isResolved } from "alchemy/Diff";
import { repositoryFromImageRef } from "alchemy/Docker/Registry";
import type * as Plan from "alchemy/Plan";
import { LOCAL_ID_PREFIX } from "alchemy/ProviderMode";
import { sha256Object } from "alchemy/Util/sha256";
import { normalizeNulls } from "alchemy/Util/stable";
import { Data, Effect, Redacted } from "effect";
import type { HttpClient } from "effect/http";

type Fields = Record<string, unknown>;

export class RootSettleRefused extends Data.TaggedError("RootSettleRefused")<{
  readonly check: "root-settle";
  readonly rule: string;
  /** The fields the apply would change, or the step that could not run: names only. */
  readonly field: string;
  readonly why: string;
  readonly fix: string;
  readonly cause?: unknown;
}> {
  override get message() {
    return `The root application check refused (${this.rule}: ${this.field}): ${this.why} ${this.fix}`;
  }
}
const refuse = (rule: string, field: string, why: string, fix: string, cause?: unknown) =>
  new RootSettleRefused({
    check: "root-settle",
    rule,
    field,
    why,
    fix,
    ...(cause === undefined ? {} : { cause }),
  });

const record = (value: unknown): value is Fields =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Copied from ContainerProvider.ts: `desiredConfiguration` (a closure of LiveContainerProvider).
const desiredConfiguration = (
  props: Fields,
  env: Record<string, string | Redacted.Redacted<string>>,
  imageRef: string,
): Fields =>
  normalizeNulls({
    image: imageRef,
    instanceType:
      props.instanceType ??
      (props.vcpu === undefined &&
      props.memory === undefined &&
      props.memoryMib === undefined &&
      props.disk === undefined
        ? "lite"
        : undefined),
    observability: props.observability,
    sshPublicKeyIds: props.sshPublicKeyIds,
    secrets: props.secrets,
    vcpu: props.vcpu,
    memory: props.memory,
    memoryMib: props.memoryMib,
    disk: props.disk,
    environmentVariables: Object.entries(env).map(([name, value]) => ({
      name,
      value: Redacted.isRedacted(value) ? Redacted.value(value) : value,
    })),
    labels: props.labels,
    network: props.network,
    command: props.command,
    entrypoint: props.entrypoint,
    dns: props.dns,
    ports: props.ports,
    checks: props.checks,
  });

// Copied from ContainerProvider.ts: a reference already in the target registry is deployed as
// `${repository}@${digest}`, with the account namespace inserted where Cloudflare's registry needs it.
const normalizePrepushedRef = (image: string, registryId: string, accountId: string) => {
  if (registryId !== "registry.cloudflare.com") return image;
  const rest = image.slice(registryId.length + 1);
  const first = rest.split("/")[0];
  return first !== undefined && /^[a-f0-9]{32}$/u.test(first)
    ? image
    : `${registryId}/${accountId}/${rest}`;
};
const isRegistryDigest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9]+:[a-f0-9]{64}$/iu.test(value);
const digestFromImageRef = (imageRef: string) => {
  const digest = imageRef.slice(imageRef.lastIndexOf("@") + 1);
  return imageRef.includes("@") && isRegistryDigest(digest) ? digest : undefined;
};

// A named instance type expands into the resources Cloudflare reads back, so they compare as one.
const resources = ["instanceType", "vcpu", "memory", "memoryMib", "disk"];
const settings = ["instances", "maxInstances", "schedulingPolicy", "constraints", "affinities"];

/** Each field that differs, compared alone with the provider's own functions. */
function differingFields(existing: Fields, configuration: Fields, news: Fields): string[] {
  const live = record(existing.configuration) ? existing.configuration : {};
  const image = live.image;
  // The image stays fixed while one field is compared, so Cloudflare's readback defaults apply.
  const only = (from: Fields, keys: readonly string[]) => ({
    image,
    ...Object.fromEntries(keys.map((key) => [key, from[key]])),
  });
  const names: string[] = [];
  if (!equalContainerValues(existing.configuration, configuration)) {
    if (!equalContainerValues({ image }, { image: configuration.image }))
      names.push("configuration.image");
    const keys = [...new Set([...Object.keys(live), ...Object.keys(configuration)])].sort();
    for (const key of keys)
      if (key !== "image" && !resources.includes(key))
        if (!equalContainerValues(only(live, [key]), only(configuration, [key])))
          names.push(`configuration.${key}`);
    if (!equalContainerValues(only(live, resources), only(configuration, resources))) {
      const declared = resources.filter((key) => configuration[key] !== undefined);
      names.push(...(declared.length ? declared : resources).map((key) => `configuration.${key}`));
    }
    if (!names.length) names.push("configuration");
  }
  if (!equalApplicationSettings(existing, news)) {
    const changed = settings.filter(
      (key) => !equalApplicationSettings({ [key]: existing[key] }, { [key]: news[key] }),
    );
    names.push(...(changed.length ? changed : ["settings"]));
  }
  return names;
}

export interface RootSettleInput {
  /** The root's node in the plan, if it has one. */
  readonly node: Plan.CRUD | undefined;
  /** The deployment account, as the provider's environment names it. */
  readonly accountId: string;
  /** The root pin: the policy's `poolContainer.image`. */
  readonly pin: string;
  /** One read of the live application, decoded the way the provider decodes it. */
  readonly read: (where: {
    readonly accountId: string;
    readonly applicationId: string;
  }) => Effect.Effect<Containers.GetContainerApplicationResponse, unknown, HttpClient.HttpClient>;
}

/** The provider's own read of an application: the same SDK call and decoding. */
export const liveApplication =
  (token: Redacted.Redacted<string>, apiBaseUrl?: string): RootSettleInput["read"] =>
  (where) =>
    Containers.getContainerApplication(where).pipe(
      Effect.provideService(
        Credentials,
        Effect.succeed(
          apiTokenCredentials({
            apiToken: Redacted.value(token),
            ...(apiBaseUrl ? { apiBaseUrl } : {}),
          }),
        ),
      ),
      Effect.timeout("60 seconds"),
    );

/**
 * The plan summary's line when the root's planned update settles with reads only; nothing when the
 * row is not an update this check can judge (the plan check refuses those with its own reasons).
 */
export const rootSettles = (input: RootSettleInput) =>
  Effect.gen(function* () {
    const node = input.node;
    if (!node || node.action !== "update") return undefined;
    const declared = record(node.resource.Props) ? node.resource.Props : {};
    if (
      declared.image !== input.pin ||
      ["context", "dockerfile", "main"].some((key) => declared[key] !== undefined)
    )
      return undefined;
    const news = record(node.props) ? node.props : declared;
    if (!isResolved(news))
      return yield* refuse(
        "root-apply-unknown",
        "props",
        "The root's declared props are not known before the apply, so what it sends is unknown.",
        "Declare the root container with literal props.",
      );
    const state = node.state as {
      status?: string;
      attr?: unknown;
      bindings?: { sid: string; data: unknown }[];
      old?: { bindings?: { sid: string; data: unknown }[] };
    };
    // Apply hands the provider the row's current attributes as its recorded output.
    const output = record(state.attr) ? state.attr : {};
    const applicationId = output.applicationId;
    if (
      typeof applicationId !== "string" ||
      !applicationId ||
      applicationId.startsWith(LOCAL_ID_PREFIX)
    )
      return yield* refuse(
        "root-apply-unknown",
        "applicationId",
        "State records no live root application, so the apply would look one up by name or create one.",
        "Check that State still holds the root container's row before any release.",
      );
    if (output.accountId !== input.accountId)
      return yield* refuse(
        "root-apply-unknown",
        "accountId",
        "The root's row records another account than the deployment's, so the apply would not settle it with a read.",
        "Run the release with the account State records for the root.",
      );
    const hash = record(output.hash) ? output.hash : {};

    // An attachment the plan cannot know yet takes the recorded one: the plan check proves the two
    // equal before it admits the row.
    const settled = state.status === "updating" && state.old ? state.old : state;
    const recordedBindings = new Map((settled.bindings ?? []).map(({ sid, data }) => [sid, data]));
    const bindings: { sid: string; data: Fields }[] = [];
    for (const binding of node.bindings) {
      if (binding.action === "delete") continue;
      const data = isResolved(binding.data) ? binding.data : recordedBindings.get(binding.sid);
      if (!record(data))
        return yield* refuse(
          "root-apply-unknown",
          `bindings.${binding.sid}`,
          "An attachment of the root is not known yet and State records none, so what the apply sends is unknown.",
          "Settle the root's attachment in its own reviewed step before this release.",
        );
      bindings.push({ sid: binding.sid, data });
    }
    // Copied from ContainerProvider.ts: `getDurableObjects`, and when it skips the attachment.
    const attached = bindings.flatMap(({ data }) =>
      record(data.durableObjects) && data.durableObjects.namespaceId ? [data.durableObjects] : [],
    );
    const unique = attached.filter(
      (entry, index) =>
        attached.findIndex((other) => other.namespaceId === entry.namespaceId) === index,
    );
    if (unique.length > 1)
      return yield* refuse(
        "root-apply-unknown",
        "durableObjects",
        "The root would be attached to more than one namespace; the provider stops on that.",
        "Bind the root container from exactly one Durable Object class.",
      );
    const durableObjects = unique[0];
    const attachmentUnresolved =
      durableObjects === undefined &&
      bindings.some(({ data }) => data.durableObjects !== undefined);

    const application = yield* input
      .read({ accountId: input.accountId, applicationId })
      .pipe(
        Effect.mapError((cause) =>
          refuse(
            "root-read-failed",
            "read",
            (cause as { _tag?: unknown })?._tag === "ContainerApplicationNotFound"
              ? "The live read of the root application found none, so the apply would look one up by name or create one."
              : "The live read of the root application failed, so whether the apply sends reads only is unknown.",
            "Run the plan again; if the read keeps failing, find out why before any release.",
            cause,
          ),
        ),
      );
    // Copied from ContainerProvider.ts: the fields of `toAttributes` the decision reads.
    const existing: Fields = {
      schedulingPolicy: application.schedulingPolicy,
      instances: application.instances,
      maxInstances: application.maxInstances,
      constraints: normalizeNulls(application.constraints),
      affinities: normalizeNulls(application.affinities),
      configuration: normalizeNulls(application.configuration),
      durableObjects: normalizeNulls(application.durableObjects),
    };
    if (!attachmentUnresolved && !equalContainerValues(existing.durableObjects, durableObjects))
      return yield* refuse(
        "root-apply-recreates",
        "durableObjects",
        "The live application is attached to another namespace than the planned one, so the apply would delete and recreate it.",
        "Find out why the root's attachment moved before any release.",
      );

    // Copied from ContainerProvider.ts (`computeImage`, `upsertApplication`): a pre-pushed image
    // keeps the recorded digest while its hash is unchanged, and deploys the reference's otherwise.
    const image = String(news.image);
    const publish = record(news.publish) ? news.publish : {};
    const imageName =
      typeof publish.repository === "string" ? publish.repository.toLowerCase() : undefined;
    const imageHash = (yield* sha256Object({ image, imageName })).slice(0, 16);
    const registryId =
      typeof news.registryId === "string" ? news.registryId : "registry.cloudflare.com";
    const prepushed = image.startsWith(`${registryId}/`)
      ? normalizePrepushedRef(image, registryId, input.accountId)
      : undefined;
    const digest =
      imageHash === hash.image && isRegistryDigest(hash.digest)
        ? hash.digest
        : prepushed && digestFromImageRef(prepushed);
    if (!prepushed || !digest)
      return yield* refuse(
        "root-apply-unknown",
        "configuration.image",
        "The root's image is not a digest reference in the account's registry, so the apply would push it or ask the registry for its digest.",
        "Pin the root to the digest reference State records.",
      );
    const env = makeContainerEnv(news as AnyContainerApplicationProps, input.accountId, bindings);
    const configuration = desiredConfiguration(
      news,
      env,
      `${repositoryFromImageRef(prepushed)}@${digest}`,
    );
    if (
      equalContainerValues(existing.configuration, configuration) &&
      equalApplicationSettings(existing, news)
    )
      return "Root application: the apply's own comparison finds the live application equal to what it would send, so it sends reads only.";
    return yield* refuse(
      "root-apply-modifies",
      differingFields(existing, configuration, news).join(","),
      "Alchemy's apply would modify and roll out the root application; the wire guard refuses that after the pool Worker's upload, leaving the release half applied.",
      "Make the root's declaration equal to the live application in these fields, or change the root in its own reviewed release.",
    );
  });
