import type { Feed, FeedEntry } from "./feed.ts";

export type OAuthDecision =
  | { kind: "deferred"; message: string }
  | { kind: "hosted"; client: string; message: string }
  | { kind: "account-endpoint"; message: string }
  | { kind: "automatic"; protocol: "dcr" | "cimd"; metadata: string; metadataSha256: string };

export interface OAuthReview {
  entry: string;
  package: string;
  sourceSha256?: string;
  methods: Readonly<Record<string, OAuthDecision>>;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const https = (value: unknown): value is string =>
  text(value) && URL.canParse(value) && new URL(value).protocol === "https:";

/** Missing entries stay missing: a new publisher method needs its own reviewed decision. */
export function oauthReviews(value: unknown): readonly OAuthReview[] {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.entries))
    throw new Error("Invalid OAuth catalog review registry");
  const seen = new Set<string>();
  return value.entries.map((entry: unknown) => {
    if (
      !record(entry) ||
      !text(entry.entry) ||
      !text(entry.package) ||
      entry.entry.includes("*") ||
      entry.package.includes("*") ||
      (entry.sourceSha256 !== undefined && !digest(entry.sourceSha256)) ||
      !record(entry.methods) ||
      seen.has(entry.entry)
    )
      throw new Error("Invalid or repeated OAuth catalog review");
    seen.add(entry.entry);
    const methods: Record<string, OAuthDecision> = {};
    for (const [method, decision] of Object.entries(entry.methods)) {
      if (!text(method) || method.includes("*") || !record(decision))
        throw new Error(`Invalid OAuth decision for ${entry.entry}`);
      if (decision.kind === "deferred" && text(decision.message))
        methods[method] = { kind: "deferred", message: decision.message };
      else if (decision.kind === "account-endpoint" && text(decision.message))
        methods[method] = { kind: "account-endpoint", message: decision.message };
      else if (decision.kind === "hosted" && text(decision.client) && text(decision.message))
        methods[method] = { kind: "hosted", client: decision.client, message: decision.message };
      else if (
        decision.kind === "automatic" &&
        (decision.protocol === "dcr" || decision.protocol === "cimd") &&
        https(decision.metadata) &&
        digest(decision.metadataSha256)
      )
        methods[method] = {
          kind: "automatic",
          protocol: decision.protocol,
          metadata: decision.metadata,
          metadataSha256: decision.metadataSha256,
        };
      else throw new Error(`Unclassified OAuth method ${entry.entry}/${method}`);
    }
    if (Object.keys(methods).length === 0) throw new Error(`Empty OAuth review for ${entry.entry}`);
    if (
      Object.values(methods).some((method) => method.kind !== "deferred") &&
      !digest(entry.sourceSha256)
    )
      throw new Error(`OAuth availability for ${entry.entry} needs a reviewed source digest`);
    return {
      entry: entry.entry,
      package: entry.package,
      ...(digest(entry.sourceSha256) ? { sourceSha256: entry.sourceSha256 } : {}),
      methods,
    };
  });
}

export const oauthMethods = (entry: FeedEntry): string[] =>
  entry.auth.flatMap((method) =>
    record(method) && method.kind === "oauth2" && text(method.method) ? [method.method] : [],
  );

export interface OAuthEvidence {
  sources: ReadonlyMap<string, string>;
  hostedClients: ReadonlySet<string>;
  metadata: ReadonlyMap<string, { sha256: string; document: unknown }>;
  metadataFailures?: ReadonlyMap<string, string>;
}

/** Source content binds manual review to the declaration that a person will actually install. */
export function oauthFitness(
  feed: Feed,
  reviews: readonly OAuthReview[],
  evidence: OAuthEvidence,
): string[] {
  const problems: string[] = [];
  const reviewed = new Map(reviews.map((review) => [review.entry, review]));
  const entries = new Map(feed.apps.map((entry) => [entry.id, entry]));
  for (const entry of feed.apps) {
    const methods = oauthMethods(entry);
    if (methods.length === 0) continue;
    const review = reviewed.get(entry.id);
    if (review === undefined) {
      problems.push(`${entry.id}: OAuth methods have no reviewed availability decision`);
      continue;
    }
    if (review.package !== entry.package) problems.push(`${entry.id}: reviewed package changed`);
    if (
      Object.values(review.methods).some((method) => method.kind !== "deferred") &&
      evidence.sources.get(entry.id) !== review.sourceSha256
    )
      problems.push(`${entry.id}: published source changed or could not be verified`);
    for (const method of methods) {
      const decision = review.methods[method];
      if (decision === undefined)
        problems.push(`${entry.id}/${method}: OAuth method is unclassified`);
      else if (decision.kind === "hosted" && !evidence.hostedClients.has(decision.client))
        problems.push(
          `${entry.id}/${method}: hosted client ${decision.client} is not defined by this host`,
        );
      else if (decision.kind === "automatic") {
        const proof = evidence.metadata.get(decision.metadata);
        if (proof === undefined) {
          problems.push(
            `${entry.id}/${method}: automatic client metadata is unavailable (${decision.metadata}: ${evidence.metadataFailures?.get(decision.metadata) ?? "no document"})`,
          );
          continue;
        }
        if (proof.sha256 !== decision.metadataSha256) {
          problems.push(
            `${entry.id}/${method}: automatic client metadata changed (metadataSha256: ${decision.metadataSha256} -> ${proof.sha256})`,
          );
          continue;
        }
        const document = proof.document;
        const rejectProtocolField = (property: string, expected: string, observed: unknown) => {
          problems.push(
            `${entry.id}/${method}: automatic client metadata does not support the reviewed protocol (${property}: expected ${expected}, observed ${JSON.stringify(observed) ?? "missing"})`,
          );
        };
        if (!record(document)) {
          rejectProtocolField("document", "object", document);
          continue;
        }
        for (const property of [
          "issuer",
          "authorization_endpoint",
          "token_endpoint",
          ...(decision.protocol === "dcr" ? ["registration_endpoint"] : []),
        ]) {
          if (!https(document[property]))
            rejectProtocolField(property, "HTTPS URL", document[property]);
        }
        if (decision.protocol === "cimd" && document.client_id_metadata_document_supported !== true)
          rejectProtocolField(
            "client_id_metadata_document_supported",
            "true",
            document.client_id_metadata_document_supported,
          );
      }
    }
    for (const method of Object.keys(review.methods))
      if (!methods.includes(method))
        problems.push(`${entry.id}/${method}: reviewed OAuth method no longer exists`);
  }
  for (const review of reviews)
    if (!entries.has(review.entry) || oauthMethods(entries.get(review.entry)!).length === 0)
      problems.push(`${review.entry}: reviewed OAuth entry no longer exists`);
  return problems;
}

/** Deferrals are connection guidance. They never alter a provider or its available auth methods. */
export function withOAuthDeferrals(feed: Feed, reviews: readonly OAuthReview[]): Feed {
  const reviewed = new Map(reviews.map((review) => [review.entry, review]));
  return {
    ...feed,
    apps: feed.apps.map((entry) => {
      const review = reviewed.get(entry.id);
      if (review?.package !== entry.package) return entry;
      const oauthDeferrals = oauthMethods(entry).flatMap((method) => {
        const decision = review.methods[method];
        return decision === undefined ||
          decision.kind === "automatic" ||
          decision.kind === "account-endpoint"
          ? []
          : [{ method, message: decision.message }];
      });
      return oauthDeferrals.length === 0 ? entry : { ...entry, oauthDeferrals };
    }),
  };
}
