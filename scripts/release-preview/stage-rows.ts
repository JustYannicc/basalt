/**
 * What a Worker's State row holds that Alchemy's plan compares against: the hash slots
 * (`bundle`, `metadata`, `assets`, `input`), the names of its env vars with a fingerprint of each
 * value, and its binding names. No value leaves this module, only a 12-hex fingerprint, so two
 * reads can be compared without exposing them. Kept in the stage's private output only.
 */
import { createHash } from "node:crypto";

export const evidenceRows = ["ArtifactsCredentials", "Formatter", "Authoring"] as const;

const fingerprint = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : (JSON.stringify(value) ?? "undefined"))
    .digest("hex")
    .slice(0, 12);

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function stateEvidence(
  rows: readonly { path: string; value: unknown }[],
  fqns: readonly string[] = evidenceRows,
) {
  return Object.fromEntries(
    fqns.map((fqn) => {
      const row = rows.find((entry) => entry.path.endsWith(`/${fqn}`))?.value;
      if (!row) return [fqn, null];
      const state = record(row);
      const attr = record(state.attr);
      const props = record(state.props);
      const hash = record(attr.hash);
      const env = record(props.env);
      const bindings = Array.isArray(state.bindings) ? state.bindings : [];
      return [
        fqn,
        {
          status: state.status ?? null,
          hash: Object.fromEntries(
            ["bundle", "metadata", "assets", "input"].map((slot) => [
              slot,
              typeof hash[slot] === "string" ? (hash[slot] as string).slice(0, 16) : null,
            ]),
          ),
          propKeys: Object.keys(props).sort(),
          env: Object.fromEntries(
            Object.keys(env)
              .sort()
              .map((key) => [key, fingerprint(env[key])]),
          ),
          bindings: bindings.map((binding) => String(record(binding).sid ?? "?")).sort(),
        },
      ];
    }),
  );
}

const secretKey = /secret|token|password|credential|private|signing|cookie|authorization/iu;
// What a public report never shows: hostnames, URLs and 32-hex account, zone or script ids.
const hostLike = /^(?:[a-z][a-z0-9+.-]*:\/\/|[a-z0-9*-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:\/|$))/iu;
const idLike = /(?:^|[^0-9a-f])[0-9a-f]{32}(?:[^0-9a-f]|$)/iu;

/** A value with every hostname, URL, 32-hex id and secret-named key filtered out. */
function filtered(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[deep]";
  if (typeof value === "string")
    return hostLike.test(value) || idLike.test(value) ? "[filtered]" : value;
  if (Array.isArray(value)) return value.map((item) => filtered(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      secretKey.test(key) ? "[redacted]" : filtered(item, depth + 1),
    ]),
  );
}

/** A key that is itself a value: a 32-hex or UUID id, or a host. Such keys show only as a kind. */
const idKey = (key: string) =>
  /^[0-9a-f]{32}$/iu.test(key) ||
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(key) ||
  hostLike.test(key) ||
  idLike.test(key);

/**
 * Only the key names of a value, at every depth, so its shape shows and none of its values. A key
 * that is an id or a host (a map keyed by a resource id) shows as `[id]`, numbered if repeated.
 */
function keysOnly(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[deep]";
  if (Array.isArray(value)) return value.map((item) => keysOnly(item, depth + 1));
  if (!value || typeof value !== "object") return typeof value;
  let ids = 0;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      idKey(key) ? `[id ${++ids}]` : key,
      keysOnly(item, depth + 1),
    ]),
  );
}

const count = (value: unknown) => (Array.isArray(value) ? value.length : null);

/** Whether the recorded `workerId` is empty, or the same as the Worker's script name. */
function workerIdEmptyOrName(attr: Record<string, unknown>, props: Record<string, unknown>) {
  const id = attr.workerId;
  if (id === undefined || id === null || id === "") return true;
  const name = attr.workerName ?? attr.scriptName ?? attr.name ?? props.name;
  return typeof name === "string" && id === name;
}

/**
 * A Worker row as State records it, for reading why a fresh declaration plans it as an update
 * with no changed prop. Only the `build` and `assets` props and the provider's hash slots keep
 * values, filtered of hostnames, URLs and 32-hex ids; every other prop, and each binding, keeps
 * its key names alone. Private output only.
 */
export function recordedWorkerProps(
  rows: readonly { path: string; value: unknown }[],
  fqns: readonly string[],
) {
  return Object.fromEntries(
    fqns.map((fqn) => {
      const row = record(rows.find((entry) => entry.path.endsWith(`/${fqn}`))?.value);
      const props = record(row.props);
      return [
        fqn,
        {
          status: typeof row.status === "string" ? row.status : null,
          build: filtered(props.build),
          assets: filtered(props.assets),
          hash: filtered(record(record(row.attr).hash)),
          propKeys: keysOnly(
            Object.fromEntries(
              Object.entries(props).filter(([key]) => !["build", "assets"].includes(key)),
            ),
          ),
          stateBindings: keysOnly(row.bindings),
          attrKeys: Object.keys(record(row.attr)).sort(),
          // The provider diff's four inputs, derived here so no name, pattern or id leaves.
          workerIdEmptyOrName: workerIdEmptyOrName(record(row.attr), props),
          counts: {
            routes: count(record(row.attr).routes),
            crons: count(record(row.attr).crons),
            domains: count(record(row.attr).domains),
          },
        },
      ];
    }),
  );
}

/** True when a key named like a password sits anywhere in the value. */
function hasPassword(value: unknown, depth = 0): boolean {
  if (depth > 8 || !value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, item]) => /password/iu.test(key) || hasPassword(item, depth + 1),
  );
}

/**
 * How a database connection row records its `origin`, in its props and in its output: the key
 * names and whether a password field is present, never a host, user or password.
 */
export function recordedOrigins(
  rows: readonly { path: string; value: unknown }[],
  fqns: readonly string[],
) {
  const shape = (origin: unknown) =>
    origin && typeof origin === "object" && !Array.isArray(origin)
      ? {
          keys: Object.keys(origin as Record<string, unknown>).sort(),
          password: hasPassword(origin),
        }
      : "absent";
  return Object.fromEntries(
    fqns.map((fqn) => {
      const row = record(rows.find((entry) => entry.path.endsWith(`/${fqn}`))?.value);
      if (!Object.keys(row).length) return [fqn, "no row"];
      return [
        fqn,
        { props: shape(record(row.props).origin), output: shape(record(row.attr).origin) },
      ];
    }),
  );
}
