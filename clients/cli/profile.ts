import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { lock } from "proper-lockfile";
import {
  readDirectCredentials,
  readProfile,
  type Capability,
  type Profile,
} from "../contracts/connection.ts";
import { credentialStore } from "./credential-store.ts";
import { tokenHash } from "./local-access.ts";
import { privateDirectory, readPrivate, writePrivate } from "./private-files.ts";

export const profilePath = (home: string) => join(home, "profile.json");
export const agentPath = (home: string, id: string) => {
  if (!/^[a-zA-Z0-9_-]{1,80}$/u.test(id))
    throw new Error("Use an agent ID with letters, numbers, hyphens or underscores.");
  return join(home, `agent-${id}.json`);
};
export async function loadProfile(home: string): Promise<Profile> {
  const value = await readPrivate(profilePath(home));
  if (value === undefined) throw new Error("Connect this profile before starting it.");
  return readProfile(JSON.parse(value));
}

export async function runtimeOrigin(home: string) {
  const raw = await readPrivate(join(home, "runtime.json"));
  const value: unknown = raw === undefined ? undefined : JSON.parse(raw);
  if (
    !value ||
    typeof value !== "object" ||
    !("origin" in value) ||
    typeof value.origin !== "string"
  )
    throw new Error("Start the local connection before configuring agents.");
  const url = new URL(value.origin);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/")
    throw new Error("The local connection address is invalid.");
  return url.origin;
}

export async function importDirect(home: string, inputFile: string, storage: "os" | "file") {
  return withStoppedConnection(home, () =>
    withProfile(home, () => importDirectStopped(home, inputFile, storage)),
  );
}
async function importDirectStopped(home: string, inputFile: string, storage: "os" | "file") {
  await privateDirectory(home);
  const input = await readPrivate(inputFile);
  if (input === undefined) throw new Error("The credentials file does not exist.");
  const credentials = readDirectCredentials(JSON.parse(input));
  const previous = await readPrivate(profilePath(home));
  const profile =
    previous === undefined
      ? readProfile({ version: 1, storage, port: 0, agents: [] })
      : readProfile(JSON.parse(previous));
  if (profile.storage !== storage) throw new Error("Sign out before changing credential storage.");
  const vault = await credentialStore(home, storage);
  await vault.write(JSON.stringify(credentials));
  await writePrivate(profilePath(home), JSON.stringify(profile));
}

export async function withStoppedConnection<T>(home: string, work: () => Promise<T>) {
  await privateDirectory(home);
  const release = await lock(home, { lockfilePath: join(home, ".running"), retries: 0 });
  try {
    return await work();
  } finally {
    await release();
  }
}

export async function addAgent(home: string, id: string, capabilities: readonly Capability[]) {
  return withProfile(home, () => addAgentLocked(home, id, capabilities));
}
async function addAgentLocked(home: string, id: string, capabilities: readonly Capability[]) {
  const path = agentPath(home, id);
  const profile = await loadProfile(home);
  if (profile.agents.some((agent) => agent.id === id))
    throw new Error("That agent already exists. Remove it before creating a replacement.");
  if (!capabilities.length || new Set(capabilities).size !== capabilities.length)
    throw new Error("Choose models, tools or both once each.");
  const token = randomBytes(32).toString("base64url");
  const agent = { id, name: id, tokenHash: tokenHash(token), capabilities };
  const updated = readProfile({ ...profile, agents: [...profile.agents, agent] });
  await writePrivate(path, JSON.stringify({ version: 1, id, token }));
  await writePrivate(profilePath(home), JSON.stringify(updated));
  return path;
}

export async function removeAgent(home: string, id: string) {
  await withProfile(home, async () => {
    const path = agentPath(home, id);
    const profile = await loadProfile(home);
    await writePrivate(
      profilePath(home),
      JSON.stringify({
        ...profile,
        agents: profile.agents.filter((agent) => agent.id !== id),
      }),
    );
    await rm(path, { force: true });
  });
}

export async function withProfile<T>(home: string, work: () => Promise<T>): Promise<T> {
  await privateDirectory(home);
  // proper-lockfile keys its process cache by target, even with distinct lockfile paths.
  const release = await lock(profilePath(home), {
    realpath: false,
    lockfilePath: join(home, ".settings"),
    retries: 0,
  });
  try {
    return await work();
  } finally {
    await release();
  }
}

export function ipcPath(home: string) {
  const key = createHash("sha256").update(home).digest("hex").slice(0, 20);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\signalbox-client-${key}`
    : `/tmp/signalbox-client-${process.getuid?.()}-${key}/connection.sock`;
}

export async function operatorToken(home: string): Promise<string> {
  const path = join(home, "operator.json");
  const raw = await readPrivate(path);
  if (raw !== undefined) {
    const value: unknown = JSON.parse(raw);
    if (
      value &&
      typeof value === "object" &&
      "token" in value &&
      typeof value.token === "string" &&
      /^[a-zA-Z0-9_-]{43}$/u.test(value.token)
    )
      return value.token;
    throw new Error("The private operator credential is invalid.");
  }
  const token = randomBytes(32).toString("base64url");
  await writePrivate(path, JSON.stringify({ token }));
  return token;
}
