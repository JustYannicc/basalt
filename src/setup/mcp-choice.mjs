import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { configPaths } from "./files.mjs";
import { decode, equal } from "./config.mjs";

async function readOptional(path) {
  return readFile(path, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
}

/** Only names are displayed. URLs, commands and credentials remain in the config. */
export async function existingMcpConnections(home, env, brand) {
  const connections = [],
    allNames = new Set(),
    managedNames = new Set();
  const fingerprint = createHash("sha256");
  const saved = await readOptional(join(home, ".local", "state", brand.setup.id, "backups.json"));
  const previous = saved ? JSON.parse(saved) : null;
  fingerprint.update(saved);
  for (const target of configPaths(home, env)) {
    if (target.kind === "claude") continue;
    const source = await readOptional(target.path);
    const config = decode(source, target.format);
    fingerprint.update(JSON.stringify([target.path, source]));
    const root = target.kind === "codex" ? "mcp_servers" : "mcpServers";
    const servers = config[root];
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) continue;
    const file =
      previous?.id === brand.setup.id
        ? previous.files.find((file) => file.path === target.path)
        : undefined;
    for (const [name, value] of Object.entries(servers)) {
      allNames.add(name);
      const owned = file?.changes.some(
        (change) =>
          equal(change.path, [root, name]) &&
          change.after !== undefined &&
          equal(change.after, value),
      );
      if (owned) managedNames.add(name);
      else connections.push({ client: target.kind === "codex" ? "codex" : "claude", name });
    }
  }
  return {
    connections,
    allNames: [...allNames],
    managedName: managedNames.size === 1 ? [...managedNames][0] : undefined,
    revision: fingerprint.digest("hex"),
  };
}

function replacements(connections, names) {
  if (!names.length || names.some((name) => !connections.some((entry) => entry.name === name)))
    throw new Error("Choose an existing MCP connection by name.");
  return Object.fromEntries(
    ["claude", "codex"].map((client) => [
      client,
      connections
        .filter((entry) => entry.client === client && names.includes(entry.name))
        .map((entry) => entry.name),
    ]),
  );
}

/** A piped agent must relay this choice to the person, then rerun with their answer. */
export async function chooseMcpConnections(
  inspected,
  choice,
  brand,
  input = process.stdin,
  output = process.stdout,
) {
  const { connections, allNames, managedName } = inspected;
  const targetName = managedName ?? brand.mcpServerName;
  const keep = () => {
    let name = targetName;
    if (connections.some((entry) => entry.name === name)) {
      let suffix = 2;
      while (allNames.includes(`${brand.mcpServerName}-${suffix}`)) suffix++;
      name = `${brand.mcpServerName}-${suffix}`;
      output.write(`Both connections will be kept. ${brand.name} will be added as ${name}.\n`);
    }
    return { replaceMcp: {}, mcpServerName: name };
  };
  const replace = (names) => {
    if (connections.some((entry) => entry.name === targetName) && !names.includes(targetName))
      throw new Error("Approve replacing the existing destination name or choose Keep both.");
    return { replaceMcp: replacements(connections, names), mcpServerName: targetName };
  };
  if (choice.keep) return keep();
  if (choice.replace.length) return replace(choice.replace);
  if (!connections.length) return keep();
  output.write("Existing MCP connections:\n");
  for (const client of ["claude", "codex"]) {
    const names = connections.filter((entry) => entry.client === client).map((entry) => entry.name);
    if (names.length)
      output.write(`- ${client === "claude" ? "Claude Code" : "Codex"}: ${names.join(", ")}\n`);
  }
  output.write(
    `\n1. Replace your old Executor connection with ${brand.name} (recommended)\n2. Keep both\n`,
  );
  output.write("Only connections you name will be replaced. Undo restores them.\n");
  if (!input.isTTY || !output.isTTY) {
    output.write(
      "Ask the user to choose. Then run the same setup command with --replace-mcp NAME (repeat for each connection) or --keep-mcp. The setup link has not been used and no config has changed.\n",
    );
    return undefined;
  }
  const prompt = createInterface({ input, output });
  try {
    const answer = (await prompt.question("Choose 1 or 2, or press Enter to cancel: ")).trim();
    if (answer === "2") return keep();
    if (answer !== "1") return undefined;
    const suggested = [
      ...new Set(
        connections
          .filter((entry) => entry.name === "executor" || entry.name === targetName)
          .map((entry) => entry.name),
      ),
    ].join(", ");
    const names =
      (
        await prompt.question(`Connection names to replace${suggested ? ` [${suggested}]` : ""}: `)
      ).trim() || suggested;
    return replace(
      names
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    );
  } finally {
    prompt.close();
  }
}
