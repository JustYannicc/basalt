import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ComputerHome } from "../../src/pool/computer-home.ts";
import { HomeClient, PoolHome } from "../../src/pool/control.ts";
import {
  accountMirrorPath,
  accountMirrorPrefix,
  handleAccountKeyMirror,
} from "../../src/pool/account-key-mirror.ts";
import { homeReference, homeReferences } from "../../src/pool/home-references.ts";
import { digest } from "../../src/pool/backend-users.ts";
import { reference } from "../../src/pool/model-history/record.ts";
import { signEnvelope } from "../../src/pool/token.ts";
import { SyntheticOAuthProvider } from "./import-fixture.ts";
import { SharingFixture } from "./sharing-fixture.ts";

const image = process.env.POOL_TEST_IMAGE;
const signingKey = "ab".repeat(32);
const credentialId = "12345678-abcd-4def-8123-0123456789ab";

test(
  "pinned live Home usage auth_index equals the credential UUID carried by the saved account homeReference",
  {
    skip:
      image || process.env.CI
        ? false
        : "A prebuilt pinned POOL_TEST_IMAGE is required; no image download or build is attempted.",
    timeout: 180_000,
  },
  async () => {
    assert.ok(image, "POOL_TEST_IMAGE is required in CI for the pinned live Home mapping proof.");
    // Refuse an absent image rather than letting Docker fetch one during this proof.
    execFileSync("docker", ["image", "inspect", image!], { stdio: "ignore" });
    const provider = new SyntheticOAuthProvider();
    await provider.start();
    const fixture = new SharingFixture({
      image: image!,
      resourcePrefix: "basalt-series-0145-mapping",
      poolContainerArgs: provider.poolContainerArgs,
    });
    try {
      await fixture.start();
      const home = new HomeClient((path, init) => fixture.fetchHome(path, init));
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const token = `${encode({ alg: "none", typ: "JWT" })}.${encode({
        exp: 4_070_908_800,
        email: "synthetic-series@example.invalid",
        "https://api.openai.com/auth": {
          chatgpt_account_id: "synthetic-series",
          chatgpt_user_id: "synthetic-series",
          chatgpt_plan_type: "plus",
        },
      })}.synthetic-signature`;
      const at = Date.now();
      const mirror = await handleAccountKeyMirror(
        new Request(`https://pool.example.test${accountMirrorPath}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            envelope: await signEnvelope(signingKey, accountMirrorPrefix, {
              action: "upsert",
              reference: credentialId,
              at,
              expiresAt: at + 30_000,
              credential: {
                type: "codex",
                access_token: token,
                id_token: token,
                refresh_token: "synthetic-series-refresh",
                account_id: "synthetic-series",
                expired: "2099-01-01T00:00:00Z",
                expires_at: "2099-01-01T00:00:00Z",
                proxy_url: provider.url,
              },
            }),
          }),
        }),
        { home, signingKey },
      );
      assert.equal(mirror.status, 200);
      const files = await fixture.data<{ files: { id: string }[] }>("/credentials");
      assert.ok(files.files.some((file) => file.id === credentialId));
      const account = { homeReference: homeReference([credentialId]) };
      await new PoolHome(home, "series-live-fixture").add([
        ...homeReferences(account.homeReference),
      ]);
      const key = await new ComputerHome(home).mint(
        "series-fixture-owner",
        "series-live-fixture",
        "series-fixture-computer",
      );
      const response = await fixture.model(key.key, "series-mapping-proof", false, "gpt-5.6-luna");
      assert.equal(response.status, 200, await response.text());
      let authIndex = "";
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        authIndex = fixture.diagnostics.sql(
          "SELECT auth_index FROM usage WHERE model='gpt-5.6-luna' AND auth_index<>'' ORDER BY id DESC LIMIT 1",
        );
        if (authIndex) break;
        await delay(100);
      }
      assert.equal(
        authIndex,
        homeReferences(account.homeReference)[0],
        "STOP: the frozen native mapping contradicts the pinned Home usage producer",
      );
      const source = await digest("home-local-v1");
      assert.equal(
        await reference(source, "account", authIndex),
        await reference(source, "account", credentialId),
      );
    } finally {
      await fixture.close();
      await provider.close();
    }
  },
);
