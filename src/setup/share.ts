import { readIntent } from "../pool/setup-links.ts";
import { body, failure, json, native, SetupError, text, user, type SetupEnv } from "./session.ts";

/** Old bookmarks resolve to native settings. This adapter never writes sharing or membership. */
export async function handleShare(request: Request, env: SetupEnv): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (url.pathname !== "/share/v1/destination")
      return json({ error: "Pool sharing moved to the app's Settings. Open Share from your pool." }, 410);
    if (request.method !== "GET") return json({ error: "Method not allowed." }, 405, { Allow: "GET" });
    if (request.headers.has("authorization")) throw new SetupError(403, "Sharing requires a browser session.");
    const person = await user(request, env);
    const token = url.searchParams.get("intent");
    if (!text(token)) throw new SetupError(401, "Open Share again from your pool.");
    const intent = await readIntent(env.POOL_APP_SIGNING_KEY, token, person, Date.now())
      .catch(() => { throw new SetupError(401, "This sharing session expired. Open Share again from your pool."); });
    const access = await native(request, env,
      `/api/organizations/${encodeURIComponent(intent.organization)}/apps/${encodeURIComponent(intent.pool)}/access`);
    if (!access.ok)
      throw new SetupError(access.status === 401 ? 401 : access.status >= 500 ? 502 : 403,
        "Sharing settings could not be opened. Try again.");
    if ((await body(access)).canManage !== true)
      throw new SetupError(403, "Only a pool manager can open sharing settings.");
    return json({ href: `/org/${encodeURIComponent(intent.organization)}/apps/${encodeURIComponent(intent.pool)}?view=settings` });
  } catch (error) { return failure(error); }
}
