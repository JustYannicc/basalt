import { createHash, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Effect, Layer } from "effect";
import { BrowserDriver } from "../../.upstream/e2e/support/browser.ts";
import { driver } from "../../.upstream/e2e/support/platform.ts";

const { chromium } = createRequire(new URL("../../.upstream/package.json", import.meta.url))(
  "playwright",
);

// Chromium's per-request certificate override can retry concurrent stylesheet loads indefinitely.
// Trust this scenario's generated key at launch, before any document or subresource connects.
export const managementBrowser = (certificate) =>
  Layer.effect(
    BrowserDriver,
    Effect.gen(function* () {
      if (certificate === undefined)
        return yield* Effect.die("Management sign-in requires its TLS fixture certificate");
      const pem = yield* Effect.promise(() => readFile(certificate));
      const key = new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" });
      const fingerprint = createHash("sha256").update(key).digest("base64");
      return yield* Effect.acquireRelease(
        driver("launch certificate-bound browser", () =>
          chromium.launch({
            headless: true,
            args: [`--ignore-certificate-errors-spki-list=${fingerprint}`],
          }),
        ),
        (browser) =>
          driver("close certificate-bound browser", () => browser.close()).pipe(Effect.orDie),
      );
    }),
  );
