// Synthetic Obsidian vault apps and the device grants Connect Obsidian creates for them.
export const hour = 60 * 60 * 1000;
export const ago = (ms) => new Date(Date.now() - ms).toISOString();

export const app = (id, name, drive) => ({
  id,
  slug: id,
  name,
  copiedFrom: null,
  activeVersion: "ver_fixture",
  createdAt: "2026-11-01T08:00:00.000Z",
  requirements: { accounts: {}, drive },
});

/** What Connect Obsidian creates: a connection for this one app, run as the app, sync tools only. */
export const vaultConnection = (vault, id, tools) => ({
  id,
  name: `Obsidian · ${vault.name}`,
  policy: {
    apps: [
      {
        app: vault.id,
        runsAs: [{ kind: "app" }],
        tools: { kind: "selected", names: [...tools] },
      },
    ],
  },
  createdAt: "2026-11-11T09:47:00.000Z",
  updatedAt: "2026-11-11T09:47:00.000Z",
});

/** A device's grant through one of those connections. */
export const device = (id, connection, lastActiveAt, name = "Signalbox Obsidian Sync") => ({
  id,
  name,
  connectedAt: "2026-11-11T09:47:00.000Z",
  lastActiveAt,
  access: { kind: "connection", connection, name: "Obsidian device" },
});
