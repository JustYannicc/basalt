import { homedir } from "node:os";
import { brand } from "../../brand.ts";
import type { AgentSelection } from "../contracts/setup.ts";
import { control } from "./ipc.ts";
import { agentSetup } from "./agent-setup.ts";
import { ipcPath, operatorToken, runtimeOrigin } from "./profile.ts";

export async function setupAgents(home: string, selection: AgentSelection, apply: boolean) {
  const installer = agentSetup({
    profileHome: home,
    configHome: homedir(),
    env: process.env,
    brand,
  });
  const needsConnection = Object.values(selection).includes("connect");
  const status = needsConnection
    ? await control(ipcPath(home), await operatorToken(home), "status")
    : undefined;
  if (needsConnection && status?.state !== "connected")
    throw new Error("Reconnect before configuring agents.");
  const preview = await installer.preview(
    selection,
    status?.capabilities ?? [],
    needsConnection ? await runtimeOrigin(home) : undefined,
  );
  process.stdout.write(`${JSON.stringify(preview)}\n`);
  if (apply) {
    await installer.apply(preview.id);
    process.stderr.write(
      "Agent settings updated. Backups are kept; use setup with undo to restore them.\n",
    );
  } else {
    installer.cancel();
    process.stderr.write("Preview only. Add --yes to apply the displayed changes.\n");
  }
}
