import { gitlabMcp } from "./gitlab-mcp/index.ts";
import { withServiceIdentities } from "./service-identities.ts";
import { mergeFeed, type Addition, type FeedAddition, type Feed } from "./feed.ts";
import { oauthReviews, withOAuthDeferrals } from "./oauth-policy.ts";
import oauthReviewData from "./oauth-reviews.json" with { type: "json" };
import { catalog } from "./settings.ts";
import { onServedFramework } from "./framework.ts";
import { atlassianAddition } from "./atlassian/index.ts";
import { gitlabSource, withGitLabInstances } from "./gitlab.ts";
import { slackSource, withSlackUserAuth } from "./slack.ts";
import { miroSource, withMiroCapabilities } from "./miro.ts";
import { elevenlabsSource, withElevenLabsSignIn } from "./elevenlabs.ts";
import { vercelSource, withVercelSignIn } from "./vercel.ts";
import { notionSource } from "./notion.ts";
import { recipeAdditions } from "./recipes/index.ts";
import { providerApps } from "./provider-apps/index.ts";
import { aws } from "./aws/index.ts";
import { zendeskAddition } from "./zendesk/source.ts";
import { zendeskMarketplaceMetadata, type ZendeskMarketplaceMetadata } from "./zendesk/metadata.ts";
import { googleMapsAddition } from "./google-maps/index.ts";
import { workosSource, withWorkOSSignIn } from "./workos.ts";

// AWS source stays in the catalog until maintainers identify a maintained destination.
const sourceAdditions: readonly Addition[] = [aws, gitlabMcp, ...providerApps];
const reviewedOAuth = oauthReviews(oauthReviewData);
const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=300",
  "X-Content-Type-Options": "nosniff",
};
const unavailable = () =>
  new Response('{"error":"Catalog unavailable"}', {
    status: 502,
    headers: { ...headers, "Cache-Control": "no-store" },
  });

function configuredAdditions(
  origin: string,
  metadata?: ZendeskMarketplaceMetadata,
): readonly FeedAddition[] {
  const additions = [atlassianAddition(origin)];
  const zendesk = zendeskAddition(metadata);
  return [
    ...additions,
    ...sourceAdditions,
    ...recipeAdditions(origin),
    googleMapsAddition(origin),
    zendesk,
  ];
}

/** A read-only feed. Never forward cookies, authorization or query parameters to its publisher. */
export async function handleCatalog(
  request: Request,
  fetcher: typeof fetch = fetch,
  metadata?: ZendeskMarketplaceMetadata,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  const additions = configuredAdditions(new URL(request.url).origin, metadata);
  const path = new URL(request.url).pathname;
  const relative = path.startsWith(catalog.path) ? path.slice(catalog.path.length) : "";
  if (relative !== "index.json" && !/^apps\/[a-zA-Z0-9_-]+\.json$/.test(relative))
    return new Response(null, { status: 404 });
  if (relative === "apps/slack.json")
    return new Response(
      request.method === "HEAD" ? null : onServedFramework(JSON.stringify(slackSource)),
      { headers },
    );
  if (relative === "apps/gitlab.json")
    return new Response(
      request.method === "HEAD" ? null : onServedFramework(JSON.stringify(gitlabSource)),
      { headers },
    );
  if (relative === "apps/miro.json")
    return new Response(
      request.method === "HEAD" ? null : onServedFramework(JSON.stringify(miroSource)),
      { headers },
    );
  if (relative === "apps/elevenlabs.json")
    return new Response(
      request.method === "HEAD" ? null : onServedFramework(JSON.stringify(elevenlabsSource)),
      { headers },
    );
  if (relative === "apps/vercel.json")
    return new Response(
      request.method === "HEAD" ? null : onServedFramework(JSON.stringify(vercelSource)),
      { headers },
    );
  if (relative === "apps/notion.json")
    return new Response(
      request.method === "HEAD" ? null : onServedFramework(JSON.stringify(notionSource)),
      { headers },
    );
  if (relative === "apps/workos.json")
    return new Response(
      request.method === "HEAD" ? null : onServedFramework(JSON.stringify(workosSource)),
      { headers },
    );
  const added = additions.find(
    (item) => relative === `apps/${encodeURIComponent(item.entry.id)}.json`,
  );
  if (added) {
    if (!added.source)
      return new Response(
        request.method === "HEAD"
          ? null
          : JSON.stringify({ error: `${added.entry.name} is not set up yet.` }),
        {
          status: 503,
          headers: { ...headers, "Cache-Control": "no-store" },
        },
      );
    return new Response(
      request.method === "HEAD" ? null : onServedFramework(JSON.stringify(added.source)),
      { headers },
    );
  }
  try {
    const response = await fetcher(new URL(relative, catalog.official), {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: "application/json" },
    });
    if (response.status === 404) return new Response(null, { status: 404, headers });
    if (!response.ok || response.status !== 200) return unavailable();
    let body: string;
    if (relative === "index.json") {
      const upstream = withWorkOSSignIn(
        withElevenLabsSignIn(
          withVercelSignIn(
            withMiroCapabilities(
              withSlackUserAuth(withGitLabInstances((await response.json()) as Feed)),
            ),
          ),
        ),
      );
      const feed = {
        ...upstream,
        apps: upstream.apps.filter(
          (entry) => !(entry.id === "google-maps" && entry.package === "@executor.sh/google-maps"),
        ),
      };
      body = JSON.stringify(
        withOAuthDeferrals(withServiceIdentities(mergeFeed(feed, additions)), reviewedOAuth),
      );
    } else {
      body = onServedFramework(await response.text());
    }

    return new Response(request.method === "HEAD" ? null : body, { headers });
  } catch {
    return unavailable();
  }
}

export default {
  fetch: (
    request: Request,
    env: { ZENDESK_MARKETPLACE_ORGANIZATION_ID?: string; ZENDESK_MARKETPLACE_APP_ID?: string },
  ) =>
    handleCatalog(
      request,
      fetch,
      zendeskMarketplaceMetadata(
        env.ZENDESK_MARKETPLACE_ORGANIZATION_ID,
        env.ZENDESK_MARKETPLACE_APP_ID,
      ),
    ),
};
