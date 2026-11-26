import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { Effect } from "effect";
import type { StageScope } from "./stage-writes.ts";
import { install, WireRefused } from "./wire-guard.ts";
import { routeCloudflareApiTo } from "./test/wire-guard-fixture.ts";
import {
  envelope,
  workerDomain,
  workerDomainNotFound,
  workerDomainRead,
} from "../pool-fleet/test/cloudflare-shapes.ts";

const ACCOUNT = "1".repeat(32);
const OTHER_ACCOUNT = "2".repeat(32);
// The worst case: the stage domain is production's own zone, so production's hostnames and the
// stage's differ only by the stage's label.
const ZONE = "basalt.example";
const STAGE_WORKER = "basalt-rehearsal-mcp-test-rehearsal-2";
const scope: StageScope = {
  stack: "basalt-rehearsal",
  stage: "test-rehearsal-2",
  label: "rehearsal-2",
  domain: ZONE,
  databases: [],
  // What the stage's State rows record: its own Worker, a D1 database's name, and one domain id.
  owned: [STAGE_WORKER, "basalt-rehearsal-db-test-rehearsal-2", "domain-recorded"],
  workers: [STAGE_WORKER],
  accountId: ACCOUNT,
};

type Domain = { id: string; hostname: string; service: string };
type Answer = Domain | { answer: Domain } | number;
const domains: Record<string, Answer> = {
  "domain-own": { id: "domain-own", hostname: `mcp.rehearsal-2.${ZONE}`, service: STAGE_WORKER },
  // Production's own hosts, whichever Worker they name.
  "production-app": { id: "production-app", hostname: `app.${ZONE}`, service: STAGE_WORKER },
  "production-api": { id: "production-api", hostname: `api.${ZONE}`, service: "basalt-api" },
  "production-mcp": { id: "production-mcp", hostname: `mcp.${ZONE}`, service: "basalt-mcp" },
  "production-apex": { id: "production-apex", hostname: ZONE, service: STAGE_WORKER },
  // Another stage's domain, on its own Worker or on this stage's.
  "other-stage": {
    id: "other-stage",
    hostname: `mcp.rehearsal-3.${ZONE}`,
    service: "basalt-rehearsal-mcp-test-rehearsal-3",
  },
  "other-stage-label": {
    id: "other-stage-label",
    hostname: `mcp.rehearsal-20.${ZONE}`,
    service: STAGE_WORKER,
  },
  // Under this stage's label, on a Worker the stage's State does not own: production's, or one
  // that only carries the stage's name.
  "label-foreign-worker": {
    id: "label-foreign-worker",
    hostname: `api.rehearsal-2.${ZONE}`,
    service: "basalt-api",
  },
  "label-named-worker": {
    id: "label-named-worker",
    hostname: `api.rehearsal-2.${ZONE}`,
    service: "basalt-rehearsal-api-test-rehearsal-2",
  },
  // Hostnames that only end like the stage's label.
  "label-prefix": { id: "label-prefix", hostname: `xrehearsal-2.${ZONE}`, service: STAGE_WORKER },
  "label-prefix-sub": {
    id: "label-prefix-sub",
    hostname: `mcp.xrehearsal-2.${ZONE}`,
    service: STAGE_WORKER,
  },
  // Under the label, on a name the State records but not as a Worker.
  "label-other-kind": {
    id: "label-other-kind",
    hostname: `db.rehearsal-2.${ZONE}`,
    service: "basalt-rehearsal-db-test-rehearsal-2",
  },
  "label-suffix": {
    id: "label-suffix",
    hostname: `xrehearsal-2.${ZONE}.evil.example`,
    service: STAGE_WORKER,
  },
  // The read answers another domain's id, or nothing readable.
  "answers-another": {
    answer: { id: "domain-own", hostname: `mcp.rehearsal-2.${ZONE}`, service: STAGE_WORKER },
  },
  "read-fails": 500,
  // A redirect answers from an address no rule checked.
  redirects: 302,
};

/**
 * Cloudflare's API as the guard's proof read sees it, on a local server that fetch reaches for the
 * API host; deletes are recorded, never judged here.
 */
const startCloudflare = async (table: Readonly<Record<string, Answer>>) => {
  const sent: string[] = [];
  const server = createServer(async (request, response) => {
    for await (const _ of request);
    const path = request.url ?? "";
    sent.push(`${request.method} ${path}`);
    const id = new RegExp(`^/client/v4/accounts/${ACCOUNT}/workers/domains/([^/?]+)$`, "u").exec(
      path,
    )?.[1];
    const entry = id === undefined ? undefined : table[id];
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && id !== undefined) {
      if (entry === undefined) {
        response.statusCode = 404;
        return response.end(JSON.stringify(workerDomainNotFound(id)));
      }
      if (entry === 302) {
        response.statusCode = 302;
        response.setHeader(
          "location",
          `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/domains/domain-own`,
        );
        return response.end();
      }
      // A failed read refuses on its status alone: this body would vouch for the stage's domain.
      if (typeof entry === "number") {
        response.statusCode = entry;
        return response.end(
          JSON.stringify(
            workerDomainRead({
              ...workerDomain,
              id,
              hostname: `mcp.rehearsal-2.${ZONE}`,
              service: STAGE_WORKER,
            }),
          ),
        );
      }
      const domain = "answer" in entry ? entry.answer : entry;
      return response.end(JSON.stringify(workerDomainRead({ ...workerDomain, ...domain })));
    }
    // The delete's answer was not recorded; the guard only judges the request, never this body.
    response.end(JSON.stringify(envelope(null)));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const restore = routeCloudflareApiTo(
    `http://127.0.0.1:${(server.address() as { port: number }).port}`,
  );
  return {
    sent,
    close: () =>
      new Promise<void>((resolve) => {
        restore();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

const deleting = async (
  urls: readonly string[],
  table: Readonly<Record<string, Answer>> = domains,
) => {
  const { sent, close } = await startCloudflare(table);
  const errors: WireRefused[] = [];
  const outcomes = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const guard = yield* install({ stage: scope });
        const results: string[] = [];
        for (const url of urls)
          results.push(
            yield* Effect.promise(() =>
              guard
                .fetch(url, { method: "DELETE", headers: { authorization: "Bearer synthetic" } })
                .then((response) => `sent ${response.status}`)
                .catch((error: unknown) => {
                  if (!(error instanceof WireRefused)) return String(error);
                  errors.push(error);
                  return `refused ${error.field}`;
                }),
            ),
          );
        return results;
      }),
    ),
  ).finally(close);
  return {
    outcomes,
    errors,
    sent: sent.map((line) => line.replace(ACCOUNT, "{account}")),
    deletes: sent.filter((line) => line.startsWith("DELETE ")),
  };
};
const api = (id: string, account = ACCOUNT) =>
  `https://api.cloudflare.com/client/v4/accounts/${account}/workers/domains/${id}`;

test("a stage deletes a domain its State never recorded only when both its hostname and its Worker are the stage's", async () => {
  const { outcomes, deletes, sent } = await deleting([api("domain-own"), api("domain-own")]);
  // Proven once, a retry of the same delete passes without a second read.
  assert.deepEqual(outcomes, ["sent 200", "sent 200"]);
  assert.equal(sent.filter((line) => line.startsWith("GET ")).length, 1);
  assert.deepEqual(deletes, [
    `DELETE /client/v4/accounts/${ACCOUNT}/workers/domains/domain-own`,
    `DELETE /client/v4/accounts/${ACCOUNT}/workers/domains/domain-own`,
  ]);
});

test("a lane's destroy deletes its own Worker's domain whose id State never held, and only that", async () => {
  // Alchemy's Worker delete lists the Worker's live domains and deletes each by Cloudflare's id,
  // which the stage's State never recorded.
  const id = "0123456789abcdef0123456789abcdef01234567";
  const own = { id, hostname: `mcp.rehearsal-2.${ZONE}`, service: STAGE_WORKER };
  const admitted = await deleting([api(id)], { [id]: own });
  assert.deepEqual(admitted.outcomes, ["sent 200"]);
  assert.deepEqual(admitted.sent, [
    `GET /client/v4/accounts/{account}/workers/domains/${id}`,
    `DELETE /client/v4/accounts/{account}/workers/domains/${id}`,
  ]);
  // The same delete, where the live read shows production's hostname or another Worker.
  const production = await deleting([api(id)], { [id]: { ...own, hostname: `mcp.${ZONE}` } });
  assert.deepEqual(production.outcomes, ["refused hostname"]);
  assert.deepEqual(production.deletes, []);
  // The refusal never prints the hostname, which can be production's.
  assert.ok(!production.errors[0]!.message.includes(`mcp.${ZONE}`));
  const foreign = await deleting([api(id)], { [id]: { ...own, service: "basalt-mcp" } });
  assert.deepEqual(foreign.outcomes, ["refused service"]);
  assert.deepEqual(foreign.deletes, []);
});

test("production's app, api and mcp hosts are never a stage's to delete, whichever Worker they name", async () => {
  const { outcomes, deletes } = await deleting([
    api("production-app"),
    api("production-api"),
    api("production-mcp"),
    api("production-apex"),
  ]);
  assert.deepEqual(outcomes, [
    "refused hostname",
    "refused hostname",
    "refused hostname",
    "refused hostname",
  ]);
  assert.deepEqual(deletes, []);
});

test("another stage's domain is refused, on its own Worker or on this stage's", async () => {
  const { outcomes, deletes } = await deleting([
    api("other-stage"),
    api("other-stage-label"),
    api("label-suffix"),
    api("label-prefix"),
    api("label-prefix-sub"),
  ]);
  assert.deepEqual(outcomes, [
    "refused hostname",
    "refused hostname",
    "refused hostname",
    "refused hostname",
    "refused hostname",
  ]);
  assert.deepEqual(deletes, []);
});

test("a hostname under the stage's label on a Worker its State does not own is refused", async () => {
  const { outcomes, deletes } = await deleting([
    api("label-foreign-worker"),
    // Carrying the stage's name is not owning: only the stage's State is.
    api("label-named-worker"),
    // A name the State records for another kind is not a Worker it owns.
    api("label-other-kind"),
  ]);
  assert.deepEqual(outcomes, ["refused service", "refused service", "refused service"]);
  assert.deepEqual(deletes, []);
});

test("a read that cannot vouch for the domain is refused, and so is any other origin or account", async () => {
  const { outcomes, deletes } = await deleting([
    api("answers-another"),
    api("read-fails"),
    api("gone-already"),
    api("redirects"),
    api("domain-own", OTHER_ACCOUNT),
    `https://other.example/client/v4/accounts/${ACCOUNT}/workers/domains/domain-own`,
  ]);
  assert.deepEqual(outcomes, [
    "refused read",
    "refused read",
    "refused read",
    "refused read",
    "refused account",
    "refused host",
  ]);
  assert.deepEqual(deletes, []);
});

test("a domain id the stage's State records is deleted without a read, as before", async () => {
  const { outcomes, sent } = await deleting([api("domain-recorded")]);
  assert.deepEqual(outcomes, ["sent 200"]);
  assert.deepEqual(sent, ["DELETE /client/v4/accounts/{account}/workers/domains/domain-recorded"]);
});
