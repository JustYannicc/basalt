import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Socket } from "node:net";
import { after, before } from "node:test";
import { PgClient } from "@effect/sql-pg";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { Crypto, Effect } from "effect";
import { SqlClient } from "effect/sql";
import { sdk } from "./provider-destinations-modules.ts";
import type { Executor } from "../../.upstream/packages/sdk/src/core.ts";

let container: string | undefined;
let port: number;
before(
  async () => {
    container = execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--detach",
        "--publish",
        "127.0.0.1::5432",
        "--env",
        "POSTGRES_HOST_AUTH_METHOD=trust",
        "postgres:17",
      ],
      { encoding: "utf8" },
    ).trim();
    const logs = spawn("docker", ["logs", "--follow", container]);
    try {
      await new Promise<void>((resolve, reject) => {
        let tail = "";
        const ready = (data: Buffer) => {
          tail = (tail + data.toString()).slice(-16_384);
          if (/\[1\] LOG:  database system is ready to accept connections/.test(tail)) resolve();
        };
        logs.stdout.on("data", ready);
        logs.stderr.on("data", ready);
        logs.on("error", reject);
        logs.on("exit", (code) => reject(new Error(`PostgreSQL exited ${code}`)));
      });
    } finally {
      logs.kill();
    }
    const bound = execFileSync("docker", ["port", container, "5432/tcp"], {
      encoding: "utf8",
    }).trim();
    assert.match(bound, /^127\.0\.0\.1:\d+$/);
    port = Number(bound.split(":")[1]);
  },
  { timeout: 30_000 },
);
after(() => {
  if (container)
    execFileSync("docker", ["rm", "--force", "--volumes", container], { stdio: "ignore" });
});

const unused = () => Effect.die("Directory read reached app execution or credential storage");

export const appDirectoryPostgres = <A, E>(
  run: (input: {
    executor: Executor;
    restart: Effect.Effect<Executor, unknown>;
    sql: SqlClient.SqlClient;
    bytes: () => number;
  }) => Effect.Effect<A, E, SqlClient.SqlClient>,
) => {
  const schema = `directory_${randomUUID().replaceAll("-", "")}`;
  let received = 0;
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`create schema ${schema}`);
        const database = yield* sdk.makeExecutorStorage({ provider: "postgresql" });
        yield* database.migrate;
        const crypto = yield* Crypto.Crypto;
        const restart = sdk
          .createExecutor({
            database,
            origin: `https://${schema}.example.invalid`,
            credentials: { encrypt: unused, decrypt: unused, fingerprint: unused },
            git: {
              history: unused,
              create: unused,
              head: unused,
              read: unused,
              commit: unused,
              blob: unused,
              file: unused,
              request: unused,
            },
            blobs: {
              get: unused,
              exists: unused,
              put: unused,
              remove: unused,
              list: unused,
              stream: unused,
            },
            runtime: sdk.runtimeAdapter({
              build: unused,
              skills: unused,
              inspect: unused,
              index: unused,
              query: unused,
              mutate: unused,
              webhook: unused,
              workflow: unused,
              mcpApp: unused,
              call: unused,
              connect: unused,
              checkAccount: unused,
              migrate: unused,
            }),
          })
          .pipe(Effect.provideService(Crypto.Crypto, crypto));
        const executor = yield* restart;
        return yield* run({ executor, restart, sql, bytes: () => received }).pipe(
          Effect.ensuring(sql.unsafe(`drop schema ${schema} cascade`).pipe(Effect.orDie)),
        );
      }),
    ).pipe(
      Effect.provide(
        PgClient.layer({
          host: "127.0.0.1",
          port,
          username: "postgres",
          database: "postgres",
          ssl: false,
          maxConnections: 1,
          prepare: false,
          startupParameters: { search_path: schema },
          stream: () =>
            new Socket()
              .on("data", (data: Buffer) => {
                received += data.length;
              })
              .connect({ host: "127.0.0.1", port }),
        }),
      ),
      Effect.provide(NodeCrypto.layer),
    ),
  );
};
