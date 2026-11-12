import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectPoolImage } from "../deploy-safety/pool-image-metadata.ts";
import { assertLocalHomeImage, HomeImageMismatchError } from "./home-schema-image-identity.ts";
import { reportRefusal } from "./refusal-report.ts";

const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const credentials = { accountId: "fixture", apiToken: "synthetic-api-token" };

for (const failure of ["platform", "manifest", "config", "invalid-platform"] as const)
  test(`managed ${failure} mismatch retains known identities in job output and summary`, async (context) => {
    const privateValue = "synthetic-diagnostic-secret";
    const architecture =
      failure === "platform" ? "arm64" : failure === "invalid-platform" ? privateValue : "amd64";
    const config = JSON.stringify({
      os: "linux",
      architecture,
      config: { Labels: { "io.signalbox.pool.oauth-completion-receipts": "1" } },
    });
    const configDigest = hash(config);
    const manifest = JSON.stringify({ schemaVersion: 2, config: { digest: configDigest } });
    const digest = hash(manifest);
    const image = {
      image: `registry.cloudflare.com/fixture/pool@${digest}`,
      imageDigest: digest,
      imageConfigDigest: configDigest,
    };
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "api.cloudflare.com")
        return Response.json({
          success: true,
          errors: [],
          result: { username: "fixture", password: "synthetic-pull-token" },
        });
      assert.equal(url.hostname, "registry.cloudflare.com");
      if (url.pathname.endsWith(`/manifests/${digest}`))
        return new Response(failure === "manifest" ? `${manifest} ` : manifest);
      assert.ok(url.pathname.endsWith(`/blobs/${configDigest}`));
      return new Response(failure === "config" ? `${config} ` : config);
    };
    let mismatch: HomeImageMismatchError | undefined;
    await assert.rejects(
      assertLocalHomeImage(image, digest, () =>
        inspectPoolImage(image.image, digest, credentials, fetcher),
      ),
      (error) => {
        assert.ok(error instanceof HomeImageMismatchError);
        mismatch = error;
        return true;
      },
    );
    assert.ok(mismatch);
    const property =
      failure === "manifest"
        ? "image.digest"
        : failure === "config"
          ? "image.configDigest"
          : "image.platform";
    const required =
      failure === "manifest" ? digest : failure === "config" ? configDigest : "linux/amd64";
    const observed =
      failure === "manifest"
        ? hash(`${manifest} `)
        : failure === "config"
          ? hash(`${config} `)
          : failure === "platform"
            ? "linux/arm64"
            : "invalid";
    const directory = mkdtempSync(join(tmpdir(), "managed-image-refusal-"));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    const summary = join(directory, "summary.md");
    const lines: string[] = [];
    await reportRefusal(mismatch.refusal, summary, (line) => lines.push(line));
    for (const text of [
      mismatch.refusal.message,
      lines.join("\n"),
      readFileSync(summary, "utf8"),
    ]) {
      assert.ok(text.includes(property));
      assert.ok(text.includes(required));
      assert.ok(text.includes(observed));
      assert.ok(!text.includes(privateValue));
      assert.ok(!text.includes("synthetic-api-token"));
      assert.ok(!text.includes("synthetic-pull-token"));
      assert.ok(!text.includes("registry.cloudflare.com"));
    }
  });
