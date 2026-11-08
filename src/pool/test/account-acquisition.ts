import assert from "node:assert/strict";
import { HomeAccountAcquisitions } from "../account-acquisition.ts";
import {
  accountAcquisitionPath,
  accountAcquisitionPrefix,
} from "../account-acquisition-contract.ts";
import { HomeClient } from "../control.ts";
import { object } from "../json.ts";
import { signEnvelope } from "../token.ts";

const key = "22".repeat(32);
export const owner = "organization:fixture";

export function fixture(
  existing: readonly string[] = [],
  provider = "gemini-cli",
  startFields: Record<string, unknown> = {},
) {
  const retained = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage = {
    async get<T>(name: string): Promise<T | undefined> {
      return structuredClone(retained.get(name)) as T | undefined;
    },
    async put(name: string, value: unknown) {
      retained.set(name, structuredClone(value));
    },
    async getAlarm() {
      return alarm;
    },
    async setAlarm(at: number) {
      alarm = at;
    },
  };
  const calls: { path: string; method: string; body?: unknown }[] = [];
  const acknowledgements: {
    pool: string;
    references: readonly string[];
    actor: string;
    operation: string;
  }[] = [];
  const credentials = new Set(existing);
  const members = new Set<string>();
  let status: Record<string, unknown> = { status: "wait" };
  let failStart = false;
  let statusError: Error | undefined;
  let callbackStatus: number | undefined;
  const home = new HomeClient(async (path, init) => {
    const method = init?.method ?? "GET";
    calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const url = new URL(path, "https://fixture.invalid");
    if (url.pathname.endsWith("/oauth/auth-url")) {
      if (failStart) throw new Error("Lost response after send");
      return Response.json({
        state: "home-state",
        url:
          provider === "xai"
            ? "https://accounts.x.ai/oauth2/consent?redirect_uri=http%3A%2F%2F127.0.0.1%3A56121%2Fcallback"
            : "https://provider.invalid/device",
        user_code: "CODE",
        ...startFields,
      });
    }
    if (url.pathname.endsWith("/oauth/status")) {
      if (statusError) throw statusError;
      return Response.json(status);
    }
    if (url.pathname.endsWith("/oauth/callback")) {
      if (callbackStatus !== undefined)
        return Response.json({ status: "error" }, { status: callbackStatus });
      const submitted = JSON.parse(String(init?.body));
      const code = submitted.code ?? new URL(submitted.redirect_url).searchParams.get("code");
      return Response.json({ status: code ? "ok" : "error" }, { status: code ? 200 : 400 });
    }
    if (url.pathname.endsWith("/oauth/session")) return Response.json({ cancelled: true });
    if (url.pathname.endsWith("/credentials")) {
      if (method === "DELETE") {
        credentials.delete(url.searchParams.get("id") ?? "");
        return Response.json(null);
      }
      return Response.json({
        files: [...credentials].map((id) => ({ id, provider })),
      });
    }
    if (url.pathname.endsWith("/channel-groups"))
      return Response.json({ channel_groups: [{ id: 1, channel_name: "signalbox-pool-pool" }] });
    if (url.pathname.endsWith("/channel-group-details"))
      return Response.json({
        channel_group_details: [...members].map((auth_id, index) => ({
          id: index + 1,
          auth_id,
          channel_group_id: 1,
        })),
      });
    if (url.pathname.startsWith("/v8/management/channel-group-details/") && method === "DELETE") {
      members.clear();
      return Response.json(null);
    }
    throw new Error(`Unexpected Home request: ${method} ${url.pathname}`);
  });
  const markers = new Set<string>();
  const excluded = new Set<string>();
  const attribution = {
    async removalAcknowledged(value: (typeof acknowledgements)[number]) {
      acknowledgements.push(value);
    },
    async begin() {
      const id = crypto.randomUUID();
      markers.add(id);
      return id;
    },
    async settle(id: string, ids: readonly string[]) {
      markers.delete(id);
      for (const ref of ids) excluded.add(ref);
    },
  };
  const make = () => new HomeAccountAcquisitions(storage, home, key, attribution);
  let controller = make();
  return {
    calls,
    acknowledgements,
    credentials,
    members,
    markers,
    excluded,
    failCallback(status?: number) {
      callbackStatus = status;
    },
    failStatus(error?: Error) {
      statusError = error;
    },
    restart() {
      controller = make();
    },
    complete(ids: readonly string[]) {
      for (const id of ids) credentials.add(id);
      status = { status: "ok", auth_ids: ids };
    },
    loseStart() {
      failStart = true;
    },
    async send(
      action: string,
      input: Record<string, unknown> = {},
      principal = owner,
      operation = "connect:start",
    ) {
      const at = Date.now();
      const envelope = await signEnvelope(key, accountAcquisitionPrefix, {
        owner: principal,
        provider,
        operation,
        action,
        at,
        expiresAt: at + 30_000,
        ...input,
      });
      return controller.handle(
        new Request(`https://pool.invalid${accountAcquisitionPath}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ envelope }),
        }),
      );
    },
    unsigned: () =>
      controller.handle(
        new Request(`https://pool.invalid${accountAcquisitionPath}`, {
          method: "POST",
          body: "{}",
        }),
      ),
  };
}

export async function body(response: Response) {
  assert.equal(response.status, 200);
  const value: unknown = await response.json();
  assert.ok(object(value));
  return value;
}
