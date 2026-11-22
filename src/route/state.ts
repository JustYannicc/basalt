/**
 * The gateway's node state is its tailnet identity, so it is sealed at rest under a key derived
 * from the pool's signing key, bound to its route, and never logged. A rotation keeps it readable
 * through the previous key, and the caller reseals it under the current one, so rotating never
 * signs the device out.
 */
export interface SealedRouteState {
  iv: number[];
  bytes: number[];
}

const encoder = new TextEncoder();
async function key(secret: string, usage: "encrypt" | "decrypt") {
  const base = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(),
      info: encoder.encode("route-state-v1"),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

export async function sealRouteState(
  secret: string,
  routeId: string,
  state: string,
): Promise<SealedRouteState> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(routeId) },
    await key(secret, "encrypt"),
    encoder.encode(state),
  );
  return { iv: [...iv], bytes: [...new Uint8Array(bytes)] };
}

export async function openRouteState(
  secret: string,
  routeId: string,
  sealed: SealedRouteState,
  previous?: string,
): Promise<{ state: string; reseal: boolean }> {
  try {
    const bytes = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(sealed.iv), additionalData: encoder.encode(routeId) },
      await key(secret, "decrypt"),
      new Uint8Array(sealed.bytes),
    );
    return { state: new TextDecoder().decode(bytes), reseal: false };
  } catch (error) {
    if (previous === undefined) throw error;
    return { state: (await openRouteState(previous, routeId, sealed)).state, reseal: true };
  }
}

export const routeStateKey = "route-v1:state";
interface StoredState {
  sealed: SealedRouteState;
  bootId: string;
  revision: number;
}

/** The node identity at rest in the DO: one sealed copy, tagged with the boot and revision it came from. */
export class RouteIdentityStore {
  private storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
  };
  private secret: string;
  private previous: string | undefined;
  constructor(
    storage: RouteIdentityStore["storage"],
    secret: string,
    previous: string | undefined,
  ) {
    this.storage = storage;
    this.secret = secret;
    this.previous = previous;
  }

  async exists() {
    return (await this.storage.get(routeStateKey)) !== undefined;
  }

  /** The stored state, resealed under the current key after a rotation; null when none opens. */
  async open(routeId: string): Promise<string | null> {
    const stored = await this.storage.get<StoredState>(routeStateKey);
    if (!stored) return null;
    try {
      const opened = await openRouteState(this.secret, routeId, stored.sealed, this.previous);
      if (opened.reseal)
        await this.storage.put(routeStateKey, {
          ...stored,
          sealed: await sealRouteState(this.secret, routeId, opened.state),
        } satisfies StoredState);
      return opened.state;
    } catch {
      // Both keys are gone: the node starts logged out and the reading asks for a new sign-in.
      console.log(JSON.stringify({ route_state: "unreadable" }));
      return null;
    }
  }

  async holds(bootId: string, revision: number) {
    const stored = await this.storage.get<StoredState>(routeStateKey);
    return stored?.bootId === bootId && stored.revision === revision;
  }

  async save(routeId: string, state: string, bootId: string, revision: number) {
    await this.storage.put(routeStateKey, {
      sealed: await sealRouteState(this.secret, routeId, state),
      bootId,
      revision,
    } satisfies StoredState);
  }
}
