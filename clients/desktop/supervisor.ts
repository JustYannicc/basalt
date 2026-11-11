import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { control, controlApps } from "../cli/ipc.ts";
import { ipcPath, operatorToken, runtimeOrigin } from "../cli/profile.ts";

/** Another process's connection answered but never wrote its local address within the bound. */
export class ConnectionStartingError extends Error {
  static readonly copy =
    "The running connection did not finish starting. Stop the other connection, then try again.";
  constructor() {
    super(ConnectionStartingError.copy);
  }
}

/** Owns only the CLI it spawned. Another process using the profile keeps its lease. */
export class ConnectionSupervisor {
  private child: ChildProcess | undefined;
  private finished: Promise<void> | undefined;
  private readonly home: string;
  private readonly entry: string;
  private readonly executable: string;
  private readonly attachWaitMs: number;
  private readonly pause: (signal: AbortSignal) => Promise<void>;
  private attaching: AbortController | undefined;
  constructor(
    home: string,
    entry: string,
    executable: string,
    options: {
      readonly attachWaitMs?: number;
      /** Tests replace the wait between address reads to order them without real time. */
      readonly pause?: (signal: AbortSignal) => Promise<void>;
    } = {},
  ) {
    this.home = home;
    this.entry = entry;
    this.executable = executable;
    this.attachWaitMs = options.attachWaitMs ?? 10_000;
    this.pause =
      options.pause ?? ((signal) => delay(50, undefined, { signal }).catch(() => undefined));
  }

  async status() {
    return control(ipcPath(this.home), await operatorToken(this.home), "status");
  }
  async health() {
    return control(ipcPath(this.home), await operatorToken(this.home), "health");
  }
  async apps() {
    return controlApps(ipcPath(this.home), await operatorToken(this.home));
  }
  async origin() {
    return runtimeOrigin(this.home);
  }
  async start() {
    if (this.child) return;
    let running = false;
    try {
      await this.status();
      running = true;
    } catch {
      /* A stopped connection has no IPC listener. */
    }
    if (running) return this.attach();
    const child = spawn(this.executable, [this.entry, "run", "--home", this.home], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    const finished = new Promise<void>((resolve) => {
      child.once("close", () => {
        if (this.child === child) this.child = undefined;
        resolve();
      });
    });
    this.finished = finished;
    await new Promise<void>((resolve, reject) => {
      let received = "",
        settled = false;
      const timer = setTimeout(
        () =>
          done(new Error("The connection did not start. Check your sign-in and credential store.")),
        15_000,
      );
      const done = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stderr?.off("data", data);
        if (error) reject(error);
        else resolve();
      };
      const data = (chunk: Buffer) => {
        received = (received + chunk.toString()).slice(-2048);
        if (/Connection ready at http:\/\/127\.0\.0\.1:\d+\./u.test(received)) done();
      };
      child.stderr?.on("data", data);
      child.once("error", () => done(new Error("The connection process could not start.")));
      void finished.then(() =>
        done(
          new Error(
            "Sign in before starting the connection. If already signed in, unlock your credential store.",
          ),
        ),
      );
    }).catch(async (error: unknown) => {
      await this.stop();
      throw error;
    });
  }
  /**
   * Another process's connection answers status before it writes its local address, so attaching
   * waits for that address; otherwise the app would report connected with no local Models or
   * Tools address, and agent setup would fail. Only a missing address is waited for.
   */
  private async attach() {
    const attaching = new AbortController();
    this.attaching = attaching;
    const deadline = Date.now() + this.attachWaitMs;
    try {
      for (;;) {
        try {
          await runtimeOrigin(this.home);
          return;
        } catch (cause) {
          const written = await access(join(this.home, "runtime.json")).then(
            () => true,
            () => false,
          );
          if (written) throw cause;
        }
        if (attaching.signal.aborted) throw new Error("Stopped while attaching.");
        if (Date.now() >= deadline) throw new ConnectionStartingError();
        await this.pause(attaching.signal);
      }
    } finally {
      if (this.attaching === attaching) this.attaching = undefined;
    }
  }
  async stop() {
    this.attaching?.abort();
    const child = this.child,
      finished = this.finished;
    if (!child || !finished) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try {
      await finished;
    } finally {
      clearTimeout(timer);
    }
    this.finished = undefined;
  }
  async command(command: "disconnect" | "reconnect" | "sign-out" | "revoke") {
    return control(ipcPath(this.home), await operatorToken(this.home), command);
  }
}
