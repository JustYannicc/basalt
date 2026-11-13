import { canonical, hash } from "./encoding.ts";

const fail = (): never => {
  throw new Error("Invalid retained inventory page chain");
};
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const ids = (value: unknown, prefix: string): value is string[] =>
  Array.isArray(value) &&
  value.every(
    (v: unknown) => typeof v === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,251}$`).test(v),
  ) &&
  new Set(value).size === value.length;
function build(value: unknown) {
  if (
    !record(value) ||
    typeof value.build !== "string" ||
    !/^bld_[A-Za-z0-9_-]{1,251}$/.test(value.build) ||
    !ids(value.apps, "app") ||
    !ids(value.deployments, "dpl") ||
    value.complete !== true ||
    typeof value.version !== "string" ||
    !value.version ||
    !digest(value.sha256) ||
    !integer(value.protocol) ||
    value.protocol < 1
  )
    fail();
  return {
    build: value.build,
    apps: value.apps,
    deployments: value.deployments,
    complete: true as const,
    version: value.version,
    sha256: value.sha256,
    protocol: value.protocol,
  };
}

/** Merge only decrypted, complete, contiguous pages from one captured association set. */
export function mergeInventoryPages(values: readonly unknown[], digests: readonly string[]) {
  let first: Record<string, unknown> | undefined;
  let scope: string | undefined;
  let snapshot: Record<string, unknown> | undefined;
  let session: unknown;
  let last = "";
  let references = 0;
  const builds: ReturnType<typeof build>[] = [];
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (
      !record(value) ||
      value.format !== "basalt-production-inventory-v1" ||
      value.selection !== "retained-frameworks" ||
      value.complete !== true ||
      !record(value.page) ||
      !Array.isArray(value.builds) ||
      value.builds.length > 64 ||
      !Array.isArray(value.frameworks)
    )
      fail();
    const page = value.page;
    if (
      !record(page.snapshot) ||
      !integer(page.snapshot.references) ||
      typeof page.snapshot.fingerprint !== "string" ||
      !/^[a-f0-9]{32}$/.test(page.snapshot.fingerprint) ||
      !integer(page.references) ||
      page.references > 2000 ||
      !digest(page.metadataSha256) ||
      hash(canonical(value.frameworks)) !== page.metadataSha256 ||
      page.index !== index ||
      page.prior !== (index ? digests[index - 1] : null) ||
      page.after !== last ||
      typeof page.session !== "string" ||
      !page.session ||
      page.more !== index < values.length - 1
    )
      fail();
    const binding = canonical([
      value.target,
      value.release,
      value.organization,
      value.database,
      page.snapshot,
      page.metadataSha256,
    ]);
    if (first === undefined) {
      first = value;
      scope = binding;
      snapshot = page.snapshot;
      session = page.session;
    }
    if (scope !== binding || session !== page.session) fail();
    for (const raw of value.builds) {
      const item = build(raw);
      if (seen.has(item.build) || item.build <= last) fail();
      seen.add(item.build);
      last = item.build;
      builds.push(item);
    }
    if (page.last !== last || (page.more && value.builds.length === 0)) fail();
    references += page.references;
  }
  if (!first || !snapshot || references !== snapshot.references || values.length !== digests.length)
    fail();
  const tuples = new Map<
    string,
    {
      version: string;
      sha256: string;
      protocol: number;
      apps: Set<string>;
      deployments: Set<string>;
    }
  >();
  for (const item of builds) {
    const key = canonical([item.version, item.sha256, item.protocol]);
    const tuple = tuples.get(key) ?? {
      version: item.version,
      sha256: item.sha256,
      protocol: item.protocol,
      apps: new Set<string>(),
      deployments: new Set<string>(),
    };
    item.apps.forEach((id) => tuple.apps.add(id));
    item.deployments.forEach((id) => tuple.deployments.add(id));
    tuples.set(key, tuple);
  }
  return {
    format: "basalt-production-inventory-v1",
    target: first.target,
    release: first.release,
    organization: first.organization,
    database: first.database,
    observedAt: first.observedAt,
    selection: "retained-frameworks",
    complete: true,
    frameworks: first.frameworks,
    builds,
    rows: [...tuples.values()].map(({ version, sha256, protocol, apps, deployments }) => ({
      version,
      sha256,
      protocol,
      apps: [...apps].sort(),
      deployments: deployments.size,
    })),
  };
}
