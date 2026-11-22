import { hashDockerBuildInputs } from "alchemy/Docker/BuildHash";
import { sha256Object } from "alchemy/Util/sha256";
import { Effect } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";

/** The one slice of Alchemy's plan this reads, so any plan shape that carries it will do. */
export interface PlanResources {
  readonly resources: Readonly<Record<string, unknown>>;
}

export type ContainerImage = "image changes" | "attachment only" | "image not known";

interface ContainerProps {
  readonly context?: unknown;
  readonly dockerfile?: unknown;
  readonly image?: unknown;
  readonly publish?: { readonly repository?: unknown };
}
interface ContainerNode {
  readonly action?: string;
  readonly resource?: { readonly Type?: string };
  readonly props?: ContainerProps;
  readonly state?: {
    readonly props?: ContainerProps;
    readonly attr?: { hash?: { image?: unknown } };
  };
}

/**
 * The pinned provider's own image input for a build context (Cloudflare/Container `computeImage`,
 * variant 3b), kept to its exact arguments: the build platform and the `effective` mode it hashes.
 */
const contextImageInput = Effect.fn(function* (props: ContainerProps & { context: string }) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = yield* fs.realPath(props.context);
  const dockerfile =
    typeof props.dockerfile === "string"
      ? yield* fs.realPath(props.dockerfile)
      : path.join(context, "Dockerfile");
  const contextHash = yield* hashDockerBuildInputs(
    { context, dockerfile, platform: "linux/amd64" },
    "effective",
  );
  const repository = props.publish?.repository;
  const imageName = typeof repository === "string" ? repository.toLowerCase() : undefined;
  return (yield* sha256Object({ contextHash, imageName })).slice(0, 16);
});

/**
 * The provider plans a new image and a new Durable Object attachment both as `update`. For each
 * Container the plan updates, this says which: a build context's image input against the one
 * State records, or a pinned image against the recorded prop. Anything it cannot read is "image
 * not known", never "attachment only".
 */
const readImages = Effect.fn(function* (plan: PlanResources) {
  const images = new Map<string, ContainerImage>();
  for (const [fqn, value] of Object.entries(plan.resources)) {
    const node = value as ContainerNode | undefined;
    if (node?.resource?.Type !== "Cloudflare.Container" || node.action !== "update") continue;
    const props = node.props ?? {};
    const recorded = node.state?.attr?.hash?.image;
    if (typeof props.context === "string") {
      const input = yield* contextImageInput({ ...props, context: props.context }).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      images.set(
        fqn,
        input === undefined || typeof recorded !== "string"
          ? "image not known"
          : input === recorded
            ? "attachment only"
            : "image changes",
      );
    } else if (typeof props.image === "string") {
      const before = node.state?.props?.image;
      images.set(
        fqn,
        typeof before !== "string"
          ? "image not known"
          : before === props.image
            ? "attachment only"
            : "image changes",
      );
    } else images.set(fqn, "image not known");
  }
  return images;
});

/** Reads the build context with Node's own file services, whatever the caller provides. */
export const containerImages = (plan: PlanResources) =>
  readImages(plan).pipe(Effect.provide(NodeServices.layer));
