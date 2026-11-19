import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { catalogDocumentSha256 } from "./catalog-oauth-metadata.ts";
import { oauthReviews } from "../src/catalog/oauth-policy.ts";
import reviewData from "../src/catalog/oauth-reviews.json" with { type: "json" };

const catalog = fileURLToPath(new URL("../src/catalog/", import.meta.url));
const script = fileURLToPath(new URL("./check-catalog-oauth.ts", import.meta.url));
const refused = "test refused a network connection";
// Every TCP and TLS client, fetch included, connects through this prototype.
const noNetwork = `data:text/javascript,${encodeURIComponent(
  `import net from "node:net";
net.Socket.prototype.connect = function () {
  process.stderr.write(${JSON.stringify(refused + "\n")});
  throw new Error(${JSON.stringify(refused)});
};`,
)}`;

const automatic = oauthReviews(reviewData).flatMap((review) =>
  Object.entries(review.methods).flatMap(([method, decision]) =>
    decision.kind === "automatic"
      ? [{ entry: review.entry, method, metadata: decision.metadata, pin: decision.metadataSha256 }]
      : [],
  ),
);

function check(...args: string[]) {
  const directory = mkdtempSync(join(tmpdir(), "catalog-oauth-check-"));
  try {
    const report = join(directory, "report.json");
    const result = spawnSync(process.execPath, ["--import", noNetwork, script, ...args], {
      encoding: "utf8",
      env: { ...process.env, CATALOG_OAUTH_REPORT: report, GITHUB_STEP_SUMMARY: "" },
    });
    assert.ok(!result.stderr.includes(refused), `the offline check opened a connection`);
    assert.ok(existsSync(report), `no report was written:\n${result.stderr}`);
    const { problems } = JSON.parse(readFileSync(report, "utf8")) as { problems: string[] };
    return { status: result.status, problems };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function catalogCopy(edit: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "catalog-oauth-pins-"));
  copyFileSync(join(catalog, "oauth-reviews.json"), join(directory, "oauth-reviews.json"));
  for (const { entry } of automatic)
    if (existsSync(join(catalog, `${entry}.oauth-metadata.json`)))
      copyFileSync(
        join(catalog, `${entry}.oauth-metadata.json`),
        join(directory, `${entry}.oauth-metadata.json`),
      );
  edit(directory);
  return directory;
}

test("the committed OAuth pins verify with every network connection refused", () => {
  assert.ok(automatic.length > 0);
  assert.deepEqual(check(), { status: 0, problems: [] });
});

test("a tampered committed metadata snapshot fails without a network request", () => {
  const { entry, method, pin } = automatic.find((item) => item.entry === "aws")!;
  const file = `${entry}.oauth-metadata.json`;
  const tampered = {
    ...JSON.parse(readFileSync(join(catalog, file), "utf8")),
    issuer: "https://unreviewed.example",
  };
  const directory = catalogCopy((root) =>
    writeFileSync(join(root, file), JSON.stringify(tampered)),
  );
  try {
    assert.deepEqual(check("--catalog", directory), {
      status: 1,
      problems: [
        `${entry}/${method}: automatic client metadata changed (metadataSha256: ${pin} -> ${catalogDocumentSha256(tampered)})`,
      ],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a missing committed metadata snapshot fails without a network request", () => {
  const { entry, method, metadata } = automatic.find((item) => item.entry === "vercel")!;
  const directory = catalogCopy((root) =>
    rmSync(join(root, `${entry}.oauth-metadata.json`), { force: true }),
  );
  try {
    assert.deepEqual(check("--catalog", directory), {
      status: 1,
      problems: [
        `${entry}/${method}: automatic client metadata is unavailable (${metadata}: no committed snapshot ${entry}.oauth-metadata.json)`,
      ],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a re-pinned snapshot still has to support the reviewed protocol", () => {
  const { entry, method } = automatic.find((item) => item.entry === "workos")!;
  const file = `${entry}.oauth-metadata.json`;
  const insecure = {
    ...JSON.parse(readFileSync(join(catalog, file), "utf8")),
    token_endpoint: "http://signin.workos.com/oauth2/token",
  };
  const directory = catalogCopy((root) => {
    writeFileSync(join(root, file), JSON.stringify(insecure));
    const reviews = readFileSync(join(root, "oauth-reviews.json"), "utf8");
    const pin = automatic.find((item) => item.entry === entry)!.pin;
    writeFileSync(
      join(root, "oauth-reviews.json"),
      reviews.replace(pin, catalogDocumentSha256(insecure)),
    );
  });
  try {
    assert.deepEqual(check("--catalog", directory), {
      status: 1,
      problems: [
        `${entry}/${method}: automatic client metadata does not support the reviewed protocol (token_endpoint: expected HTTPS URL, observed "http://signin.workos.com/oauth2/token")`,
      ],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
