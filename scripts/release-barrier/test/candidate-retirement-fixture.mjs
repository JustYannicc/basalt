import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixtureAccount } from "../../architecture/native-stack-fixtures.ts";

export async function retirementFixture(declarations, version = 8, failure) {
  const directory = join(process.env.ALCHEMY_HOME, "credentials", "default");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "cloudflare-state-store.json"),
    JSON.stringify({
      url: "https://state.fixture.invalid",
      authToken: "synthetic-state-token",
      accountId: fixtureAccount,
    }),
  );
  const requests = [];
  return {
    requests,
    async fetch(input, init) {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin !== "https://state.fixture.invalid") return declarations.fetch(input, init);
      requests.push({ method: request.method, path: url.pathname });
      if (request.method !== "GET") throw new Error("Synthetic State write refused");
      if (url.pathname === "/") return new Response("State fixture");
      if (url.pathname === "/version") return Response.json({ version });
      if (url.pathname === "/state/stacks") return Response.json(["basalt"]);
      if (url.pathname === "/state/stacks/basalt-placement-repair/stages/production/resources")
        return failure === "unauthorized" ? new Response(null, { status: 401 }) : Response.json([]);
      if (url.pathname === "/state/stacks/basalt-placement-repair/stages/production/output")
        return Response.json(
          failure === "malformed"
            ? { schemaVersion: 2, retired: "private-fixture-token" }
            : { schemaVersion: 1, retired: [] },
        );
      throw new Error("Synthetic State path refused");
    },
  };
}
