import type * as Plan from "alchemy/Plan";
import * as Output from "alchemy/Output";
import { isResolved } from "alchemy/Diff";
import { hashDockerBuildInputs } from "alchemy/Docker/BuildHash";
import { sha256Object } from "alchemy/Util/sha256";
import { Effect, FileSystem, Path } from "effect";
import { changedProps, publicPropPath } from "./prop-diff.ts";

/** Describe expressions, never evaluate them or retain their values in public diagnostics. */
export function plannedReasons(plan: Plan.Plan, node: Plan.Apply) {
  const reasons = new Set<string>();
  const walk = (value: unknown, path: string[]) => {
    if (Output.isExpr(value) && !isResolved(value)) {
      for (const fqn of Object.keys(Output.upstreamAny(value))) {
        const action = plan.resources[fqn]?.action ?? "resolve";
        reasons.add(
          `input ${publicPropPath(path)} unknown until ${publicPropPath([fqn])} ${action} resolves`,
        );
      }
    } else if (Array.isArray(value)) {
      value.forEach((part, index) => walk(part, [...path, String(index)]));
    } else if (
      value &&
      typeof value === "object" &&
      Object.getPrototypeOf(value) === Object.prototype
    ) {
      Object.entries(value).forEach(([key, part]) => walk(part, [...path, key]));
    }
  };
  if (!node.state) reasons.add("resource has no recorded state; first creation planned");
  else if (!["created", "updated"].includes(node.state.status))
    reasons.add(`recorded lifecycle is ${node.state.status}; reconciliation is incomplete`);
  walk("props" in node ? node.props : node.resource.Props, ["props"]);
  node.bindings.forEach((binding, index) =>
    walk(binding.data, ["bindings", String(index), "data"]),
  );
  if (node.bindings.some((binding) => binding.action !== "noop")) {
    const before =
      node.state?.status === "updating"
        ? node.state.old?.bindings
        : node.state && "bindings" in node.state
          ? node.state.bindings
          : [];
    const after = node.bindings
      .filter((binding) => binding.action !== "delete")
      .map(({ sid, data }) => ({ sid, data }));
    for (const change of changedProps(before, after))
      reasons.add(`binding ${change.path} changed or remains unresolved`);
  }
  if (!reasons.size)
    reasons.add(
      "provider requested reconciliation despite unchanged declared props and resolved bindings; provider-specific state must be verified",
    );
  return [...reasons];
}

/** Use the pinned provider's exact context identity without building or publishing an image. */
export const imagePlanReasons = (plan: Plan.Plan) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reasons = new Map<string, string[]>();
    for (const [fqn, node] of Object.entries(plan.resources)) {
      if (node.resource.Type !== "Cloudflare.Container" || node.action !== "update") continue;
      const props = node.resource.Props;
      if (
        typeof props.context !== "string" ||
        props.main !== undefined ||
        props.image !== undefined ||
        (props.dockerfile !== undefined && typeof props.dockerfile !== "string")
      )
        continue;
      const hash = yield* Effect.gen(function* () {
        const context = yield* fs.realPath(props.context);
        const dockerfile = props.dockerfile
          ? yield* fs.realPath(props.dockerfile)
          : path.join(context, "Dockerfile");
        const contextHash = yield* hashDockerBuildInputs(
          { context, dockerfile, platform: "linux/amd64" },
          "effective",
        );
        return (yield* sha256Object({
          contextHash,
          imageName: props.publish?.repository?.toLowerCase(),
        })).slice(0, 16);
      }).pipe(Effect.catch(() => Effect.succeed(undefined)));
      const saved =
        node.state?.status === "updating"
          ? node.state.old?.attr
          : node.state && "attr" in node.state
            ? node.state.attr
            : undefined;
      const old = saved?.hash?.image;
      if (hash && typeof old === "string" && /^[a-f0-9]{16}$/u.test(old))
        reasons.set(fqn, [
          hash === old
            ? `image build input hash unchanged (${hash})`
            : `image build input hash changed: ${old} → ${hash}`,
        ]);
    }
    return reasons;
  });
