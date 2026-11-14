import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import { PublishedAppFramework } from "../../.upstream/packages/sdk/src/contracts/worker-build.ts";
import {
  admitFramework,
  admitLoadedFramework,
  selectFrameworkProtocol,
} from "../../.upstream/packages/sdk/src/implementation/framework-provenance.ts";
import { compileFrameworkFixture } from "./framework-public-compiler-fixture.ts";

const releases = [
  { version: "0.0.1-beta.104-basalt.14", protocol: 40, input: "BASALT_RETAINED_FRAMEWORK14_LATE" },
  { version: "0.0.1-beta.104-basalt.14", protocol: 40, input: "BASALT_RETAINED_FRAMEWORK14" },
  { version: "0.0.1-beta.104-basalt.15", protocol: 41, input: "BASALT_RETAINED_FRAMEWORK15" },
] as const;
const authored = `
import { defineApp, query, object, string, router } from "apps";
export default defineApp({}, { tools: router({
  who: query({ input: object({}), output: string() }, async ctx => ctx.user?.id ?? "missing"),
}) });`;

for (const release of releases)
  test(
    `released ${release.version}/p${release.protocol} from ${release.input} compiles and reloads unchanged through both retained formats`,
    {
      skip:
        process.env.BASALT_CHECK_RETAINED_FRAMEWORKS !== "1"
          ? "Requires independently rebuilt immutable release packages"
          : false,
      timeout: 20_000,
    },
    async () => {
      const path = process.env[release.input];
      assert.ok(path, `Supply the rebuilt ${release.version} package`);
      const files = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(
        JSON.parse(readFileSync(path, "utf8")),
      );
      const runtime = Schema.decodeUnknownSync(Schema.fromJsonString(PublishedAppFramework))(
        files["runtime.json"],
      );
      assert.equal(runtime.version, release.version);
      assert.equal(runtime.protocol, release.protocol);
      const admitted = await Effect.runPromise(
        admitFramework({
          framework: { version: runtime.version, modules: runtime.server },
          browser: runtime.browser,
          protocol: runtime.protocol,
        }),
      );
      assert.equal(admitted.version, release.version);
      const loaded = await compileFrameworkFixture(authored, [], path);
      assert.deepEqual(loaded.framework, admitted);
      for (const [name, bytes] of Object.entries(runtime.server))
        assert.equal(loaded.modules[name], bytes);
      const protocol = await Effect.runPromise(selectFrameworkProtocol(loaded));
      assert.equal(protocol.version, release.protocol);
      const first = Object.keys(runtime.server)[0];
      assert.ok(first);
      const refused = await Effect.runPromise(
        admitLoadedFramework({
          ...loaded,
          modules: { ...loaded.modules, [first]: "export default 'corrupt';" },
        }).pipe(Effect.flip),
      );
      assert.equal(refused.reason, "content-mismatch");
    },
  );
