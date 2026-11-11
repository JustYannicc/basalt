import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { desktopController } from "./controller.ts";
import { readHostMessage } from "./contracts.ts";

/**
 * The native Mac shell drives the same controller the Electron window uses. Each stdin line is a
 * HostMessage; each stdout line answers its id, including refusals, so no request waits forever.
 * Stdout carries only these messages. Closing stdin stops the connection this host started.
 */
function option(args: readonly string[], flag: string) {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Choose a value for ${flag}.`);
  return value;
}

function decode(line: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { id: undefined };
  }
  const id = (raw as { id?: unknown } | null)?.id;
  try {
    const message = readHostMessage(raw);
    if (
      message.file !== undefined &&
      (message.request.action !== "import-direct" || !isAbsolute(message.file))
    )
      throw new Error("A file only accompanies import-direct.");
    return { id: message.id, message };
  } catch {
    return { id: typeof id === "number" ? id : undefined };
  }
}

async function host(args: readonly string[]) {
  const home = option(args, "--home");
  if (!home) throw new Error("Use --home with a private connection directory.");
  const storage = option(args, "--storage") ?? "os";
  if (storage !== "os" && storage !== "file") throw new Error("Use --storage os or file.");
  let chosenFile: string | undefined;
  const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const controller = desktopController({
    home: resolve(home),
    configHome: resolve(option(args, "--config-home") ?? homedir()),
    env: process.env,
    executable: process.execPath,
    connectionEntry: resolve(
      option(args, "--connection") ??
        join(dirname(fileURLToPath(import.meta.url)), "connection.mjs"),
    ),
    storage,
    // Tests pass --no-browser so a fixture's approval page never opens on the machine's screen.
    openBrowser: (url) =>
      new Promise<void>((done, fail) => {
        if (args.includes("--no-browser")) return done();
        const protocol = URL.parse(url)?.protocol;
        if (protocol !== "https:" && protocol !== "http:") return fail(new Error("Refused URL."));
        const child = spawn("open", [url], { stdio: "ignore" });
        child.once("error", fail);
        child.once("close", (code) => (code === 0 ? done() : fail(new Error("Browser failed."))));
      }),
    // The shell picks the file natively and sends it with its import-direct request.
    chooseDirectFile: async () => chosenFile,
  });
  const initialized = controller.initialize();
  let closing: Promise<void> | undefined;
  // Waiting for initialize keeps a quit during startup from orphaning the connection it starts.
  const close = () =>
    (closing ??= initialized
      .then(() => controller.close())
      .catch(() => undefined)
      .then(() => process.exit(0)));
  process.once("SIGTERM", () => void close());
  process.once("SIGINT", () => void close());
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const { id, message } = decode(line);
    if (!message) return write({ id, error: "refused" });
    if (message.request.action === "import-direct") chosenFile = message.file;
    void controller
      .request(message.request)
      .then((reply) => write({ id, reply }))
      .catch(() => write({ id, error: "failed" }))
      .finally(() => {
        if (message.request.action === "import-direct") chosenFile = undefined;
      });
  });
  lines.once("close", () => void close());
  await initialized;
}

// host.mjs exists only to run the host, so it starts on load.
await host(process.argv.slice(2)).catch(() => {
  process.stderr.write("The Signalbox host could not start. Check its home directory.\n");
  process.exit(1);
});
