import { createHash, randomBytes, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  configure,
  previewConfiguration,
  type SetupBrand,
  type SetupClients,
  type SetupOptions,
} from "computer-setup/files";
import { agentPath, loadProfile, profilePath, withProfile } from "../cli/profile.ts";
import { readPrivate, writePrivate } from "../cli/private-files.ts";
import { tokenHash } from "../cli/local-access.ts";
import { readProfile, type Agent, type Capability, type Profile } from "../contracts/connection.ts";
import type { AgentSelection, SetupPreview } from "../contracts/setup.ts";

type LocalAgent = { agent: Agent; token: string; previous: string | undefined };
const ids = { claude: "desktop-claude", codex: "desktop-codex" } as const;
const fingerprint = (profile: Profile) =>
  createHash("sha256").update(JSON.stringify(profile)).digest("hex");

/** New local credentials remain in memory until the person approves the exact file preview. */
export function agentSetup(options: {
  profileHome: string;
  configHome: string;
  env: NodeJS.ProcessEnv;
  brand: SetupBrand;
}) {
  const settings = { home: options.configHome, env: options.env, brand: options.brand };
  let pending:
    | {
        id: string;
        configuration: SetupOptions;
        revision: string;
        profile: Profile | undefined;
        agents: LocalAgent[];
        remove: string[];
      }
    | undefined;
  const inspect = () =>
    previewConfiguration({ ...settings, clients: { claude: "keep", codex: "keep" } });
  const stage = async (
    selection: AgentSelection,
    capabilities: readonly Capability[],
    origin?: string,
    undo = false,
  ): Promise<SetupPreview> => {
    pending = undefined;
    const raw = await readPrivate(profilePath(options.profileHome));
    const profile = raw === undefined ? undefined : readProfile(JSON.parse(raw));
    const clients: SetupClients = {};
    const agents: LocalAgent[] = [],
      remove: string[] = [];
    for (const client of ["claude", "codex"] as const) {
      const choice = selection[client];
      const id = ids[client];
      if (choice === "keep") {
        clients[client] = "keep";
        continue;
      }
      if (choice === "undo") {
        remove.push(id);
        continue;
      }
      if (!profile || !origin || !capabilities.length)
        throw new Error("Reconnect before configuring agents.");
      const url = new URL(origin);
      if (
        url.protocol !== "http:" ||
        url.hostname !== "127.0.0.1" ||
        !url.port ||
        url.pathname !== "/"
      )
        throw new Error("The local connection is unavailable.");
      const previous = await readPrivate(agentPath(options.profileHome, id));
      const current = profile.agents.find((agent) => agent.id === id);
      const saved: unknown = previous === undefined ? undefined : JSON.parse(previous);
      const retained =
        current &&
        saved &&
        typeof saved === "object" &&
        "token" in saved &&
        typeof saved.token === "string" &&
        tokenHash(saved.token) === current.tokenHash
          ? saved.token
          : undefined;
      const token = retained ?? randomBytes(32).toString("base64url");
      const agent = {
        id,
        name: client === "claude" ? "Claude Code" : "Codex",
        tokenHash: tokenHash(token),
        capabilities: [...capabilities],
      };
      agents.push({ agent, token, previous });
      clients[client] = {
        ...(capabilities.includes("models") ? { modelUrl: origin, modelKey: token } : {}),
        ...(capabilities.includes("tools") ? { toolsUrl: `${origin}/mcp`, toolsToken: token } : {}),
      };
    }
    const configuration = { ...settings, clients, undo };
    const preview = await previewConfiguration(configuration);
    const id = randomUUID();
    pending = { id, configuration, revision: preview.revision, profile, agents, remove };
    return { id, files: preview.files };
  };
  return {
    inspect,
    preview: stage,
    undoPreview: () => stage({ claude: "undo", codex: "undo" }, [], undefined, true),
    cancel: () => {
      pending = undefined;
    },
    apply: async (id: string) => {
      const plan = pending;
      pending = undefined;
      if (!plan || plan.id !== id) throw new Error("Review agent setup again before applying it.");
      return withProfile(options.profileHome, async () => {
        const raw = await readPrivate(profilePath(options.profileHome));
        const profile = raw === undefined ? undefined : readProfile(JSON.parse(raw));
        if (
          (profile ? fingerprint(profile) : undefined) !==
          (plan.profile ? fingerprint(plan.profile) : undefined)
        )
          throw new Error("Agent access changed. Review setup again.");
        try {
          if (profile && plan.agents.length) {
            for (const entry of plan.agents)
              await writePrivate(
                agentPath(options.profileHome, entry.agent.id),
                JSON.stringify({ version: 1, id: entry.agent.id, token: entry.token }),
              );
            await writePrivate(
              profilePath(options.profileHome),
              JSON.stringify({
                ...profile,
                agents: [
                  ...profile.agents.filter(
                    (agent) => !plan.agents.some((entry) => entry.agent.id === agent.id),
                  ),
                  ...plan.agents.map(({ agent }) => agent),
                ],
              }),
            );
          }
          await configure({ ...plan.configuration, expectedRevision: plan.revision });
        } catch (error) {
          // Roll back staged access even if a file write failed; the setup manifest retains its recovery path.
          if (profile)
            await writePrivate(profilePath(options.profileHome), JSON.stringify(profile));
          for (const entry of plan.agents) {
            const path = agentPath(options.profileHome, entry.agent.id);
            if (entry.previous === undefined) await rm(path, { force: true });
            else await writePrivate(path, entry.previous);
          }
          throw error;
        }
        if (profile && plan.remove.length) {
          const current = await loadProfile(options.profileHome);
          await writePrivate(
            profilePath(options.profileHome),
            JSON.stringify({
              ...current,
              agents: current.agents.filter((agent) => !plan.remove.includes(agent.id)),
            }),
          );
          for (const id of plan.remove)
            await rm(agentPath(options.profileHome, id), { force: true });
        }
      });
    },
  };
}
