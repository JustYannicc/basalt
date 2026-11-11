import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { PreviewClient, type PreviewClientConfig } from "../pool-acceptance/preview-client.ts";
import { PreviewHttpClient } from "../pool-acceptance/preview-http.ts";
import { catalogAcceptanceApps } from "./catalog-acceptance-inventory.ts";
import {
  digest,
  installedOriginIssues,
  type OriginBindingIssue,
  expectedSource,
  identifier,
  record,
  sourceFilesDigest,
} from "./catalog-acceptance-source.ts";

export type CatalogAcceptanceRow = {
  index: number;
  entry: string;
  package: string;
  sourcePath: string;
  candidateHead: string;
  originBindingIssues: OriginBindingIssue[];
  expectedDocumentSha256: string;
  expectedFilesSha256: string;
  observedDocumentSha256: string | null;
  installedFilesSha256: string | null;
  appId: string | null;
  activeVersion: string | null;
  outcome: "not-run" | "success" | "BuildMemoryExceeded" | "failed";
  failure: string | null;
  httpStatus: number | null;
  elapsedMs: number;
};
export type CatalogAcceptanceResult = {
  version: 1;
  mode: "preview-cold";
  candidateHead: string;
  frameworkVersion: string;
  inventorySha256: string;
  signIn: boolean;
  coldCacheWitness: boolean;
  rows: CatalogAcceptanceRow[];
  cleanup: {
    createdAppIds: string[];
    deletedAppIds: string[];
    verifiedAbsent: boolean;
    signedOut: boolean;
    uncertainMutation: boolean;
  };
};

// The host retries a confirmed memory failure once. Cover both 50-second admission/compile
// budgets plus HTTP overhead without changing the host retry or existing client deadlines.
const installRequestTimeoutMs = 240_000;

export async function runCatalogAcceptance(
  config: PreviewClientConfig,
  candidateHead: string,
  resultPath: string,
  options: { readonly fetch?: typeof fetch } = {},
): Promise<CatalogAcceptanceResult> {
  if (!/^[a-f0-9]{40}$/.test(candidateHead))
    throw new Error("Catalog acceptance requires an exact head");
  const expected = await Promise.all(
    catalogAcceptanceApps.map((app) => expectedSource(app, config.origin)),
  );
  const result: CatalogAcceptanceResult = {
    version: 1,
    mode: "preview-cold",
    candidateHead,
    frameworkVersion: expected[0]!.frameworkVersion,
    inventorySha256: digest(JSON.stringify(catalogAcceptanceApps)),
    signIn: false,
    coldCacheWitness: false,
    rows: catalogAcceptanceApps.map((app, index) => ({
      ...app,
      index,
      candidateHead,
      originBindingIssues: [],
      expectedDocumentSha256: expected[index]!.documentSha256,
      expectedFilesSha256: expected[index]!.filesSha256,
      observedDocumentSha256: null,
      installedFilesSha256: null,
      appId: null,
      activeVersion: null,
      outcome: "not-run",
      failure: null,
      httpStatus: null,
      elapsedMs: 0,
    })),
    cleanup: {
      createdAppIds: [],
      deletedAppIds: [],
      verifiedAbsent: false,
      signedOut: false,
      uncertainMutation: false,
    },
  };
  const client = new PreviewClient(config, { fetch: options.fetch });
  const http = client.http;
  const installHttp = new PreviewHttpClient(config.origin, {
    fetch: options.fetch,
    requestTimeoutMs: installRequestTimeoutMs,
  });
  const prefix = `/api/organizations/${encodeURIComponent(config.organizationId)}`;
  const checkpoint = () => writeFile(resultPath, `${JSON.stringify(result)}\n`, { mode: 0o600 });
  const requestJson = async (path: string, method = "GET", body?: unknown) => {
    const response = await http.request(
      path,
      {
        method,
        headers: http.headers({
          Origin: config.origin,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        }),
        ...(body === undefined
          ? {}
          : { body: http.encodeJson(body, "Catalog acceptance request") }),
      },
      "Catalog acceptance",
    );
    await http.expectOk(response, "Catalog acceptance");
    return http.readJson(response, "Catalog acceptance");
  };
  const inventory = async () => {
    const value = record(await requestJson(`${prefix}/inventory`));
    if (!Array.isArray(value.apps)) throw new Error("Inventory omitted apps");
    return new Set(value.apps.map((app: unknown) => identifier(record(app).id)));
  };
  let signedInAttempted = false;
  await writeFile(resultPath, `${JSON.stringify(result)}\n`, { flag: "wx", mode: 0o600 });
  try {
    signedInAttempted = true;
    await client.signIn();
    result.signIn = true;
    const existing = await inventory();
    const listed = await requestJson("/api/catalog");
    if (!Array.isArray(listed)) throw new Error("Public catalog omitted entries");
    const entries = listed.map(record);
    for (const row of result.rows) {
      const started = performance.now();
      let mutationPending = false;
      try {
        const expectedRow = expected[row.index]!;
        const response = await http.request(
          expectedRow.path,
          {
            method: "GET",
            headers: http.headers({ "Cache-Control": "no-cache" }, false),
          },
          "Catalog source",
        );
        await http.expectOk(response, "Catalog source");
        if (
          response.headers.get("x-basalt-preview-head") !== candidateHead ||
          response.headers.get("x-basalt-preview-compiler-cache-mode") !== "cold"
        )
          throw new Error("cold-cache-witness-missing");
        const source = await http.readJson(response, "Catalog source");
        // The canonical files bind the compiler input; document fields are bound independently.
        row.observedDocumentSha256 = digest(JSON.stringify(source));
        if (
          row.observedDocumentSha256 !== row.expectedDocumentSha256 ||
          sourceFilesDigest(record(source).files) !== row.expectedFilesSha256
        )
          throw new Error("public-source-binding-mismatch");
        const entry = entries.filter(
          (entry) => entry.id === row.entry && entry.package === row.package,
        );
        if (entry.length !== 1) throw new Error("required-catalog-entry-missing-or-duplicated");
        mutationPending = true;
        const install = await installHttp.request(
          `${prefix}/apps/install`,
          {
            method: "POST",
            headers: http.headers({ Origin: config.origin, "Content-Type": "application/json" }),
            body: http.encodeJson(
              {
                entry: row.entry,
                name: `Acceptance ${row.entry} ${randomUUID().slice(0, 8)}`,
                newInstance: true,
              },
              "Catalog install",
            ),
          },
          "Catalog install",
        );
        row.httpStatus = install.status;
        const payload = record(await installHttp.readJson(install, "Catalog install"));
        if (!install.ok) {
          mutationPending = false;
          if (install.status >= 500) result.cleanup.uncertainMutation = true;
          if (install.status === 422 && payload._tag === "BuildMemoryExceeded") {
            row.outcome = "BuildMemoryExceeded";
            row.failure = "BuildMemoryExceeded";
          } else {
            row.outcome = "failed";
            row.failure =
              typeof payload._tag === "string" && /^[A-Za-z0-9_]{1,80}$/.test(payload._tag)
                ? payload._tag
                : "install-refused";
          }
          continue;
        }
        if (payload.reused !== false) throw new Error("installer-reused-an-app");
        const id = identifier(payload.id);
        if (existing.has(id) || result.cleanup.createdAppIds.includes(id))
          throw new Error("installer-returned-existing-id");
        result.cleanup.createdAppIds.push(id);
        row.appId = id;
        mutationPending = false;
        // Persist the cleanup ID before any further request or assertion can fail.
        await checkpoint();
        row.activeVersion = identifier(payload.activeVersion);
        row.originBindingIssues = installedOriginIssues(payload, {
          package: row.package,
          reference: `${config.origin}${expectedRow.path}`,
        });
        if (row.originBindingIssues.length) throw new Error("installed-origin-binding-mismatch");
        const retained = record(
          await requestJson(
            `${prefix}/apps/${encodeURIComponent(id)}/source?version=${encodeURIComponent(row.activeVersion)}`,
          ),
        );
        row.installedFilesSha256 = sourceFilesDigest(retained.files);
        if (row.installedFilesSha256 !== row.expectedFilesSha256)
          throw new Error("installed-source-binding-mismatch");
        row.outcome = "success";
      } catch (error) {
        if (mutationPending) result.cleanup.uncertainMutation = true;
        row.outcome = "failed";
        const message = error instanceof Error ? error.message : "acceptance-failed";
        row.failure = /^[a-z][a-z-]{1,100}$/.test(message)
          ? message
          : "acceptance-request-or-validation-failed";
      } finally {
        row.elapsedMs = Math.round(performance.now() - started);
        await checkpoint();
      }
    }
    result.coldCacheWitness =
      result.rows.every((row) => row.observedDocumentSha256 !== null) &&
      !result.rows.some((row) => row.failure === "cold-cache-witness-missing");
  } catch {
    // Raw exceptions may contain auth data or untrusted response bodies.
  } finally {
    for (const id of [...result.cleanup.createdAppIds].reverse()) {
      try {
        const removed = record(
          await requestJson(`${prefix}/apps/${encodeURIComponent(id)}`, "DELETE"),
        );
        if (removed.app === id) result.cleanup.deletedAppIds.push(id);
      } catch {
        /* The final result records failed cleanup. */
      }
    }
    if (result.signIn) {
      try {
        const remaining = await inventory();
        result.cleanup.verifiedAbsent = result.cleanup.createdAppIds.every(
          (id) => !remaining.has(id),
        );
      } catch {
        /* Absence remains unverified. */
      }
    }
    if (signedInAttempted) {
      try {
        await client.signOut();
        result.cleanup.signedOut = true;
      } catch {
        /* Sign-out remains unverified. */
      }
    }
    await checkpoint();
  }
  return result;
}
