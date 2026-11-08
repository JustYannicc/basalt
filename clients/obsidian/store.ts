import { decodeBinaryState } from "./binary-state.ts";
import type { BinaryStateStore } from "./binary-types.ts";
import { decodeState } from "./state.ts";
import type { StateStore, SyncState } from "./types.ts";

/**
 * Everything the plugin keeps in data.json. Credentials and pending authorization never land
 * here; the controller keeps those in SecretStorage under `secretKey`.
 */
interface PluginDocument {
  version: 1;
  /** Random per-install id. SecretStorage is app-wide, so the key must not collide across vaults. */
  device: string;
  states: Record<string, unknown>;
  binary: Record<string, unknown>;
  recoveries: string[];
  transfers: string[];
  pins: string[];
  lastSynced: number | null;
}

export interface DataIo {
  load(): Promise<unknown>;
  save(data: unknown): Promise<void>;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : {};

function decodeDocument(input: unknown, makeDevice: () => string): PluginDocument {
  const data = record(input);
  const device =
    typeof data.device === "string" && /^[a-z0-9]{8,32}$/u.test(data.device)
      ? data.device
      : makeDevice();
  const pins = Array.isArray(data.pins)
    ? data.pins.filter((pin): pin is string => typeof pin === "string" && pin.length > 0)
    : [];
  return {
    version: 1,
    device,
    // Raw values; each one goes through decodeState when its app opens.
    states: record(data.states),
    binary: record(data.binary),
    recoveries: Array.isArray(data.recoveries)
      ? data.recoveries.filter((value): value is string => typeof value === "string")
      : [],
    transfers: Array.isArray(data.transfers)
      ? data.transfers.filter((value): value is string => typeof value === "string")
      : [],
    pins,
    lastSynced: typeof data.lastSynced === "number" ? data.lastSynced : null,
  };
}

export const newDeviceId = () =>
  [...crypto.getRandomValues(new Uint8Array(16))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");

/**
 * One in-memory document, one write queue. Every write snapshots the whole document when its
 * turn comes, so a pin or timestamp update can never overwrite a queued sync operation with an
 * older copy, and a queued operation always reaches disk before `save` resolves.
 */
export async function openStore(io: DataIo, makeDevice: () => string = newDeviceId) {
  const raw = await io.load();
  const doc = decodeDocument(raw, makeDevice);
  let chain: Promise<void> = Promise.resolve();
  const persist = () => {
    const write = chain.then(() => io.save(structuredClone(doc)));
    chain = write.catch(() => {});
    return write;
  };
  if (record(raw).device !== doc.device) await persist();
  return {
    device: doc.device,
    secretKey: `basalt-sync-${doc.device}`,
    states(appId: string): StateStore {
      return {
        async load(): Promise<SyncState | null> {
          return decodeState(doc.states[appId] ?? null);
        },
        async save(state: SyncState) {
          doc.states[appId] = structuredClone(state);
          await persist();
        },
      };
    },
    binary(appId: string): BinaryStateStore {
      return {
        load: async () => decodeBinaryState(doc.binary[appId] ?? null),
        save: async (value) => {
          doc.binary[appId] = structuredClone(value);
          await persist();
        },
      };
    },
    recoveries: {
      get: () => [...doc.recoveries],
      async add(path: string) {
        if (!doc.recoveries.includes(path)) doc.recoveries.push(path);
        await persist();
      },
    },
    transfers: {
      get: () => [...doc.transfers],
      async add(path: string) {
        if (!doc.transfers.includes(path)) doc.transfers.push(path);
        await persist();
      },
      async remove(path: string) {
        doc.transfers = doc.transfers.filter((value) => value !== path);
        await persist();
      },
    },
    pins: {
      get: (): readonly string[] => [...doc.pins],
      async set(value: readonly string[]) {
        doc.pins = [...value];
        await persist();
      },
    },
    lastSynced: () => doc.lastSynced,
    async markSynced(at: number) {
      doc.lastSynced = at;
      await persist();
    },
    /** Resolves once every queued write has finished. */
    flush: () => chain,
  };
}
export type PluginStore = Awaited<ReturnType<typeof openStore>>;
