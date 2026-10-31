import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";

/** A fresh app must reject a changed vendor document, including a new OAuth operation. */
export const proveSpecificationDrift = ({
  actors,
  prefix,
  request,
  checked,
  catalogApp,
  provider,
  client,
  account,
  directory,
  check,
}) =>
  Effect.gen(function* () {
    const restore = provider.tamperJiraSpecification();
    try {
      const deployed = checked(
        yield* request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: "Atlassian specification drift proof",
          files: catalogApp.files,
        }),
        200,
        "Deploy a fresh app with the exact captured catalog source",
      );
      const appPath = `${prefix}/apps/${deployed.id}`;
      const access = checked(
        yield* request(actors.owner, "GET", `${appPath}/access`),
        200,
        "Read drift app access",
      );
      checked(
        yield* request(actors.owner, "PATCH", `${appPath}/access`, {
          revision: access.revision,
          audience: { kind: "everyone" },
        }),
        200,
        "Expose the drift app to the synthetic member",
      );
      checked(
        yield* request(
          actors.member,
          "PUT",
          `${appPath}/accounts/user/atlassian/${encodeURIComponent(account)}`,
        ),
        200,
        "Link the member's own existing grant to the fresh app",
      );
      const before = provider.requests.length;
      const apiRequests = provider.apiRequests().length;
      const path = `tools[${JSON.stringify(deployed.slug)}].jira.issues.unreviewedDriftProbe`;
      const result = yield* Effect.promise(() =>
        client.callTool({ name: "search", arguments: { query: path, limit: 1 } }),
      );
      appendFileSync(
        join(directory, "specification-drift.jsonl"),
        `${JSON.stringify({ path, result })}\n`,
        { mode: 0o600 },
      );
      const fetched = provider.requests
        .slice(before)
        .some(
          (entry) =>
            entry.path === "/openapi/jira.json" &&
            entry.status === 200 &&
            entry.specificationSha256 !== catalogApp.provenance.capabilities.apis.jira.sha256,
        );
      check(fetched, "The actual hosted loader fetched the tampered full vendor document");
      const content = result.structuredContent;
      check(
        !result.isError &&
          content?.unavailableApps?.some(
            (entry) => entry.app === deployed.id && entry.router === "jira",
          ),
        "An unreviewed vendor document makes its router unavailable",
      );
      check(
        Array.isArray(content?.items) && !content.items.some((entry) => entry.path === path),
        "The new unreviewed OAuth operation is not served",
      );
      check(
        provider.apiRequests().length === apiRequests,
        "Rejecting document drift makes no API call",
      );
      return { unreviewedSpecificationRejected: true };
    } finally {
      restore();
    }
  });
