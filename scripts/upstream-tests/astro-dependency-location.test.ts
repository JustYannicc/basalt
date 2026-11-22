import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const fixture = fileURLToPath(new URL("./fixtures/astro-dependency-location.mjs", import.meta.url));

test("the installed Astro builds a dependency's component to the same bytes from any store", () => {
  // Astro's build otherwise reports telemetry over the network and saves settings in the home directory.
  execFileSync(process.execPath, [fixture], {
    stdio: "pipe",
    timeout: 120_000,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" },
  });
});
