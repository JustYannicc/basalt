import { mergeFeed, type Addition, type FeedAddition, type Feed } from "./feed.ts";
import type { ConnectorAvailability } from "./notices.ts";
import { catalog } from "./settings.ts";
import { atlassianAddition } from "./atlassian/index.ts";
import { slackSource, withSlackUserAuth } from "./slack.ts";
import { aws } from "./aws/index.ts";
import { zendeskAddition, unavailableZendeskAddition } from "./zendesk/source.ts";
import { isZendeskSubdomain } from "./zendesk/tenant.ts";

// AWS source stays in the catalog until maintainers identify a maintained destination.
const sourceAdditions: readonly Addition[] = [aws];
const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=300",
  "X-Content-Type-Options": "nosniff",
};
const unavailable = () => new Response('{"error":"Catalog unavailable"}', {
  status: 502, headers: { ...headers, "Cache-Control": "no-store" },
});

function configuredAdditions(
  ready: ConnectorAvailability,
  zendeskSubdomain?: string,
): readonly FeedAddition[] {
  const additions = [atlassianAddition(ready.atlassian === true)];
  const zendesk = ready.zendesk && zendeskSubdomain !== undefined && isZendeskSubdomain(zendeskSubdomain)
    ? zendeskAddition(zendeskSubdomain)
    : unavailableZendeskAddition();
  return [...additions, ...sourceAdditions, zendesk];
}

/** A read-only feed. Never forward cookies, authorization or query parameters to its publisher. */
export async function handleCatalog(
  request: Request,
  fetcher: typeof fetch = fetch,
  ready: ConnectorAvailability = { google: false, github: false },
  zendeskSubdomain?: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  const additions = configuredAdditions(ready, zendeskSubdomain);
  const path = new URL(request.url).pathname;
  const relative = path.startsWith(catalog.path) ? path.slice(catalog.path.length) : "";
  if (relative !== "index.json" && !/^apps\/[a-zA-Z0-9_-]+\.json$/.test(relative))
    return new Response(null, { status: 404 });
  if (relative === "apps/slack.json")
    return new Response(request.method === "HEAD" ? null : JSON.stringify(slackSource), { headers });
  const added = additions.find(item => relative === `apps/${encodeURIComponent(item.entry.id)}.json`);
  if (added) {
    if (!added.source)
      return new Response(request.method === "HEAD" ? null : JSON.stringify({ error: `${added.entry.name} is not set up yet.` }), {
        status: 503, headers: { ...headers, "Cache-Control": "no-store" },
      });
    return new Response(request.method === "HEAD" ? null : JSON.stringify(added.source), { headers });
  }
  try {
    const response = await fetcher(new URL(relative, catalog.official), {
      redirect: "manual", signal: AbortSignal.timeout(15_000),
      headers: { Accept: "application/json" },
    });
    if (response.status === 404) return new Response(null, { status: 404, headers });
    if (!response.ok || response.status !== 200) return unavailable();
    const body = relative === "index.json"
      ? JSON.stringify(mergeFeed(withSlackUserAuth(await response.json() as Feed), additions, ready))
      : await response.text();
    return new Response(request.method === "HEAD" ? null : body, { headers });
  } catch {
    return unavailable();
  }
}

export default {
  fetch: (
    request: Request,
    env: {
      GOOGLE_CONNECTOR_READY?: string;
      GITHUB_CONNECTOR_READY?: string;
      ATLASSIAN_CONNECTOR_READY?: string;
      ZOHO_CONNECTOR_READY?: string;
      SLACK_CONNECTOR_READY?: string;
      ZENDESK_CONNECTOR_READY?: string;
      GITLAB_CONNECTOR_READY?: string;
      MIRO_CONNECTOR_READY?: string;
      EXECUTOR_ZENDESK_SUBDOMAIN?: string;
    },
  ) =>
    handleCatalog(
      request,
      fetch,
      {
        google: env.GOOGLE_CONNECTOR_READY === "true",
        github: env.GITHUB_CONNECTOR_READY === "true",
        atlassian: env.ATLASSIAN_CONNECTOR_READY === "true",
        zoho: env.ZOHO_CONNECTOR_READY === "true",
        slack: env.SLACK_CONNECTOR_READY === "true",
        zendesk: env.ZENDESK_CONNECTOR_READY === "true",
        gitlab: env.GITLAB_CONNECTOR_READY === "true",
        miro: env.MIRO_CONNECTOR_READY === "true",
      },
      env.EXECUTOR_ZENDESK_SUBDOMAIN,
    ),
};
