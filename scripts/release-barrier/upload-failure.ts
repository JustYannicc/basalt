import { Cause, Effect } from "effect";
import { BarrierRefusal } from "./refusal.ts";
import { safeProviderFailure } from "./operation-failure.ts";

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

/** Classify locally; provider text may contain source, binding values or credentials. */
function messageClass(error: unknown) {
  const entries = field(error, "errors");
  const messages = [
    field(error, "message"),
    ...(Array.isArray(entries) ? entries.slice(0, 8).map((entry) => field(entry, "message")) : []),
  ]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.slice(0, 4096).toLowerCase());
  if (messages.some((value) => /no such module|cannot resolve module|module not found/.test(value)))
    return "module-resolution";
  if (messages.some((value) => /script startup exceeded memory limit/.test(value)))
    return "startup-memory";
  if (messages.some((value) => /startup.*(?:cpu|time)|script startup exceeded/.test(value)))
    return "startup-limit";
  if (
    messages.some((value) =>
      /invalid binding|binding.*not found|binding.*configuration/.test(value),
    )
  )
    return "binding-configuration";
  return "unclassified";
}

export function uploadResponseDiagnostic(status: number, body: unknown) {
  return { status, codes: safeProviderFailure(body).codes, messageClass: messageClass(body) };
}
type ResponseDiagnostic = ReturnType<typeof uploadResponseDiagnostic>;

export function uploadFailure(error: unknown, worker: string, response?: ResponseDiagnostic) {
  if (error instanceof BarrierRefusal) return error;
  const provider = safeProviderFailure(error);
  const tag = field(error, "_tag") ?? field(error, "name");
  const type = tag === "TimeoutError" || tag === "AbortError" ? tag : provider.type;
  const classification =
    response?.messageClass !== undefined && response.messageClass !== "unclassified"
      ? response.messageClass
      : messageClass(error);
  const codes = response?.codes?.length ? response.codes : provider.codes;
  return new BarrierRefusal("upload-rejected-or-unconfirmed", worker, {
    fqn: worker,
    type: "Cloudflare.Worker",
    changed: [
      { path: "$upload.type", old: null, new: type },
      { path: "$upload.reason", old: null, new: provider.reason ?? null },
      { path: "$upload.status", old: null, new: response?.status ?? provider.status ?? null },
      { path: "$upload.codes", old: null, new: codes?.join(",") ?? null },
      { path: "$upload.messageClass", old: null, new: classification },
    ],
    why: [
      "No confirmed version was returned. Upload intent remains pending; no activation was attempted.",
    ],
  });
}

export const withUploadFailure =
  (worker: string, response: () => ResponseDiagnostic | undefined = () => undefined) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchCause((cause): Effect.Effect<never, E | BarrierRefusal> =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.fail(uploadFailure(Cause.squash(cause), worker, response())),
      ),
    );
