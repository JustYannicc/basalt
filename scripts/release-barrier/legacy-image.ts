import type { ContainerApplication } from "alchemy/Cloudflare";
import type { PreparedContainerPublication } from "alchemy/Cloudflare/Containers/ContainerPublicationHook";
import { havePropsChanged } from "alchemy/Diff";
import { equalContainerConfiguration } from "./container-configuration.ts";
import { BarrierRefusal } from "./refusal.ts";
import { changedProps } from "./prop-diff.ts";

const sourceIndependent = (props: ContainerApplication["Props"]) =>
  Object.fromEntries(
    Object.entries(props).filter(([name]) => name !== "context" && name !== "image"),
  );

export function pinnedLegacyDeclaration(
  props: ContainerApplication["Props"],
  olds: ContainerApplication["Props"],
  image: string,
) {
  return props.className === "PoolContainer" && pinnedRuntimeDeclaration(props, olds, image);
}

export function pinnedRuntimeDeclaration(
  props: ContainerApplication["Props"],
  olds: ContainerApplication["Props"],
  image: string,
) {
  return (
    ["PoolContainer", "PoolRuntime", "PoolRuntimeBlue", "PoolRuntimeGreen"].includes(
      props.className ?? "",
    ) &&
    "image" in props &&
    props.image === image &&
    /^registry\.cloudflare\.com\/[^/]+\/.+@sha256:[a-f0-9]{64}$/u.test(image) &&
    !havePropsChanged(sourceIndependent(props), sourceIndependent(olds))
  );
}

/** A pinned declaration retains measured image provenance, separately from Alchemy's new reference hash. */
export function preserveLegacyPublication(
  publication: PreparedContainerPublication,
  props: ContainerApplication["Props"],
  olds: ContainerApplication["Props"] | undefined,
) {
  if (
    !olds ||
    !["PoolContainer", "PoolRuntime", "PoolRuntimeBlue", "PoolRuntimeGreen"].includes(
      publication.id,
    ) ||
    !("image" in props)
  )
    return { publication };
  if (!pinnedRuntimeDeclaration(props, olds, publication.previous.configuration.image))
    throw new BarrierRefusal("unsupported-container-declaration-change", publication.id, {
      fqn: publication.id,
      type: "Cloudflare.Container",
      changed: changedProps(olds, props),
    });
  if (
    !equalContainerConfiguration(
      publication.previous.configuration,
      publication.proposed.configuration,
    )
  )
    throw new BarrierRefusal("legacy-image-preservation-configuration-change", publication.id, {
      fqn: publication.id,
      type: "Cloudflare.Container",
      changed: changedProps(publication.previous.configuration, publication.proposed.configuration),
    });
  const retained = publication.previous.hash;
  const proposed = publication.proposed.hash;
  if (
    !retained?.image ||
    !retained.digest ||
    !proposed?.image ||
    proposed.digest !== retained.digest
  )
    throw new BarrierRefusal("container-baseline-input-unconfirmed", publication.id);
  return {
    publication: {
      ...publication,
      proposed: {
        ...publication.proposed,
        hash: { ...proposed, image: retained.image, digest: retained.digest },
      },
    },
    preservedSourceInputHash: proposed.image,
  };
}
