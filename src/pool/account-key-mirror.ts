import { mirrorHomeConfig } from "./account-config-mirror.ts";
import type { HomeClient } from "./control.ts";
import { enableNewCodexWebSockets } from "./codex-websockets.ts";
import { failureResponse, json, object, readBody, unavailable, type Json } from "./json.ts";
import {
  pluginProviders,
  resolveMs,
  within,
  writeMs,
  type MirrorRouteHint,
  type RouteAssignments,
} from "./route-assignments.ts";
import { routePeerAddress } from "./route-refusal.ts";
import { openEnvelope } from "./token.ts";

export const accountMirrorPath = "/pool/v1/account-mirrors";
export const accountMirrorPrefix = "sbam1";
// Covers 2,000 model IDs of 256 UTF-16 units, duplicated as name/alias and base64 encoded.
export const accountMirrorMaxBytes = 8_388_608;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The host's pool-free routing answer; malformed fields are ignored, never trusted. */
function routeHint(value: Json): MirrorRouteHint {
  const route = value.route;
  return {
    ...(typeof value.hasRules === "boolean" ? { hasRules: value.hasRules } : {}),
    ...(route === null
      ? { route: null }
      : object(route) && typeof route.routeId === "string" && typeof route.owner === "string"
        ? { route: { routeId: route.routeId, owner: route.owner } }
        : {}),
  };
}

/** Only a fresh assertion from the trusted host can copy account fields into Home. */
export async function handleAccountKeyMirror(
  request: Request,
  input: {
    readonly home: HomeClient;
    readonly signingKey: string;
    readonly previousSigningKey?: string;
    readonly now?: () => number;
    /** Resolves each upsert's route before Home sees the credential. */
    readonly routes?: RouteAssignments;
  },
): Promise<Response> {
  try {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const raw = await readBody(request, accountMirrorMaxBytes);
    if (raw === undefined) return new Response(null, { status: 413 });
    const body: unknown = JSON.parse(new TextDecoder().decode(raw));
    const value =
      object(body) && typeof body.envelope === "string"
        ? await openEnvelope(
            input.signingKey,
            accountMirrorPrefix,
            body.envelope,
            input.previousSigningKey,
          )
        : undefined;
    const now = input.now?.() ?? Date.now();
    if (
      !object(value) ||
      typeof value.at !== "number" ||
      !Number.isFinite(value.at) ||
      value.at > now ||
      typeof value.expiresAt !== "number" ||
      !Number.isFinite(value.expiresAt) ||
      value.expiresAt <= now ||
      value.expiresAt > now + 30_000 ||
      typeof value.reference !== "string" ||
      !uuid.test(value.reference) ||
      !["upsert", "remove"].includes(String(value.action))
    )
      return new Response(null, { status: 401 });
    const reference = value.reference;
    const action = String(value.action);
    // The route decision and the save are one step: a pass can't land between them.
    const mirrorOne = async (): Promise<Response> => {
      // A mirror its host has given up on (its envelope expired while it waited behind a pass)
      // decides and writes nothing; the host sends a fresh one.
      if ((input.now?.() ?? Date.now()) >= Number(value.expiresAt)) return unavailable();
      const signal = within(writeMs, request.signal);
      const proxy =
        action === "upsert"
          ? await input.routes?.proxyFor(
              reference,
              routeHint(value),
              within(resolveMs, request.signal),
            )
          : undefined;
      if (object(value.credential) && value.credential.type === "config") {
        await mirrorHomeConfig(input.home, reference, action, value.credential, signal, proxy);
        if (action === "upsert") await input.routes?.reassert(reference, signal);
      } else if (action === "remove") {
        const response = await input.home.response(
          `/credentials?id=${encodeURIComponent(reference)}`,
          { method: "DELETE", signal: signal },
        );
        if (!response.ok && response.status !== 404) return unavailable();
      } else {
        if (
          !object(value.credential) ||
          typeof value.credential.type !== "string" ||
          !value.credential.type ||
          "uuid" in value.credential ||
          "id" in value.credential
        )
          return new Response(null, { status: 400 });
        // A plugin makes its own calls without the credential's proxy, so a routed one is saved
        // disabled: Home never uses or refreshes it, and nothing goes direct (change 37/39).
        const refused =
          pluginProviders.has(value.credential.type) && proxy?.includes(routePeerAddress) === true;
        // The pool's refusal is recorded before Home holds the credential, so it is never lost.
        if (refused) await input.routes?.markRefused(reference, true);
        const saved = await input.home.data("/credentials", {
          method: "POST",
          signal: signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...value.credential,
            uuid: reference,
            ...(proxy === undefined ? {} : { proxy_url: proxy }),
            ...(refused ? { disabled: true } : {}),
          }),
        });
        if (saved.name !== `${reference}.json`) return unavailable();
        if (!refused && (await input.routes?.refused(reference)))
          await input.routes?.markRefused(reference, false);
        // What is on record wins over this save: a routed or held credential never stays direct.
        await input.routes?.reassert(reference, signal);
        await enableNewCodexWebSockets(input.home, [reference], value.credential.type, signal);
      }
      if (action === "remove") await input.routes?.forget(reference);
      return json(null);
    };
    return await (input.routes ? input.routes.serial(mirrorOne) : mirrorOne());
  } catch (error) {
    return failureResponse(error);
  }
}
