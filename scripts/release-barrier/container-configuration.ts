import { equalContainerValues } from "alchemy/Cloudflare/Containers/ContainerPublicationHook";
import type { ContainerAttributes } from "./container.ts";
import { changedProps, type PropChange } from "./prop-diff.ts";

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

const resourceKeys = new Set(["instanceType", "vcpu", "memory", "memoryMib", "disk"]);
export const jsonType = (value: unknown) =>
  value === undefined
    ? "absent"
    : value === null
      ? "null"
      : Array.isArray(value)
        ? "array"
        : typeof value;
const pick = (value: Configuration, keep: (key: string) => boolean) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => keep(key))) as Configuration;

// The JSON types Cloudflare resolves an instance type into.
const resolvedTypes: Record<string, string> = {
  vcpu: "number",
  memory: "string",
  memoryMib: "number",
  disk: "object",
};

/**
 * Where a readback differs from what a create request set, as redacted paths with JSON types only.
 * A set instance type also matches its resolved resources; fields Cloudflare adds are not compared.
 */
export function setConfigurationDrift(set: Configuration, observed: Configuration): PropChange[] {
  const types = (old: unknown, next: unknown) => ({ old: jsonType(old), new: jsonType(next) });
  const changes = Object.keys(set)
    .filter((field) => !resourceKeys.has(field))
    .flatMap((field) => {
      const keep = (key: string) => key === field;
      const expected = pick(set, keep);
      const actual = pick(observed, keep);
      return equalContainerConfiguration(expected, actual)
        ? []
        : changedProps(expected, actual, types);
    });
  if (!Object.keys(set).some((key) => resourceKeys.has(key))) return changes;
  // The root equivalence resolves an instance type only beside an image.
  const resources = (value: Configuration) => ({
    ...pick(value, (key) => resourceKeys.has(key)),
    image: set.image,
  });
  if (equalContainerConfiguration(resources(set), resources(observed))) return changes;
  const preset = { image: set.image, instanceType: set.instanceType };
  const resolved = Object.keys(resolvedTypes).filter((key) => {
    const value = (observed as Record<string, unknown>)[key];
    return value === undefined
      ? observed.instanceType === undefined
      : !equalContainerValues(preset, { ...preset, [key]: value });
  });
  return [
    ...changes,
    ...(observed.instanceType === undefined || observed.instanceType === set.instanceType
      ? []
      : [{ path: "instanceType", ...types(set.instanceType, observed.instanceType) }]),
    ...resolved.map((key) => ({
      path: key,
      old: resolvedTypes[key]!,
      new: jsonType((observed as Record<string, unknown>)[key]),
    })),
  ];
}

// The pinned SDK cannot encode runtime. Only its validated default may be omitted from a recovery request.
export function recoverableConfiguration(value: Configuration): Configuration {
  if (!("runtime" in value) || value.runtime !== "firecracker") return value;
  const { runtime: _runtime, ...configuration } = value;
  return configuration;
}
