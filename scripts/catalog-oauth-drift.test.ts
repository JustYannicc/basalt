import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { driftReport, metadataDrift, repinMetadata, signInValues } from "./catalog-oauth-drift.ts";
import { scopeListDigest } from "./oauth-whole-list-issuers-source.ts";
import {
  automaticDecisions,
  catalogDocumentSha256,
  committedOAuthMetadata,
  metadataSnapshotFile,
} from "./catalog-oauth-metadata.ts";
import { oauthPinProblems, oauthReviews } from "../src/catalog/oauth-policy.ts";

const catalog = fileURLToPath(new URL("../src/catalog", import.meta.url));
const script = fileURLToPath(new URL("./catalog-oauth-drift.ts", import.meta.url));
const added = "pronunciation_dictionaries_write";

/** A catalog copy whose ElevenLabs review still pins the document before that scope existed. */
function previousCatalog() {
  const directory = mkdtempSync(join(tmpdir(), "catalog-oauth-drift-"));
  const reviews = oauthReviews(
    JSON.parse(readFileSync(join(catalog, "oauth-reviews.json"), "utf8")),
  );
  for (const { entry } of automaticDecisions(reviews))
    copyFileSync(
      join(catalog, metadataSnapshotFile(entry)),
      join(directory, metadataSnapshotFile(entry)),
    );
  const published = JSON.parse(
    readFileSync(join(catalog, "elevenlabs.oauth-metadata.json"), "utf8"),
  );
  const previous = {
    ...published,
    scopes_supported: published.scopes_supported.filter((scope: string) => scope !== added),
  };
  writeFileSync(
    join(directory, "elevenlabs.oauth-metadata.json"),
    JSON.stringify(previous, null, 2),
  );
  writeFileSync(
    join(directory, "oauth-reviews.json"),
    readFileSync(join(catalog, "oauth-reviews.json"), "utf8").replace(
      catalogDocumentSha256(published),
      catalogDocumentSha256(previous),
    ),
  );
  return { directory, published, previous };
}

const load = (directory: string) => {
  const reviews = oauthReviews(
    JSON.parse(readFileSync(join(directory, "oauth-reviews.json"), "utf8")),
  );
  return { reviews, committed: committedOAuthMetadata(reviews, directory) };
};
const publishing = (
  committed: ReturnType<typeof load>["committed"],
  url: string,
  document: unknown,
) => ({
  metadata: new Map([
    ...committed.metadata,
    [url, { sha256: catalogDocumentSha256(document), document }],
  ]),
  metadataFailures: new Map<string, string>(),
});
const elevenlabs = "https://api.us.elevenlabs.io/.well-known/oauth-authorization-server";

test("a benign vendor addition becomes a re-pin with its field diff and no alert", () => {
  const { directory, published, previous } = previousCatalog();
  try {
    const { reviews, committed } = load(directory);
    const { drift, unavailable } = metadataDrift(
      reviews,
      committed,
      publishing(committed, elevenlabs, published),
    );
    assert.deepEqual(unavailable, []);
    assert.equal(drift.length, 1);
    assert.deepEqual(
      { ...drift[0]!, document: undefined },
      {
        entry: "elevenlabs",
        method: "oauth",
        metadata: elevenlabs,
        pinned: catalogDocumentSha256(previous),
        published: catalogDocumentSha256(published),
        document: undefined,
        changes: [`\`scopes_supported\`: added \`"${added}"\``],
        signIn: [],
        problems: [],
        wholeList: false,
      },
    );
    assert.match(driftReport(drift[0]!), /Values sign-in reads are unchanged/);
    repinMetadata(directory, drift[0]!);
    assert.equal(existsSync(join(directory, "elevenlabs.oauth-scope-history.json")), false);
    // The re-pin PR is exactly the committed state the offline check accepts.
    const repinned = load(directory);
    const automatic = repinned.reviews.filter((review) =>
      Object.values(review.methods).some((decision) => decision.kind === "automatic"),
    );
    assert.deepEqual(
      oauthPinProblems(automatic, { hostedClients: new Set(), ...repinned.committed }),
      [],
    );
    assert.deepEqual(
      readFileSync(join(directory, "oauth-reviews.json"), "utf8"),
      readFileSync(join(catalog, "oauth-reviews.json"), "utf8"),
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(directory, "elevenlabs.oauth-metadata.json"), "utf8")),
      published,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a whole-list connection's re-pin says its requested scopes must follow and extends its history", () => {
  const directory = mkdtempSync(join(tmpdir(), "catalog-oauth-drift-"));
  try {
    const reviews = oauthReviews(
      JSON.parse(readFileSync(join(catalog, "oauth-reviews.json"), "utf8")),
    );
    for (const { entry } of automaticDecisions(reviews))
      copyFileSync(
        join(catalog, metadataSnapshotFile(entry)),
        join(directory, metadataSnapshotFile(entry)),
      );
    const published = JSON.parse(
      readFileSync(join(catalog, "cloudflare.oauth-metadata.json"), "utf8"),
    );
    const previous = {
      ...published,
      scopes_supported: published.scopes_supported.filter(
        (scope: string) => !scope.startsWith("billing:"),
      ),
    };
    writeFileSync(
      join(directory, "cloudflare.oauth-metadata.json"),
      JSON.stringify(previous, null, 2),
    );
    writeFileSync(
      join(directory, "oauth-reviews.json"),
      readFileSync(join(catalog, "oauth-reviews.json"), "utf8").replace(
        catalogDocumentSha256(published),
        catalogDocumentSha256(previous),
      ),
    );
    const { reviews: pinned, committed } = load(directory);
    const { drift } = metadataDrift(
      pinned,
      committed,
      publishing(
        committed,
        "https://mcp.cloudflare.com/.well-known/oauth-authorization-server",
        published,
      ),
    );
    assert.equal(drift.length, 1);
    assert.equal(drift[0]!.wholeList, true);
    const report = driftReport(drift[0]!);
    assert.match(report, /the scopes it requests must change with `scopes_supported`/);
    assert.doesNotMatch(report, /Values sign-in reads are unchanged/);
    const history = join(directory, "cloudflare.oauth-scope-history.json");
    writeFileSync(history, JSON.stringify(["403:0000000000000000"]));
    repinMetadata(directory, drift[0]!);
    const digest = scopeListDigest(published.scopes_supported);
    assert.deepEqual(JSON.parse(readFileSync(history, "utf8")), ["403:0000000000000000", digest]);
    // A second re-pin to the same list leaves the history as it is.
    repinMetadata(directory, drift[0]!);
    assert.deepEqual(JSON.parse(readFileSync(history, "utf8")), ["403:0000000000000000", digest]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a changed issuer, endpoint or sign-in method raises an alert beside its re-pin", () => {
  const { reviews, committed } = load(catalog);
  const current = committed.metadata.get(elevenlabs)!.document as Record<string, unknown>;
  for (const [change, alert] of [
    [
      { issuer: "https://unreviewed.example" },
      `issuer: \`"${current.issuer}"\` -> \`"https://unreviewed.example"\``,
    ],
    [
      { token_endpoint: "https://unreviewed.example/token" },
      `token_endpoint: \`"${current.token_endpoint}"\` -> \`"https://unreviewed.example/token"\``,
    ],
    [{ code_challenge_methods_supported: ["plain"] }, "S256 PKCE accepted: `true` -> `false`"],
    [
      { token_endpoint_auth_methods_supported: ["client_secret_basic"] },
      'token endpoint auth method: `"none"` -> `"none (not offered)"`',
    ],
    [
      { grant_types_supported: ["authorization_code"] },
      "refresh grant registered: `true` -> `false`",
    ],
  ] as const) {
    const { drift } = metadataDrift(
      reviews,
      committed,
      publishing(committed, elevenlabs, { ...current, ...change }),
    );
    assert.equal(drift.length, 1, JSON.stringify(change));
    assert.deepEqual(drift[0]!.signIn, [alert]);
  }
  const { drift } = metadataDrift(
    reviews,
    committed,
    publishing(committed, elevenlabs, { ...current, client_id_metadata_document_supported: false }),
  );
  assert.deepEqual(drift[0]!.problems, [
    "elevenlabs/oauth: automatic client metadata does not support the reviewed protocol (client_id_metadata_document_supported: expected true, observed false)",
  ]);
});

test("registration and callback flags alert only where sign-in reads them", () => {
  const { reviews, committed } = load(catalog);
  const alphavantage = "https://mcp.alphavantage.co/.well-known/oauth-authorization-server";
  const signIn = (url: string, change: Record<string, unknown>) => {
    const current = committed.metadata.get(url)!.document as Record<string, unknown>;
    const { drift } = metadataDrift(
      reviews,
      committed,
      publishing(committed, url, { ...current, ...change }),
    );
    assert.equal(drift.length, 1, JSON.stringify(change));
    return drift[0]!.signIn;
  };
  // Metadata-document sign-in never registers, so its registration endpoint is unused.
  assert.deepEqual(
    signIn(elevenlabs, { registration_endpoint: "https://unreviewed.example/register" }),
    [],
  );
  assert.deepEqual(
    signIn(alphavantage, { registration_endpoint: "https://unreviewed.example/register" }),
    [
      'registration_endpoint: `"https://mcp.alphavantage.co/register"` -> `"https://unreviewed.example/register"`',
    ],
  );
  assert.deepEqual(
    signIn(alphavantage, { authorization_response_iss_parameter_supported: false }),
    [],
  );
  assert.deepEqual(signIn(alphavantage, { authorization_response_iss_parameter_supported: true }), [
    "iss required on callback: `false` -> `true`",
  ]);
  assert.deepEqual(signIn(elevenlabs, { client_id_metadata_document_supported: false }), [
    "metadata documents supported: `true` -> `false`",
  ]);
});

test("methods sharing one document share one re-pin that moves every pin", () => {
  const { directory, published } = previousCatalog();
  try {
    const file = join(directory, "oauth-reviews.json");
    const registry = JSON.parse(readFileSync(file, "utf8"));
    const entry = registry.entries.find((item: { entry: string }) => item.entry === "elevenlabs");
    entry.methods.second = { ...entry.methods.oauth };
    writeFileSync(file, JSON.stringify(registry, null, 2) + "\n");
    const { reviews, committed } = load(directory);
    const { drift } = metadataDrift(
      reviews,
      committed,
      publishing(committed, elevenlabs, published),
    );
    assert.equal(drift.length, 1);
    repinMetadata(directory, drift[0]!);
    const repinned = JSON.parse(readFileSync(file, "utf8")).entries.find(
      (item: { entry: string }) => item.entry === "elevenlabs",
    );
    assert.deepEqual(
      [repinned.methods.oauth.metadataSha256, repinned.methods.second.metadataSha256],
      [catalogDocumentSha256(published), catalogDocumentSha256(published)],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("registration picks the method the SDK would request", () => {
  const document = {
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
  };
  assert.equal(signInValues(document, "dcr")["token endpoint auth method"], "client_secret_post");
  assert.equal(signInValues({}, "dcr")["token endpoint auth method"], "client_secret_basic");
  assert.equal(signInValues(document, "cimd")["token endpoint auth method"], "none (not offered)");
});

test("an unreadable published document alerts without a re-pin", () => {
  const { reviews, committed } = load(catalog);
  const { drift, unavailable } = metadataDrift(reviews, committed, {
    metadata: new Map([...committed.metadata].filter(([url]) => url !== elevenlabs)),
    metadataFailures: new Map([[elevenlabs, "HTTP 503"]]),
  });
  assert.deepEqual(drift, []);
  assert.deepEqual(unavailable, [`elevenlabs/oauth: ${elevenlabs}: HTTP 503`]);
});

test("the scheduled job lists benign drift for re-pin PRs and fails only on an alert", () => {
  const { directory, published } = previousCatalog();
  try {
    const run = (documents: Record<string, unknown>) => {
      const output = join(directory, "output.txt");
      rmSync(output, { force: true });
      const serve = `data:text/javascript,${encodeURIComponent(
        `const documents = ${JSON.stringify(documents)};
globalThis.fetch = async (url) => Response.json(documents[url]);`,
      )}`;
      const result = spawnSync(
        process.execPath,
        ["--import", serve, script, "--catalog", directory, "--output", output],
        { encoding: "utf8" },
      );
      return { status: result.status, output: readFileSync(output, "utf8") };
    };
    const { reviews, committed } = load(catalog);
    const documents = Object.fromEntries(
      automaticDecisions(reviews).map(({ metadata }) => [
        metadata,
        committed.metadata.get(metadata)!.document,
      ]),
    );
    assert.deepEqual(run({ ...documents, [elevenlabs]: published }), {
      status: 0,
      output: 'entries=["elevenlabs"]\n',
    });
    assert.deepEqual(
      run({ ...documents, [elevenlabs]: { ...published, issuer: "https://unreviewed.example" } }),
      {
        status: 1,
        output: 'entries=["elevenlabs"]\n',
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
