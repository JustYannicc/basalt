import { equalContainerValues } from "alchemy/Cloudflare/Containers/ContainerPublicationHook";
import type { ContainerAttributes } from "./container.ts";

type Configuration = ContainerAttributes["configuration"];

// Cloudflare expands omitted execution/network defaults on readback, alongside the basic preset.
const defaults = (value: Configuration) => ({
  ...value,
  command: value.command ?? [],
  entrypoint: value.entrypoint ?? [],
  network: value.network ?? { assign_ipv4: "none", assign_ipv6: "none", mode: "private" },
  runtime: ("runtime" in value ? value.runtime : undefined) ?? "firecracker",
});

export const equalContainerConfiguration = (left: Configuration, right: Configuration) =>
  equalContainerValues(defaults(left), defaults(right));

// The pinned SDK cannot encode runtime. Only its validated default may be omitted from a recovery request.
export function recoverableConfiguration(value: Configuration): Configuration {
  if (!("runtime" in value) || value.runtime !== "firecracker") return value;
  const { runtime: _runtime, ...configuration } = value;
  return configuration;
}
