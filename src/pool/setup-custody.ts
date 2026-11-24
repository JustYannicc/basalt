import type { ComputerHome } from "./computer-home.ts";
import type { ComputerStorage, Registry } from "./computer-registry.ts";

const storageKey = "computer-setup-key-custody-v1";
type Held = Record<string, true>;

/**
 * Web setups between their mint and their answer. A setup that failed or died there handed its key
 * to nobody, so upkeep revokes whatever Home made for it and drops its computer row, retrying until
 * Home answers. Nothing else can find that key: access removal only reaches keys that have a row.
 */
export class SetupCustody {
  private storage: ComputerStorage;
  private home: Pick<ComputerHome, "find" | "revoke">;
  constructor(storage: ComputerStorage, home: Pick<ComputerHome, "find" | "revoke">) {
    this.storage = storage;
    this.home = home;
  }
  async hold(computer: string) {
    const held = (await this.storage.get<Held>(storageKey)) ?? {};
    held[computer] = true;
    await this.storage.put(storageKey, held);
  }
  /** Before answering, so a setup still held is one whose link reached nobody. */
  async release(computer: string) {
    const held = (await this.storage.get<Held>(storageKey)) ?? {};
    delete held[computer];
    await this.storage.put(storageKey, held);
  }
  /** Runs in the registry queue, where no setup is between its mint and its answer. */
  async sweep(registry: Registry, save: () => Promise<unknown>) {
    const held = (await this.storage.get<Held>(storageKey)) ?? {};
    const done: string[] = [];
    let pending = 0;
    for (const computer of Object.keys(held)) {
      const row = Object.hasOwn(registry, computer) ? registry[computer] : undefined;
      try {
        const keys = row?.keyId !== undefined ? [row.keyId] : await this.home.find(computer);
        for (const key of keys) await this.home.revoke(key);
      } catch {
        pending++;
        continue;
      }
      if (row) delete registry[computer];
      done.push(computer);
    }
    if (pending) console.error("POOL_SETUP_KEY_CLEANUP_PENDING", { pending });
    if (!done.length) return;
    await save();
    for (const computer of done) delete held[computer];
    await this.storage.put(storageKey, held);
  }
}
