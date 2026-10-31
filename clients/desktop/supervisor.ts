import { spawn, type ChildProcess } from "node:child_process";
import { control } from "../cli/ipc.ts";
import { ipcPath, operatorToken, runtimeOrigin } from "../cli/profile.ts";

/** Owns only the CLI it spawned. Another process using the profile keeps its lease. */
export class ConnectionSupervisor {
  private child: ChildProcess | undefined;
  private finished: Promise<void> | undefined;
  private readonly home: string;
  private readonly entry: string;
  private readonly executable: string;
  constructor(home: string, entry: string, executable: string) {
    this.home = home;
    this.entry = entry;
    this.executable = executable;
  }

  async status() {
    return control(ipcPath(this.home), await operatorToken(this.home), "status");
  }
  async origin() {
    return runtimeOrigin(this.home);
  }
  async start() {
    if (this.child) return;
    try {
      await this.status();
      return;
    } catch {
      /* A stopped connection has no IPC listener. */
    }
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
  async stop() {
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
