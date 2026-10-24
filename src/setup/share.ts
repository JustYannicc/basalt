// The share page's host: the pool owner invites people and removes them, with the tools service's
// own organization invitations and app sharing. A pool's organization is only its sharing
// boundary, so its members are the pool's members. Invitations are always `member`; removal
// revokes the person's computer keys on the pool before it commits (the tools service's hook).
import { body, failure, json, native, pool, record, SetupError, text, user, writeBody, type SetupEnv } from "./session.ts";

interface Owned { person: string; pool: string; organization: string; name: string }

async function owned(request: Request, env: SetupEnv, intent: unknown): Promise<Owned> {
  if (!text(intent)) throw new SetupError(400, "Open sharing again from your pool.");
  const person = await user(request, env);
  const selection = await body(await pool(request, env, "validate", { user: person, intent }).catch((error: unknown) => {
    // Intents are short-lived; the page can't renew one, only the pool can.
    if (error instanceof SetupError && error.status === 401)
      throw new SetupError(401, "This sharing session expired. Open Share again from your pool.");
    throw error;
  }));
  if (!text(selection.pool, 512) || !text(selection.organization, 512))
    throw new SetupError(502, "Could not open sharing. Try again.");
  if (selection.owner !== person) throw new SetupError(403, "Only the pool's owner can share it.");
  return { person, pool: selection.pool, organization: selection.organization, name: typeof selection.name === "string" ? selection.name : "" };
}

/** Better Auth's own error copy is safe to show; anything else gets ours. */
async function nativeResult(response: Response, fallback: string): Promise<Record<string, unknown> | unknown[]> {
  const result: unknown = await response.json().catch(() => undefined);
  if (response.ok) return Array.isArray(result) ? result : record(result);
  const message = record(result).message;
  throw new SetupError(response.status >= 500 ? 502 : response.status === 401 ? 401 : 409,
    text(message, 300) ? message : fallback);
}

const accessPath = (owned: Owned) =>
  `/api/organizations/${encodeURIComponent(owned.organization)}/apps/${encodeURIComponent(owned.pool)}/access`;

async function audience(request: Request, env: SetupEnv, pool: Owned) {
  const access = record(await nativeResult(await native(request, env, accessPath(pool)), "Could not read who can use this pool."));
  return { kind: text(record(access.audience).kind) ? record(access.audience).kind as string : "private", revision: access.revision };
}

/**
 * A private pool becomes usable by everyone in its organization, the way a doc works for everyone
 * it's shared with. Group sharing the owner chose in the dashboard is left as it is.
 */
async function shareWithEveryone(request: Request, env: SetupEnv, pool: Owned): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await audience(request, env, pool);
    if (current.kind !== "private") return;
    const response = await native(request, env, accessPath(pool), { audience: { kind: "everyone" }, revision: current.revision }, "PATCH");
    if (response.ok) { await response.body?.cancel(); return; }
    // A concurrent edit changed the revision; read it again once.
    if (response.status !== 409 || attempt === 1) await nativeResult(response, "Could not share this pool. Try again.");
    else await response.body?.cancel();
  }
}

function inviteLink(request: Request, id: string) {
  return new URL(`/invite?invitation=${encodeURIComponent(id)}`, new URL(request.url).origin).toString();
}
function invitation(request: Request, value: unknown) {
  const input = record(value);
  if (!text(input.id, 512) || !text(input.email, 320)) throw new SetupError(502, "Could not read invitations.");
  return { id: input.id, email: input.email, expiresAt: text(input.expiresAt) ? input.expiresAt : null, link: inviteLink(request, input.id) };
}

async function view(request: Request, env: SetupEnv, pool: Owned) {
  const query = `organizationId=${encodeURIComponent(pool.organization)}`;
  const [members, invitations, current] = await Promise.all([
    nativeResult(await native(request, env, `organization/list-members?${query}`), "Could not read this pool's members."),
    nativeResult(await native(request, env, `organization/list-invitations?${query}`), "Could not read invitations."),
    audience(request, env, pool),
  ]);
  const rows = Array.isArray(members) ? members : record(members).members;
  if (!Array.isArray(rows) || !Array.isArray(invitations)) throw new SetupError(502, "Could not read this pool's members.");
  return {
    pool: { id: pool.pool, name: pool.name },
    audience: current.kind,
    members: rows.map((row) => {
      const member = record(row);
      const person = record(member.user);
      if (!text(member.id, 512) || !text(member.userId ?? person.id, 512)) throw new SetupError(502, "Could not read this pool's members.");
      return {
        id: member.id, name: typeof person.name === "string" ? person.name : "", email: typeof person.email === "string" ? person.email : "",
        owner: member.role === "owner", you: (member.userId ?? person.id) === pool.person,
      };
    }),
    invitations: invitations.map(record).filter((row) => row.status === "pending").map((row) => invitation(request, row)),
  };
}

const email = (value: unknown): value is string =>
  text(value, 320) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

/** Only /share/v1/* belongs to this adapter. */
export async function handleShare(request: Request, env: SetupEnv): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (request.headers.has("authorization")) throw new SetupError(403, "Sharing requires a browser session.");
    const invitationId = /^\/share\/v1\/invitations\/([A-Za-z0-9_-]{1,512})$/.exec(url.pathname)?.[1];
    const memberId = /^\/share\/v1\/members\/([A-Za-z0-9_-]{1,512})$/.exec(url.pathname)?.[1];
    const route = url.pathname === "/share/v1/pool" ? "GET" : url.pathname === "/share/v1/invitations" ? "POST"
      : invitationId || memberId ? "DELETE" : null;
    if (!route) throw new SetupError(404, "Sharing route not found.");
    if (request.method !== route) return json({ error: "Method not allowed." }, 405, { Allow: route });
    if (route === "GET") return json(await view(request, env, await owned(request, env, url.searchParams.get("intent"))));
    const input = await writeBody(request);
    if (Object.keys(input).some((key) => !["intent", "email"].includes(key)))
      throw new SetupError(400, "Invalid sharing request.");
    const target = await owned(request, env, input.intent);
    if (route === "POST") {
      const address = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
      if (!email(address)) throw new SetupError(400, "Enter an email address.");
      // Share first: inviting someone who then can't use the pool would only confuse them.
      await shareWithEveryone(request, env, target);
      const created = await nativeResult(await native(request, env, "organization/invite-member", {
        email: address, role: "member", organizationId: target.organization, resend: true,
      }), "Could not invite them. Try again.");
      return json({ invitation: invitation(request, created) });
    }
    if (invitationId) {
      await nativeResult(await native(request, env, "organization/cancel-invitation", { invitationId }), "Could not cancel the invitation. Try again.");
      return json({ success: true });
    }
    const current = await view(request, env, target);
    const member = current.members.find((row) => row.id === memberId);
    if (!member) throw new SetupError(404, "They aren't a member of this pool anymore.");
    if (member.owner) throw new SetupError(409, "The pool's owner can't be removed.");
    // The tools service revokes their computer keys on this pool before the removal commits.
    await nativeResult(await native(request, env, "organization/remove-member", {
      memberIdOrEmail: memberId, organizationId: target.organization,
    }), "Could not remove them. Their computers still work. Try again.");
    return json({ success: true });
  } catch (error) {
    return failure(error);
  }
}
