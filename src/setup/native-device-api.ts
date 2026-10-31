import { Schema } from "effect";

const Text = Schema.NonEmptyString.check(Schema.makeFilter((value) => value.length <= 8192));
const Session = Schema.Struct({ user: Schema.Struct({
  id: Text, email: Schema.String, name: Schema.optionalKey(Schema.String), emailVerified: Schema.Boolean,
}) });
const Pending = Schema.Struct({ clientId: Text, resource: Text, scopes: Schema.Array(Schema.String) });
const Client = Schema.Struct({ client_name: Schema.optionalKey(Schema.String) });
const Context = Schema.Struct({ intent: Text });
const Choices = Schema.Struct({ pools: Schema.Array(Schema.Struct({
  id: Text, name: Schema.String, mine: Schema.Boolean,
})) });
const Decision = Schema.Struct({ status: Schema.Literals(["approved", "denied"]) });

export class DeviceApprovalError extends Error {
  readonly kind: "signed-out" | "unavailable" | "request" | "uncertain";
  constructor(kind: DeviceApprovalError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

/** Matches the existing device-code alphabet and separator handling. */
export function deviceCode(input: string): string | undefined {
  const code = input.toUpperCase().replace(/[\s-]/gu, "");
  return /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/u.test(code) ? `${code.slice(0, 4)}-${code.slice(4)}` : undefined;
}

type AppPath = `api/auth/${string}` | `setup/v1/${string}`;
async function read(path: AppPath, signal: AbortSignal, input?: { code: string; accept: boolean; headers?: HeadersInit }) {
  let response: Response;
  try {
    response = await fetch(`/${path}`, {
      method: input ? "POST" : "GET", credentials: "same-origin", cache: "no-store", redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      headers: { Accept: "application/json", ...(input ? { "Content-Type": "application/json", ...input.headers } : {}) },
      ...(input ? { body: JSON.stringify({ user_code: input.code, accept: input.accept }) } : {}),
    });
  } catch {
    throw new DeviceApprovalError(input ? "uncertain" : "unavailable", input
      ? "The decision could not be confirmed. Return to your device to check its status before trying again."
      : "Could not reach Signalbox. Check your connection and try again.");
  }
  if (response.status === 401) throw new DeviceApprovalError("signed-out", "Sign in to review this device.");
  if (!response.ok) {
    if (input && response.status >= 500) throw new DeviceApprovalError("uncertain", "The decision could not be confirmed. Return to your device to check its status.");
    const request = path.startsWith("api/auth/device/");
    throw new DeviceApprovalError(request ? "request" : "unavailable", request
      ? response.status === 404 ? "This code is unknown or expired. Start sign-in again on your device."
        : response.status === 409 ? "This request was already decided. Return to your device to check its status."
        : "This request could not be completed. Reopen sign-in on your device."
      : "Could not load your pools. Open Connections to finish setting up your pool, then try again.");
  }
  try { return await response.json() as unknown; }
  catch { throw new DeviceApprovalError(input ? "uncertain" : "unavailable", input
    ? "The decision could not be confirmed. Return to your device to check its status."
    : "Signalbox returned an unreadable response. Try again."); }
}

export async function readDeviceRequest(code: string, signal: AbortSignal) {
  const raw = await read("api/auth/get-session?disableCookieCache=true&disableRefresh=true", signal);
  if (raw === null) throw new DeviceApprovalError("signed-out", "Sign in to review this device.");
  const session = Schema.decodeUnknownSync(Session)(raw);
  if (!session.user.emailVerified) throw new DeviceApprovalError("request", "Verify your email, then reopen this device request.");
  const pending = Schema.decodeUnknownSync(Pending)(await read(`api/auth/device/request?user_code=${encodeURIComponent(code)}`, signal));
  if (pending.resource !== `${location.origin}/native` || !pending.scopes.includes("native") ||
    pending.scopes.some((scope) => scope !== "native" && scope !== "offline_access"))
    throw new DeviceApprovalError("request", "This is not a native device request for this site. Open the link shown on your device.");
  const client = Schema.decodeUnknownSync(Client)(await read(`api/auth/oauth2/public-client?client_id=${encodeURIComponent(pending.clientId)}`, signal));
  return { account: session.user, clientId: pending.clientId, clientName: client.client_name?.trim() || "This device" };
}

export type DeviceRequest = Awaited<ReturnType<typeof readDeviceRequest>>;
export async function readDevicePools(signal: AbortSignal) {
  const { intent } = Schema.decodeUnknownSync(Context)(await read("setup/v1/context", signal));
  const { pools } = Schema.decodeUnknownSync(Choices)(await read(`setup/v1/computers?intent=${encodeURIComponent(intent)}`, signal));
  if (!pools.length) throw new DeviceApprovalError("unavailable", "No pools are available. Open Connections to set up your pool, then try again.");
  return { intent, pools };
}
export type DevicePools = Awaited<ReturnType<typeof readDevicePools>>;
export interface DeviceSelection { name: string; pool: string; models: boolean; tools: boolean }

export async function decideDevice(code: string, accept: boolean, signal: AbortSignal, selection?: {
  intent: string; name: string; pool: string; models: boolean; tools: boolean;
}) {
  const value = await read("api/auth/device/decide", signal, { code, accept, ...(selection ? { headers: {
    "x-basalt-native-intent": selection.intent, "x-basalt-native-name": selection.name,
    "x-basalt-native-pool": selection.pool, "x-basalt-native-models": String(selection.models),
    "x-basalt-native-tools": String(selection.tools),
  } } : {}) });
  let result: typeof Decision.Type;
  try { result = Schema.decodeUnknownSync(Decision)(value); }
  catch { throw new DeviceApprovalError("uncertain", "The decision could not be confirmed. Return to your device to check its status."); }
  if (result.status !== (accept ? "approved" : "denied"))
    throw new DeviceApprovalError("uncertain", "The decision changed elsewhere. Return to your device to check its status.");
  return result.status;
}

/** Recheck the displayed identity and selection without replaying an unconfirmed decision. */
export async function reviewDeviceDecision(code: string, original: DeviceRequest, signal: AbortSignal, selection?: DeviceSelection) {
  const current = await readDeviceRequest(code, signal);
  if (current.account.id !== original.account.id || current.clientId !== original.clientId)
    return { kind: "review", request: current, message: "Your account or device request changed. Review it again before deciding." } as const;
  if (selection) {
    const available = await readDevicePools(signal);
    if (!available.pools.some((entry) => entry.id === selection.pool))
      return { kind: "review", request: current, available, message: "That pool is no longer available. Choose a pool and review access again." } as const;
    if (!selection.name.trim() || selection.name.trim().length > 60 || !/^[\x20-\x7e]+$/u.test(selection.name.trim()) || (!selection.models && !selection.tools))
      throw new DeviceApprovalError("request", "Choose a device name and at least one kind of access.");
    const status = await decideDevice(code, true, signal, { ...selection, name: selection.name.trim(), intent: available.intent });
    return { kind: "decided", status } as const;
  }
  const status = await decideDevice(code, false, signal);
  return { kind: "decided", status } as const;
}

export const deviceProblem = (error: unknown) => error instanceof DeviceApprovalError ? error.message
  : "This device request could not be read. Reopen sign-in on your device.";
