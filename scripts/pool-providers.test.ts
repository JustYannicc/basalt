import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertProviderIdsMatch,
  buildProviderTable,
  extractCanonicalOAuthProviderIds,
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

test("extracts only canonical ids from the signin provider switch", () => {
  assert.deepEqual(extractCanonicalOAuthProviderIds(oauthFixture), ["alpha", "beta", "gamma"]);
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

test("renders one JSON table with no alias rows", () => {
  assert.equal(
    renderProviderTable(buildProviderTable(extractCanonicalOAuthProviderIds(oauthFixture))),
    `${JSON.stringify(
      [
        { id: "alpha", name: "Alpha" },
        { id: "beta", name: "Beta" },
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
