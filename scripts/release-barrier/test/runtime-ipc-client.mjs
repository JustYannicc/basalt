import { nodePoolOperations } from "../../pool-operations-node.ts";
import { sendRuntimeCommand } from "../runtime-command-rpc.ts";
import { awaitRuntimeStartup } from "../runtime-startup-client.ts";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const began = Date.now();
const target = {
  accountId: "local-controller-test",
  worker: `local-controller-${input.port}`,
  connect: () =>
    nodePoolOperations(
      "local-controller-test",
      `local-controller-${input.port}`,
      new URL("./local-node-operations.mjs", import.meta.url),
    ),
};
try {
  const call = (command, _mutation, signal) => {
    const at = Date.now();
    return sendRuntimeCommand(
      { ...command, controllerCode: input.command.controllerCode, at, expiresAt: at + 60000 },
      input.key,
      target,
      () => {},
      signal,
    );
  };
  const response = input.startup
    ? await awaitRuntimeStartup({ call, ...input.startup })
    : await call(input.command);
  console.log(
    JSON.stringify({
      ok: true,
      elapsedMs: Date.now() - began,
      response,
      bindingDestination: `http://127.0.0.1:${input.port}`,
      dispatcher: "production",
      parentRuntime: process.versions.bun ? "bun" : "other",
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      elapsedMs: Date.now() - began,
      error: { name: error.name, message: error.message },
      bindingDestination: `http://127.0.0.1:${input.port}`,
      dispatcher: "production",
      parentRuntime: process.versions.bun ? "bun" : "other",
    }),
  );
  process.exitCode = 1;
}
