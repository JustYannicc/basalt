import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Real Alchemy declarations in a disposable project, never a substitute for the root inventory. */
export function nativeFixture(modules: string, body: string) {
  const root = mkdtempSync(join(tmpdir(), "native-stack-fixture-"));
  mkdirSync(join(root, "scripts"));
  symlinkSync(modules, join(root, "node_modules"), "dir");
  writeFileSync(join(root, "brand.ts"), 'export const brand = { zone: "fixture.invalid" };');
  writeFileSync(join(root, "scripts/environment.ts"), 'export const requiredSecrets = []; export const deployEnvironment = () => ({ ALCHEMY_STAGE: "fixture" });');
  const write = (body: string) => writeFileSync(join(root, "alchemy.run.ts"), `
    import { Stack } from "alchemy/Stack";
    import { Resource } from "alchemy/Resource";
    import { Effect, Layer } from "effect";
    export default Stack("fixture", { providers: Layer.empty, state: Layer.empty }, Effect.gen(function* () {
      ${body}
    }));
  `);
  write(body);
  return { root, write, dispose: () => rmSync(root, { recursive: true, force: true }) };
}
