import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { oauthPinProblems, oauthReviews, type OAuthReview } from "../src/catalog/oauth-policy.ts";
import {
  automaticDecisions,
  catalogDocumentSha256,
  committedOAuthMetadata,
  liveOAuthMetadata,
  metadataSnapshotFile,
} from "./catalog-oauth-metadata.ts";
import { scopeHistoryFile, scopeListDigest } from "./oauth-whole-list-issuers-source.ts";

type Evidence = Awaited<ReturnType<typeof liveOAuthMetadata>>;
type Fields = Record<string, unknown>;

const fields = (value: unknown): Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : {};
const list = (value: unknown) => (Array.isArray(value) ? value : undefined);
const same = (left: unknown, right: unknown) =>
  left === right ||
  (left !== undefined &&
    right !== undefined &&
    catalogDocumentSha256(left) === catalogDocumentSha256(right));

/**
 * The values automatic sign-in reads from a document, as the SDK's discovery, registration and
 * token code uses them (`.upstream/packages/sdk/src/implementation/oauth-protocol-*.ts`).
 */
export function signInValues(document: unknown, protocol: "dcr" | "cimd"): Fields {
  const server = fields(document);
  const methods = list(server.token_endpoint_auth_methods_supported);
  const method =
    protocol === "cimd" || methods?.includes("none")
      ? "none"
      : methods?.includes("client_secret_post")
        ? "client_secret_post"
        : "client_secret_basic";
  const challenges = list(server.code_challenge_methods_supported);
  const grants = list(server.grant_types_supported);
  return {
    issuer: server.issuer,
    authorization_endpoint: server.authorization_endpoint,
    token_endpoint: server.token_endpoint,
    // Registration only runs while metadata documents aren't used; that flag alerts on its own.
    ...(protocol === "dcr" ? { registration_endpoint: server.registration_endpoint } : {}),
    // Both flags act only when exactly true, so an explicit false changes nothing.
    "metadata documents supported": server.client_id_metadata_document_supported === true,
    "iss required on callback": server.authorization_response_iss_parameter_supported === true,
    "token endpoint auth method":
      methods === undefined || methods.includes(method) ? method : `${method} (not offered)`,
    "S256 PKCE accepted": challenges === undefined || challenges.includes("S256"),
    "refresh grant registered": grants === undefined || grants.includes("refresh_token"),
    "offline_access requested": list(server.scopes_supported)?.includes("offline_access") ?? false,
  };
}

// Publisher text lands in a PR body: keep each value inside one bounded code span.
const code = (text: string) =>
  `\`${(text.length > 160 ? `${text.slice(0, 157)}...` : text).replaceAll("`", "'")}\``;
const shown = (value: unknown) => code(JSON.stringify(value) ?? "missing");

/** One line per changed field. Lists of plain values show the items that came and went. */
export function fieldChanges(before: unknown, after: unknown): string[] {
  const old = fields(before);
  const next = fields(after);
  return [...new Set([...Object.keys(old), ...Object.keys(next)])].sort().flatMap((key) => {
    const name = code(JSON.stringify(key).slice(1, -1));
    if (!(key in next)) return [`${name}: removed (was ${shown(old[key])})`];
    if (!(key in old)) return [`${name}: added ${shown(next[key])}`];
    if (same(old[key], next[key])) return [];
    const [was, now] = [list(old[key]), list(next[key])];
    if (was && now && [...was, ...now].every((item) => typeof item !== "object")) {
      const added = now.filter((item) => !was.includes(item)).map(shown);
      const removed = was.filter((item) => !now.includes(item)).map(shown);
      if (added.length + removed.length === 0) return [`${name}: order changed`];
      return [
        `${name}: ${[added.length ? `added ${added.join(", ")}` : "", removed.length ? `removed ${removed.join(", ")}` : ""].filter(Boolean).join("; ")}`,
      ];
    }
    return [`${name}: ${shown(old[key])} -> ${shown(next[key])}`];
  });
}

export interface Drift {
  entry: string;
  method: string;
  metadata: string;
  pinned: string;
  published: string;
  document: unknown;
  changes: string[];
  /** Sign-in already behaves differently, whatever CI says. */
  signIn: string[];
  /** The published document no longer passes the reviewed protocol rules. */
  problems: string[];
  /** The connection asks for its issuer's whole scope list, so its requested scopes follow it. */
  wholeList: boolean;
}

/** Compare today's published documents with the committed snapshots their pins review. */
export function metadataDrift(
  reviews: readonly OAuthReview[],
  committed: Evidence,
  published: Evidence,
): { drift: Drift[]; unavailable: string[] } {
  const drift: Drift[] = [];
  const unavailable: string[] = [];
  const seen = new Set<string>();
  for (const decision of automaticDecisions(reviews)) {
    // Methods sharing one document share its snapshot, so they share one re-pin.
    if (seen.has(`${decision.entry} ${decision.metadata}`)) continue;
    seen.add(`${decision.entry} ${decision.metadata}`);
    const live = published.metadata.get(decision.metadata);
    if (live === undefined) {
      unavailable.push(
        `${decision.entry}/${decision.method}: ${decision.metadata}: ${published.metadataFailures.get(decision.metadata) ?? "no document"}`,
      );
      continue;
    }
    if (live.sha256 === decision.metadataSha256) continue;
    const before = committed.metadata.get(decision.metadata)?.document;
    const [old, next] = [
      signInValues(before, decision.protocol),
      signInValues(live.document, decision.protocol),
    ];
    const repinned = { ...decision, metadataSha256: live.sha256 };
    drift.push({
      entry: decision.entry,
      method: decision.method,
      metadata: decision.metadata,
      pinned: decision.metadataSha256,
      published: live.sha256,
      document: live.document,
      changes: fieldChanges(before, live.document),
      signIn: Object.keys(next).flatMap((key) =>
        same(old[key], next[key]) ? [] : [`${key}: ${shown(old[key])} -> ${shown(next[key])}`],
      ),
      problems: oauthPinProblems(
        [{ entry: decision.entry, methods: { [decision.method]: repinned } }],
        {
          hostedClients: new Set(),
          metadata: published.metadata,
        },
      ),
      wholeList: decision.scopeRequest === "issuer-list",
    });
  }
  return { drift, unavailable };
}

/**
 * Rewrite one entry's snapshot and pin; the registry keeps its committed formatting. A whole-list
 * connection's new scope list joins its history, which saved grants are recognized by.
 */
export function repinMetadata(directory: string, drift: Drift) {
  writeFileSync(
    join(directory, metadataSnapshotFile(drift.entry)),
    JSON.stringify(drift.document, null, 2) + "\n",
  );
  const scopes = list(fields(drift.document).scopes_supported);
  if (drift.wholeList && scopes?.every((scope): scope is string => typeof scope === "string")) {
    const file = join(directory, scopeHistoryFile(drift.entry));
    const history: string[] = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
    const digest = scopeListDigest(scopes);
    if (history.at(-1) !== digest)
      writeFileSync(file, JSON.stringify([...history, digest], null, 2) + "\n");
  }
  const file = join(directory, "oauth-reviews.json");
  const registry = JSON.parse(readFileSync(file, "utf8"));
  for (const entry of registry.entries)
    for (const decision of Object.values<Record<string, unknown>>(entry.methods))
      if (entry.entry === drift.entry && decision.metadata === drift.metadata)
        decision.metadataSha256 = drift.published;
  writeFileSync(file, JSON.stringify(registry, null, 2) + "\n");
}

export function driftReport(drift: Drift): string {
  const alert = drift.signIn.length + drift.problems.length > 0;
  // Such a connection's requested scopes must equal the document's, so its catalog test fails.
  const followsList =
    drift.wholeList && drift.changes.some((line) => line.startsWith("`scopes_supported`"));
  return [
    `## ${drift.entry}/${drift.method}: published OAuth metadata changed`,
    "",
    `Document: ${drift.metadata}`,
    `metadataSha256: \`${drift.pinned}\` -> \`${drift.published}\``,
    "",
    "Changed fields:",
    "",
    ...drift.changes.map((line) => `- ${line}`),
    "",
    alert
      ? "**Sign-in already behaves differently.** Values sign-in reads changed:"
      : followsList
        ? "This connection asks for its issuer's whole scope list, so the scopes it requests must change with `scopes_supported` in this pull request; its catalog test fails until they match. Until then, sign-in keeps asking for the previous list, and saved grants are held to what they asked for."
        : "Values sign-in reads are unchanged, so sign-in behaves as reviewed.",
    ...(alert ? ["", ...[...drift.signIn, ...drift.problems].map((line) => `- ${line}`)] : []),
    "",
  ].join("\n");
}

const prBody = (drift: Drift) =>
  [
    driftReport(drift),
    "The scheduled OAuth metadata drift job opened this re-pin. Merging it accepts the new document",
    `as reviewed: it replaces \`src/catalog/${metadataSnapshotFile(drift.entry)}\` and its pin in`,
    `\`src/catalog/oauth-reviews.json\`${drift.wholeList ? `, and adds the new list to \`src/catalog/${scopeHistoryFile(drift.entry)}\`` : ""}. A different decision has to land in that registry on main;`,
    "while the published document still differs from the pin, the next run reopens this re-pin.",
    "",
  ].join("\n");

async function main() {
  const { values } = parseArgs({
    options: {
      catalog: { type: "string" },
      repin: { type: "string" },
      body: { type: "string" },
      summary: { type: "string" },
      output: { type: "string" },
    },
  });
  const directory = resolve(
    values.catalog ?? fileURLToPath(new URL("../src/catalog", import.meta.url)),
  );
  const reviews = oauthReviews(
    JSON.parse(readFileSync(join(directory, "oauth-reviews.json"), "utf8")),
  );
  const decisions = automaticDecisions(reviews).filter(
    (decision) => values.repin === undefined || decision.entry === values.repin,
  );
  if (values.repin !== undefined && decisions.length === 0)
    throw new Error(`${values.repin} has no automatic OAuth metadata to re-pin`);
  const { drift, unavailable } = metadataDrift(
    reviews.filter((review) => decisions.some((decision) => decision.entry === review.entry)),
    committedOAuthMetadata(reviews, directory),
    await liveOAuthMetadata(decisions.map((decision) => decision.metadata)),
  );
  const report = [
    ...drift.map(driftReport),
    ...(unavailable.length
      ? ["## Published OAuth metadata could not be read", "", ...unavailable.map((l) => `- ${l}`)]
      : []),
  ].join("\n");
  const text = report || "Every published OAuth metadata document matches its reviewed pin.";
  console.log(text);
  if (values.summary) appendFileSync(values.summary, `${text}\n`);
  if (values.repin !== undefined) {
    for (const item of drift) repinMetadata(directory, item);
    // Without a change the PR step finds nothing to commit; it still reads a body.
    if (values.body)
      writeFileSync(
        values.body,
        drift.length ? drift.map(prBody).join("\n") : "The published document matches its pin.\n",
      );
    if (unavailable.length > 0) process.exitCode = 1;
    return;
  }
  if (values.output)
    appendFileSync(
      values.output,
      `entries=${JSON.stringify([...new Set(drift.map((item) => item.entry))])}\n`,
    );
  // Benign additions only open a review. A used value or an unreadable document is broken now.
  if (unavailable.length > 0 || drift.some((item) => item.signIn.length + item.problems.length))
    process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
