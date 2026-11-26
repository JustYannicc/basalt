import { inheritModelLifetime } from "./model-lifetime.worker.ts";
import { retainEndpointRequestId } from "./runtime-route-diagnostic.ts";
import type { SlotIdentity } from "./runtime-slots/contract.ts";

/**
 * Which runtime a call was placed on. The slot router marks its answers and the fleet controller
 * re-marks a cell's; a refusal built from a runtime's failure carries that runtime too. The pool's
 * forward path reads it into the request event and strips it, so no client ever receives it; only
 * the pool's own hops that read a resumed answer's body see it.
 */
export const runtimePlacementHeader = "X-Basalt-Runtime-Placement";

/** `root` serves the pool itself, `cell` is an extra fleet runtime, `candidate` a release probe. */
export type RuntimeKind = "root" | "cell" | "candidate";
const kinds: readonly RuntimeKind[] = ["root", "cell", "candidate"];
const isKind = (value: string): value is RuntimeKind => kinds.some((kind) => kind === value);

export interface RuntimePlacement {
  /** `unknown` only where the pool object failed after it may have sent the call on. */
  readonly runtime: RuntimeKind | "unplaced" | "unknown";
  /** `legacy` for the pool object's own container, otherwise the runtime slot's id. */
  readonly slot: string;
  readonly imageInput: string;
  readonly boot: string;
}

/** What a call that no runtime took says in every runtime field. */
export const unplaced: RuntimePlacement = {
  runtime: "unplaced",
  slot: "unplaced",
  imageInput: "unplaced",
  boot: "unplaced",
};

/** A call the pool object ran and then lost: whether a runtime took it can't be known here. */
export const unknownPlacement: RuntimePlacement = {
  runtime: "unknown",
  slot: "unknown",
  imageInput: "unknown",
  boot: "unknown",
};

const failures = new WeakMap<object, RuntimePlacement>();
const word = /^[A-Za-z0-9._:-]{1,128}$/;

const of = (identity: SlotIdentity, runtime: RuntimeKind): RuntimePlacement => ({
  runtime,
  slot: identity.slotId,
  imageInput: identity.imageInput,
  boot: identity.bootId,
});
const encode = (placement: RuntimePlacement) =>
  [placement.runtime, placement.slot, placement.imageInput, placement.boot].join(" ");

/** An answer marked with the runtime that gave it; an earlier mark under this name is replaced. */
export function placedOn(response: Response, identity: SlotIdentity, runtime: RuntimeKind) {
  const headers = new Headers(response.headers);
  headers.set(runtimePlacementHeader, encode(of(identity, runtime)));
  return copy(response, headers);
}

/** A root answer from the pool object's own container never carries a mark it did not earn. */
export function withoutPlacement(response: Response) {
  if (!response.headers.has(runtimePlacementHeader)) return response;
  const headers = new Headers(response.headers);
  headers.delete(runtimePlacementHeader);
  return copy(response, headers);
}

function copy(response: Response, headers: Headers) {
  // An upgrade keeps its socket, which the platform's Response carries outside the standard type.
  const upgrade: ResponseInit & { webSocket?: unknown } = {
    status: 101,
    headers,
    webSocket: "webSocket" in response ? response.webSocket : null,
  };
  const copied =
    response.status === 101
      ? new Response(null, upgrade)
      : new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
  retainEndpointRequestId(response, copied);
  return inheritModelLifetime(response, copied);
}

/** A failure keeps the runtime it happened on, for the refusal built from it later. */
export function failedOn(error: unknown, identity: SlotIdentity, runtime: RuntimeKind) {
  if (typeof error === "object" && error !== null) failures.set(error, of(identity, runtime));
}

export function failurePlacement(error: unknown) {
  return typeof error === "object" && error !== null ? failures.get(error) : undefined;
}

/** The mark for a refusal built from `error`, when the error came from a runtime. */
export function failurePlacementHeaders(error: unknown): Record<string, string> {
  const placement = failurePlacement(error);
  return placement ? { [runtimePlacementHeader]: encode(placement) } : {};
}

/** Only four closed words decode; anything else is no placement at all. */
export function runtimePlacement(headers: Headers): RuntimePlacement | undefined {
  const [runtime, slot, imageInput, boot, ...rest] =
    headers.get(runtimePlacementHeader)?.split(" ") ?? [];
  if (rest.length || !runtime || !slot || !imageInput || !boot) return undefined;
  if (![slot, imageInput, boot].every((part) => word.test(part)) || !isKind(runtime))
    return undefined;
  return { runtime, slot, imageInput, boot };
}
