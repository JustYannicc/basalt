import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { main } from "./support.ts";
import { remoteFixture } from "./remote-fixture.ts";

test(
  "CLI setup previews without keys, applies separate agent access, preserves edits and undoes offline",
  { timeout: 30_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "client-agent-setup-"));
    const profile = join(home, "connection"),
      claude = join(home, "claude"),
      codex = join(home, "codex");
    const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex };
    const launch = (args: string[]) => {
      const child = spawn(process.execPath, [main, "--home", profile, ...args], {
        env: args[0] === "setup" ? env : { ...env, HOME: process.env.HOME },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const exited = once(child, "close").then(([code]) => ({ code, stdout, stderr }));
      return { child, exited, stderr: () => stderr };
    };
    const command = async (args: string[]) => {
      const result = await launch(args).exited;
      assert.equal(result.code, 0, result.stderr);
      return result;
    };
    const remote = await remoteFixture();
    let runtime: ReturnType<typeof launch> | undefined;
    const stop = async () => {
      if (!runtime) return;
      runtime.child.kill("SIGTERM");
      assert.equal((await runtime.exited).code, 0);
      runtime = undefined;
    };
    try {
      await mkdir(claude, { mode: 0o700 });
      await mkdir(codex, { mode: 0o700 });
      const settingsPath = join(claude, "settings.json"),
        authPath = join(codex, "auth.json");
      const original = '{"env":{"OTHER_SETTING":"keep"},"model":"previous-model"}\n';
      await writeFile(settingsPath, original, { mode: 0o600 });
      const auth = '{"synthetic_auth":"must-stay-byte-identical"}\n';
      await writeFile(authPath, auth, { mode: 0o600 });
      const input = join(home, "input.json");
      await writeFile(
        input,
        JSON.stringify({
          version: 1,
          mode: "direct",
          models: { origin: remote.origin, token: "synthetic-model-key" },
          tools: { origin: remote.origin, path: "/mcp", token: "ext_synthetic-tools-key" },
        }),
        { mode: 0o600 },
      );
      await command([
        "import-direct",
        input,
        "--storage",
        process.platform === "linux" ? "file" : "os",
      ]);
      runtime = launch(["run"]);
      const ready = /Connection ready at http:\/\/127\.0\.0\.1:\d+\./u;
      if (!ready.test(runtime.stderr()))
        await new Promise<void>((resolve, reject) => {
          const child = runtime!;
          const received = () => {
            if (ready.test(child.stderr())) {
              child.child.stderr.off("data", received);
              resolve();
            }
          };
          child.child.stderr.on("data", received);
          void child.exited.then((result) => reject(new Error(result.stderr)));
        });
      const before = await readFile(join(profile, "profile.json"), "utf8");
      const args = ["setup", "--claude", "connect", "--codex", "connect"];
      const preview = await command(args);
      assert.equal(JSON.parse(preview.stdout).files.length, 3);
      assert.equal(await readFile(settingsPath, "utf8"), original);
      assert.equal(await readFile(join(profile, "profile.json"), "utf8"), before);
      await assert.rejects(readFile(join(profile, "agent-desktop-claude.json")));
      await assert.rejects(readFile(join(profile, "agent-desktop-codex.json")));
      await assert.rejects(readFile(join(codex, "config.toml")));
      const applied = await command([...args, "--yes"]);
      const local = async (client: string): Promise<string> =>
        JSON.parse(await readFile(join(profile, `agent-desktop-${client}.json`), "utf8")).token;
      const claudeToken = await local("claude"),
        codexToken = await local("codex");
      assert.notEqual(claudeToken, codexToken);
      for (const output of [preview.stdout, preview.stderr, applied.stdout, applied.stderr])
        for (const secret of [
          claudeToken,
          codexToken,
          "synthetic-model-key",
          "ext_synthetic-tools-key",
        ])
          assert.ok(
            !output.includes(secret),
            "Preview and apply output must not expose credentials.",
          );
      const configured = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(configured.env.ANTHROPIC_AUTH_TOKEN, claudeToken);
      assert.equal(configured.env.OTHER_SETTING, "keep");
      const codexConfig = await readFile(join(codex, "config.toml"), "utf8");
      assert.ok(codexConfig.includes(codexToken));
      assert.ok(!codexConfig.includes(claudeToken));
      assert.ok(!codexConfig.includes("synthetic-model-key"));
      assert.equal(await readFile(authPath, "utf8"), auth);
      const { origin } = JSON.parse(await readFile(join(profile, "runtime.json"), "utf8"));
      for (const token of [claudeToken, codexToken]) {
        const models = await fetch(`${origin}/v1/models`, {
          headers:
            token === codexToken
              ? { "x-api-key": token, authorization: "Bearer synthetic.provider.login" }
              : { authorization: `Bearer ${token}` },
        });
        assert.equal(models.status, 200);
        await models.body?.cancel();
        const tools = new Client({ name: "setup-proof", version: "1.0.0" });
        try {
          await tools.connect(
            new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
              requestInit: { headers: { authorization: `Bearer ${token}` } },
            }),
          );
          const name = token === claudeToken ? "claude" : "codex";
          assert.deepEqual(
            (await tools.callTool({ name: "echo", arguments: { client: name } })).content,
            [{ type: "text", text: JSON.stringify({ client: name }) }],
          );
        } finally {
          await tools.close();
        }
      }
      configured.extra = "later-edit";
      await writeFile(settingsPath, JSON.stringify(configured), { mode: 0o600 });
      const kept = await readFile(settingsPath, "utf8");
      await command(["setup", "--claude", "keep", "--codex", "undo", "--yes"]);
      assert.equal(await readFile(settingsPath, "utf8"), kept);
      await assert.rejects(readFile(join(codex, "config.toml")));
      await assert.rejects(readFile(join(profile, "agent-desktop-codex.json")));
      const refused = await fetch(`${origin}/v1/models`, {
        headers: { authorization: `Bearer ${codexToken}` },
      });
      assert.equal(refused.status, 401);
      await refused.body?.cancel();
      await stop();
      await command(["setup", "--claude", "undo", "--codex", "undo", "--yes"]);
      const restored = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(restored.extra, "later-edit");
      assert.equal(restored.env.OTHER_SETTING, "keep");
      assert.equal(restored.model, "previous-model");
      assert.equal(restored.env.ANTHROPIC_AUTH_TOKEN, undefined);
      await assert.rejects(readFile(join(profile, "agent-desktop-claude.json")));
      assert.equal(
        JSON.parse(await readFile(join(profile, "profile.json"), "utf8")).agents.length,
        0,
      );
      assert.equal(await readFile(authPath, "utf8"), auth);
      await command(["sign-out"]);
      await command(["sign-out"]);
      assert.equal(
        (await launch(["run"]).exited).code,
        1,
        "Offline sign-out removes remote credentials.",
      );
    } finally {
      await stop();
      await launch(["sign-out"]).exited;
      await remote.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
