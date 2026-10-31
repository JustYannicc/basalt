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
  if (command === "import-direct") {
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
  } else if (command === "run" && rest.length === 0) {
    await run(directory);
  } else if (command === "stdio" && rest[0] === "--agent" && rest.length === 2) {
    const raw = await readPrivate(agentPath(directory, rest[1]));
    const agent = raw && JSON.parse(raw);
    if (!agent || typeof agent.token !== "string")
      throw new Error("Create an agent credential first.");
    await bridgeStdio(ipcPath(directory), agent.token);
  } else if (
    ["status", "disconnect", "reconnect", "sign-out", "revoke"].includes(command) &&
    rest.length === 0
  ) {
    await privateDirectory(directory);
    const result = await control(ipcPath(directory), await operatorToken(directory), command);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    throw new Error(
      "Use import-direct, agent add/remove, run, stdio, status, disconnect, reconnect, sign-out or revoke.",
    );
  }
} catch {
  process.stderr.write(
    "The connection could not finish. Check the command, private file permissions and credential store.\n",
  );
  process.exitCode = 1;
}
