/**
 * This isolate's name. The pool Worker's entry and its objects load one copy of this module per
 * isolate, so an entry and a controller that share an isolate share the name; when the platform
 * replaces that isolate, the calls whose entry had the controller's name are the ones it took down.
 * Workers refuse random values at global scope, so the name is minted on first use.
 */
let current: { id: string; startedAt: number } | undefined;
export function isolate() {
  return (current ??= { id: crypto.randomUUID(), startedAt: Date.now() });
}

/** The controller's isolate on a model answer, for the entry's line; never reaches a client. */
export const controllerIsolateHeader = "X-Basalt-Controller-Isolate";
