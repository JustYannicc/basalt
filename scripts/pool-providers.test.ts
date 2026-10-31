import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertProviderIdsMatch,
  buildProviderTable,
  extractOAuthProviderIds,
  renderProviderTable,
} from "./pool-providers.ts";

const oauthFixture = `package management

func (h *Handler) StartOAuthV8(c *gin.Context) {
	switch strings.ToLower(strings.TrimSpace(c.Query("provider"))) {
	case "":
		c.JSON(http.StatusBadRequest, gin.H{"error": "provider is required"})
	case "alpha":
		h.RequestAlphaToken(c)
	case "beta", "beta-alias":
		h.RequestBetaToken(c)
	case "gamma":
		h.RequestGammaToken(c)
	default:
		if !h.ServePluginAuthURL(c) {
			c.JSON(http.StatusNotFound, gin.H{"error": "provider_not_found"})
		}
	}
}

func (h *Handler) ImportOAuthV8(c *gin.Context) {
	switch strings.ToLower(strings.TrimSpace(c.Query("provider"))) {
	case "import-only":
		h.ImportExampleCredential(c)
	}
}
`;

test("preserves every signin selector while excluding import-only providers", () => {
  assert.deepEqual(extractOAuthProviderIds(oauthFixture), ["alpha", "beta", "beta-alias", "gamma"]);
});

test("preserves names, title-cases new ids, and drops vanished ids", () => {
  assert.deepEqual(
    buildProviderTable(
      ["alpha", "delta", "new-provider", "gamma"],
      [
        { id: "alpha", name: "Alpha Custom" },
        { id: "vanished", name: "Vanished" },
      ],
    ),
    [
      { id: "alpha", name: "Alpha Custom" },
      { id: "delta", name: "Delta" },
      { id: "new-provider", name: "New Provider" },
      { id: "gamma", name: "Gamma" },
    ],
  );
});

test("renders every accepted signin selector", () => {
  assert.equal(
    renderProviderTable(buildProviderTable(extractOAuthProviderIds(oauthFixture))),
    `${JSON.stringify(
      [
        { id: "alpha", name: "Alpha" },
        { id: "beta", name: "Beta" },
        { id: "beta-alias", name: "Beta Alias" },
        { id: "gamma", name: "Gamma" },
      ],
      null,
      2,
    )}\n`,
  );
});

test("rejects a provider table whose ids differ from the pinned source", () => {
  assert.throws(
    () => assertProviderIdsMatch(["alpha"], ["alpha", "delta"], "fixture@commit"),
    /Provider ids differ from fixture@commit: expected alpha, delta; found alpha/,
  );
});

test("keeps Kimi's regional login when both selectors use the same handler", () => {
  const source = oauthFixture.replace('"beta", "beta-alias"', '"kimi", "kimi-ai"');
  assert.deepEqual(extractOAuthProviderIds(source), ["alpha", "kimi", "kimi-ai", "gamma"]);
  assert.throws(
    () => extractOAuthProviderIds(source.replace('case "gamma"', 'case "kimi-ai"')),
    /Duplicate OAuth provider id: kimi-ai/,
  );
});
