#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  addAgent,
  agentPath,
  importDirect,
  ipcPath,
  operatorToken,
  removeAgent,
} from "./profile.ts";
import { privateDirectory, readPrivate } from "./private-files.ts";
import { control } from "./ipc.ts";
import { run } from "./run.ts";
import { bridgeStdio } from "./stdio.ts";
import { login } from "./login.ts";
import { DeviceOAuthError } from "../connection/device-oauth.ts";
import { setupAgents } from "./setup.ts";
import { readAgentSelection } from "../contracts/setup.ts";
import { signOut } from "./sign-out.ts";

const args = process.argv.slice(2);
const homeFlag = args.indexOf("--home");
const home =
  homeFlag >= 0
    ? args.splice(homeFlag, 2)[1]
    : join(homedir(), ".local", "state", "signalbox", "client");
const directory = home && resolve(home);
try {
  if (!directory) throw new Error("Use --home with a private connection directory.");
  const [command, ...rest] = args;
  if (command === "login") {
    const restArgs = [...rest];
    const storageFlag = restArgs.indexOf("--storage");
    const storage = storageFlag >= 0 ? restArgs.splice(storageFlag, 2)[1] : "os";
    const noBrowser = restArgs.indexOf("--no-browser");
    if (noBrowser >= 0) restArgs.splice(noBrowser, 1);
    if (!["os", "file"].includes(storage) || restArgs.length > 1 || restArgs[0]?.startsWith("--"))
      throw new Error("Use login [https://server] [--storage os|file] [--no-browser].");
    await login(directory, restArgs[0] ?? "https://app.signalbox.run", storage, noBrowser < 0);
  } else if (command === "import-direct") {
    const file = rest[0];
    const flag = rest.indexOf("--storage");
    const storage = flag >= 0 ? rest[flag + 1] : "os";
    if (!file || !["os", "file"].includes(storage))
      throw new Error("Use import-direct <private-file> [--storage os|file].");
    await importDirect(directory, resolve(file), storage);
    if (storage === "file")
      process.stderr.write(
        "Headless file storage has weaker at-rest protection than an OS credential store.\n",
      );
    process.stderr.write("Direct credentials saved. This is not a native device sign-in.\n");
  } else if (command === "agent" && rest[0] === "add") {
    const id = rest[1];
    const permissions = rest.slice(2);
    if (!id || permissions.some((value) => !["models", "tools"].includes(value)))
      throw new Error("Use agent add <id> models|tools [models|tools].");
    const path = await addAgent(directory, id, permissions);
    process.stderr.write(`Local agent credential saved in ${path}.\n`);
  } else if (command === "agent" && rest[0] === "remove" && rest.length === 2) {
    await removeAgent(directory, rest[1]);
    process.stderr.write("Local agent access removed.\n");
  } else if (command === "setup") {
    const selection = { claude: "keep", codex: "keep" };
    let apply = false;
    for (let index = 0; index < rest.length; index++) {
      const flag = rest[index];
      if (flag === "--yes") apply = true;
      else if (["--claude", "--codex"].includes(flag)) selection[flag.slice(2)] = rest[++index];
      else
        throw new Error(
          "Use setup [--claude connect|keep|undo] [--codex connect|keep|undo] [--yes].",
        );
    }
    await setupAgents(directory, readAgentSelection(selection), apply);
  } else if (command === "run" && rest.length === 0) {
    await run(directory);
  } else if (command === "stdio" && rest[0] === "--agent" && rest.length === 2) {
    const raw = await readPrivate(agentPath(directory, rest[1]));
    const agent = raw && JSON.parse(raw);
    if (!agent || typeof agent.token !== "string")
      throw new Error("Create an agent credential first.");
    await bridgeStdio(ipcPath(directory), agent.token);
  } else if (command === "sign-out" && rest.length === 0) {
    await signOut(directory);
    process.stderr.write("Saved credentials removed.\n");
  } else if (
    ["status", "health", "disconnect", "reconnect", "revoke"].includes(command) &&
    rest.length === 0
  ) {
    await privateDirectory(directory);
    const result = await control(ipcPath(directory), await operatorToken(directory), command);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    throw new Error(
      "Use login, import-direct, agent add/remove, setup, run, stdio, status, health, disconnect, reconnect, sign-out or revoke.",
    );
  }
} catch (error) {
  if (
    error instanceof DeviceOAuthError &&
    ["access_denied", "expired_token"].includes(error.code)
  ) {
    process.stderr.write(
      error.code === "access_denied"
        ? "Device sign-in was denied.\n"
        : "Device sign-in expired. Start sign-in again.\n",
    );
    process.exitCode = 1;
  } else {
    process.stderr.write(
      "The connection could not finish. Check the command, private file permissions and credential store.\n",
    );
    process.exitCode = 1;
  }
}
