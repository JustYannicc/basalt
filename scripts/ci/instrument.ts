import assert from "node:assert/strict";

export function instrument(config: string, driver: string, reporter: string, driverOutput: string) {
  const reporters = "    reporters: [\n";
  const imports = 'import { Effect, Layer, Option } from "effect";';
  const provide = "    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),";
  for (const [source, marker] of [[config, reporters], [driver, imports], [driver, provide]])
    assert.equal(source!.split(marker!).length, 2, "Expected the pinned E2E instrumentation boundary");
  return {
    config: config.replace(reporters, reporters +
      `      [${JSON.stringify(reporter)}, { outputFile: \`\${directory}/report/diagnostics/ci-verdict.json\` }],\n`),
    driver: driver.replace(imports, 'import { Effect, Exit, FileSystem, Layer, Option } from "effect";')
      .replace(provide, `    Effect.onExit((exit) => Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const expectedTestFailure = Exit.isFailure(exit) && exit.cause.reasons.length === 1 &&
        exit.cause.reasons.every((reason) => reason._tag === "Fail" &&
          typeof reason.error === "object" && reason.error !== null &&
          "_tag" in reason.error && reason.error._tag === "RunFailed" &&
          "message" in reason.error && reason.error.message === "One or more targets failed. Their evidence is retained.");
      yield* fs.writeFileString(${JSON.stringify(driverOutput)} + "." + process.pid + ".json",
        JSON.stringify({ passed: Exit.isSuccess(exit), expectedTestFailure }));
    })),\n${provide}`),
  };
}
