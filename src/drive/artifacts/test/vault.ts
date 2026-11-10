import { storageFixture } from "../../fixture.ts";
import { openVault } from "../../vault.ts";
import { createGitRemote } from "../transport.ts";
import type { VaultRepository } from "../stores.ts";
import { backend, git, token } from "./backend.ts";

export type Backend = Awaited<ReturnType<typeof backend>>;

export const repository = (server: Backend, seen?: string[]): VaultRepository => {
  const remote = createGitRemote({ url: server.url, auth: async () => token });
  return {
    refs: () => remote.refs(),
    async push(input) {
      const result = await remote.push(input);
      seen?.push(...Object.values(result.results));
      return result;
    },
    fetchObjects: remote.fetchObjects,
    async readBlob(oid) {
      try {
        return new Uint8Array(git(server.bare, "cat-file", "blob", oid));
      } catch {
        return null;
      }
    },
  };
};
export const device = async (
  server: Backend,
  seen?: string[],
  before?: (bucket: ReturnType<typeof storageFixture>["bucket"]) => Promise<void>,
) => {
  const data = storageFixture(),
    account = storageFixture();
  await before?.(data.bucket);
  const vault = await openVault({
    ...data,
    accountStorage: account.storage,
    prefix: "vault/",
    repository: repository(server, seen),
  });
  return Object.assign(vault, {
    bucket: data.bucket,
    close() {
      data.close();
      account.close();
    },
  });
};
export const remoteMain = (server: Backend) =>
  git(server.bare, "rev-parse", "main").toString().trim();
