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
