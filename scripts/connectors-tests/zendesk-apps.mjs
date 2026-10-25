import assert from "node:assert/strict";

/** Deploy the HTTP-served catalog source and save only one public client per exact site issuer. */
export function deployZendeskApps({ Effect, request, checked, actors, prefix, fixtures, catalog, record }) {
  return Effect.gen(function* () {
    const apps = new Map();
    const clients = new Map();
    for (const site of fixtures.sites) {
      const app = checked(yield* request(actors.owner, "POST", `${prefix}/apps/deploy`, {
        name: `Zendesk native ${site.id}`,
        files: catalog.source.files,
      }), 200, `Deploy Zendesk catalog source for ${site.id}`);
      const path = `${prefix}/apps/${app.id}`;
      const access = checked(yield* request(actors.owner, "GET", `${path}/access`), 200,
        `Read Zendesk ${site.id} app audience`);
      checked(yield* request(actors.owner, "PATCH", `${path}/access`, {
        revision: access.revision,
        audience: { kind: "everyone" },
      }), 200, `Share Zendesk ${site.id} app`);
      const provider = app.requirements?.accounts?.zendesk?.provider;
      assert.equal(typeof provider, "string", `Deployed ${site.id} app omitted its Zendesk provider id`);
      apps.set(site.id, { ...app, path, provider });
      record("catalog-source-deployed", {
        site: site.id,
        host: site.host,
        appIdPresent: typeof app.id === "string",
        providerIdPresent: true,
        catalogResponseSha256: catalog.provenance.catalogResponseSha256,
        deployedIndexSha256: catalog.provenance.deployedFiles["index.ts"],
      });
    }

    for (const site of fixtures.sites) {
      const clientConfig = fixtures.client(site.id, "public");
      const registered = checked(yield* request(actors.admin, "POST", `${prefix}/oauth-clients`, {
        issuer: site.origin,
        clientId: clientConfig.clientId,
      }), 200, `Register public Zendesk client for ${site.id}`);
      assert.equal(registered.client?.issuer, site.origin);
      assert.equal(registered.client?.hasSecret, false, "Stored public client must have no client secret");
      assert.equal(typeof registered.client?.id, "string", "The stored public client needs an organization id");
      clients.set(site.id, { id: registered.client.id, clientId: clientConfig.clientId });
      record("stored-public-client-registered", {
        site: site.id,
        host: site.host,
        issuerOrigin: site.origin,
        secretPresent: false,
      });
    }

    return { apps, clients };
  });
}
