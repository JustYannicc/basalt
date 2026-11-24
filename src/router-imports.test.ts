import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const imports =
  /^(?!\s*(?:import|export)\s+type\b)\s*(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/gm;

/** Every module a file loads at run time, type-only imports excluded, and the packages each names. */
function graph(entry: string) {
  const files = new Map<string, string[]>();
  const queue = [resolve(root, entry)];
  while (queue.length) {
    const file = queue.shift()!;
    if (files.has(file)) continue;
    const packages: string[] = [];
    files.set(file, packages);
    for (const match of readFileSync(file, "utf8").matchAll(imports)) {
      const spec = match[1] ?? match[2] ?? match[3]!;
      if (!spec.startsWith(".")) {
        if (!spec.startsWith("node:") && !spec.startsWith("cloudflare:")) packages.push(spec);
        continue;
      }
      const target = resolve(dirname(file), spec);
      const found = [target, `${target}.ts`].find(
        (path) => existsSync(path) && path.endsWith(".ts"),
      );
      if (found) queue.push(found);
    }
  }
  return new Map([...files].map(([file, packages]) => [relative(root, file), packages]));
}

test("the router's model path never loads the pool's runtime slot contracts", () => {
  const reached = [...graph("src/router.ts").keys()].filter((file) =>
    file.startsWith("src/pool/runtime-slots/"),
  );
  assert.deepEqual(reached, []);
});

// The clients' own checks load the tunnel session with only the clients' dependencies installed, so
// a package named under src/ is not found there (24 Nov: `effect` from runtime-slots/contract.ts).
test("nothing under src/ that the device tunnel session loads names a package", () => {
  const named = [...graph("src/tunnel/session.ts")]
    .filter(([file, packages]) => file.startsWith("src/") && packages.length)
    .map(([file, packages]) => `${file}: ${packages.join(", ")}`);
  assert.deepEqual(named, []);
});
