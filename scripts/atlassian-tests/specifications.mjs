import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "./catalog.mjs";

/** Retain full vendor specifications and refuse drift from the reviewed hashes. */
export async function loadSpecifications(root, directory) {
  const provenance = JSON.parse(
    await readFile(join(root, "src/catalog/atlassian/provenance.json"), "utf8"),
  );
  const retained = join(directory, "openapi");
  await mkdir(retained, { mode: 0o700 });
  const specs = {};
  for (const [name, api] of Object.entries(provenance.capabilities.apis)) {
    let bytes;
    if (process.env.ATLASSIAN_SPEC_DIRECTORY) {
      bytes = await readFile(join(process.env.ATLASSIAN_SPEC_DIRECTORY, `${name}.json`));
    } else {
      const response = await fetch(api.url, {
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      assert.equal(response.status, 200, `Download ${name} specification`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
    assert.equal(
      sha256(bytes),
      api.sha256,
      `${name} vendor specification drifted; review before updating the hash`,
    );
    JSON.parse(bytes.toString("utf8"));
    await writeFile(join(retained, `${name}.json`), bytes, { mode: 0o600 });
    specs[name] = bytes;
  }
  return { specs, scopes: provenance.capabilities.requestedScopes };
}
