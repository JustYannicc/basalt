import assert from "node:assert/strict";
import { test } from "node:test";
import { Data, Effect } from "effect";
import {
  type Answer,
  ask,
  endedByDatabase,
  notObserved,
  owned,
  ownershipReadAnswers,
  person,
  pool,
  refused,
  seed,
  wouldRefuse,
} from "./pool-organization-fixture.ts";

// One test per way a pool relates to its organization (F1 ownership table). A pool its organization
// owns answers 204 and writes nothing; a completed read that names why it does not answers 403 with
// one line naming the shape; a read that fails or cannot say why answers 503, never 403 or 204.

const native = (app: string, extra: Record<string, unknown> = {}) => ({
  app,
  version: `dpl_${app}`,
  bundle: "pool-bundle",
  account: `acc_${app}`,
  tokenKeyVersion: "current-key",
  owner: "person-owner",
  primary: true,
  authorization: "executor-app-v1",
  membership: "executor-links-v1",
  ...extra,
});
const personPool = { apps: { [pool]: { owner: owned(person) } } };
const silent = (answer: Answer, status = 204) => {
  assert.equal(answer.status, status);
  assert.deepEqual(answer.lines, []);
};
const refuses = (answer: Answer, organization: string, shape: string, target = pool) => {
  assert.equal(answer.status, 403);
  assert.deepEqual(answer.lines, [refused(organization, shape, target)]);
};
const unavailable = (answer: Answer, line: Answer["lines"][number]) => {
  assert.equal(answer.status, 503);
  assert.deepEqual(answer.lines, [line]);
};

test("1. a person's primary pool from Create pool answers 204 and writes nothing", async () => {
  await seed({
    organizations: {
      [person]: {
        basaltPools: { [pool]: native(pool, { requestId: "request-1", requestName: "Pool" }) },
      },
    },
    ...personPool,
  });
  silent(await ask({ organization: person }));
});

test("2. a default pool from member setup in a personal organization answers 204", async () => {
  const personal = "org_personal_person";
  await seed({
    organizations: { [personal]: { basaltPools: { [pool]: native(pool) } } },
    apps: { [pool]: { owner: owned(personal) } },
  });
  silent(await ask({ organization: personal }));
});

test("3. a further pool in the same organization answers 204", async () => {
  const further = "app_further_pool";
  await seed({
    organizations: {
      [person]: {
        basaltPools: {
          [pool]: native(pool),
          [further]: native(further, { primary: false, requestId: "r2", requestName: "Second" }),
        },
      },
    },
    apps: { [pool]: { owner: owned(person) }, [further]: { owner: owned(person) } },
  });
  silent(await ask({ organization: person, pool: further }));
});

test("4. several owners' pools in one organization each answer 204", async () => {
  const theirs = "app_other_owner_pool";
  await seed({
    organizations: {
      [person]: {
        basaltPools: {
          [pool]: native(pool),
          [theirs]: native(theirs, { owner: "second-owner" }),
        },
      },
    },
    apps: { [pool]: { owner: owned(person) }, [theirs]: { owner: owned(person) } },
  });
  silent(await ask({ organization: person }));
  silent(await ask({ organization: person, pool: theirs }));
});

test("5. a legacy owner-keyed registration answers 204", async () => {
  await seed({
    organizations: {
      [person]: { basaltPools: { "person-owner": { app: pool, version: "dpl_1" } } },
    },
    ...personPool,
  });
  silent(await ask({ organization: person }));
});

test("6. a legacy registration with no active deployment answers 204", async () => {
  await seed({
    organizations: {
      [person]: { basaltPools: { "person-owner": { app: pool, version: "dpl_1" } } },
    },
    apps: { [pool]: { owner: owned(person), active: false } },
  });
  silent(await ask({ organization: person }));
});

test("7. a legacy registration after its native handoff answers 204", async () => {
  await seed({
    organizations: {
      [person]: {
        basaltPools: {
          "person-owner": { app: pool, version: "dpl_1", membership: "executor-links-v1" },
        },
      },
    },
    ...personPool,
  });
  silent(await ask({ organization: person }));
});

test("8. a pool whose access job never delivered answers 204: no job or pool state is read", async () => {
  // The check reads no provisioning rows; the record and app are what an undelivered job leaves.
  await seed({
    organizations: { [person]: { basaltPools: { [pool]: native(pool) } } },
    ...personPool,
  });
  silent(await ask({ organization: person }));
});

test("9. a pool saved before access jobs existed answers 204", async () => {
  await seed({
    organizations: {
      [person]: { basaltPools: { [pool]: { app: pool, version: "dpl_1", owner: "person-owner" } } },
    },
    ...personPool,
  });
  silent(await ask({ organization: person }));
});

test("10. a pool shared through groups answers 204: no access rows are read", async () => {
  await seed({
    organizations: { [person]: { basaltPools: { [pool]: native(pool) } } },
    ...personPool,
  });
  silent(await ask({ organization: person }));
});

test("11. a retained pool with no app authorization answers 204", async () => {
  await seed({
    organizations: {
      [person]: { basaltPools: { [pool]: native(pool, { authorization: undefined }) } },
    },
    ...personPool,
  });
  silent(await ask({ organization: person }));
});

test("12. a pool after signing-key rotation answers 204", async () => {
  await seed({
    organizations: {
      [person]: { basaltPools: { [pool]: native(pool, { tokenKeyVersion: "earlier-key" }) } },
    },
    ...personPool,
  });
  silent(await ask({ organization: person }));
});

test("13. a pool whose owner was demoted or left answers 204", async () => {
  await seed({
    organizations: {
      [person]: { basaltPools: { [pool]: native(pool, { owner: "former-owner" }) } },
    },
    ...personPool,
  });
  silent(await ask({ organization: person }));
});

test("14. a pool whose owner's user was deleted answers 204", async () => {
  await seed({
    organizations: {
      [person]: { basaltPools: { [pool]: native(pool, { owner: "deleted-user" }) } },
    },
    ...personPool,
  });
  silent(await ask({ organization: person }));
});

test("15. a repointed association answers 204 for its replacement", async () => {
  const replacement = "app_replacement_pool";
  await seed({
    organizations: {
      [person]: { basaltPools: { "person-owner": { app: replacement, version: "dpl_2" } } },
    },
    apps: { [replacement]: { owner: owned(person) } },
  });
  silent(await ask({ organization: person, pool: replacement }));
});

test("16. two records naming the same app answer 204", async () => {
  await seed({
    organizations: {
      [person]: {
        basaltPools: { [pool]: native(pool), "person-owner": { app: pool, version: "dpl_1" } },
      },
    },
    ...personPool,
  });
  silent(await ask({ organization: person }));
});

test("17. a deleted pool answers 403 and names deleted-pool", async () => {
  await seed({ organizations: { [person]: { basaltPools: { [pool]: native(pool) } } } });
  refuses(await ask({ organization: person }), person, "deleted-pool");
});

test("18. a cleared association answers 403 and names cleared-association", async () => {
  await seed({ organizations: { [person]: { basaltPools: {} } } });
  refuses(await ask({ organization: person }), person, "cleared-association");
});

test("19. a record naming an app owned elsewhere answers 403 and names foreign-owner", async () => {
  await seed({
    organizations: { [person]: { basaltPools: { [pool]: native(pool) } } },
    apps: { [pool]: { owner: owned("org_elsewhere") } },
  });
  refuses(await ask({ organization: person }), person, "foreign-owner");
});

test("20. an organization's app with no pool record answers 403 and names no-record", async () => {
  await seed({ organizations: { [person]: {} }, ...personPool });
  refuses(await ask({ organization: person }), person, "no-record");
});

test("21. another existing organization naming a person's pool answers 403 and names other-organization", async () => {
  await seed({
    organizations: {
      [person]: { basaltPools: { [pool]: native(pool) } },
      acceptance: {},
      org_other: { basaltPools: { "other-owner": { app: "app_other_pool", version: "dpl_3" } } },
    },
    apps: { [pool]: { owner: owned(person) }, app_other_pool: { owner: owned("org_other") } },
  });
  refuses(await ask({ organization: "acceptance" }), "acceptance", "other-organization");
  refuses(await ask({ organization: "org_other" }), "org_other", "other-organization");
  // Each organization keeps its own pool.
  silent(await ask({ organization: person }));
  silent(await ask({ organization: "org_other", pool: "app_other_pool" }));
});

test("a pool its organization owns answers 204 whatever its organization's other records say", async () => {
  const gone = "app_deleted_pool";
  const theirs = "app_elsewhere_pool";
  await seed({
    organizations: {
      [person]: {
        basaltPools: {
          [pool]: native(pool),
          [gone]: native(gone, { primary: false }),
          [theirs]: native(theirs, { primary: false }),
        },
      },
    },
    apps: { [pool]: { owner: owned(person) }, [theirs]: { owner: owned("org_elsewhere") } },
  });
  silent(await ask({ organization: person }));
  refuses(await ask({ organization: person, pool: gone }), person, "deleted-pool", gone);
  refuses(await ask({ organization: person, pool: theirs }), person, "foreign-owner", theirs);
});

test("22. a tombstoned organization answers 403 and writes nothing", async () => {
  await seed({ organizations: { acceptance: {} }, ...personPool });
  silent(await ask({ organization: "acceptance", tombstoned: ["acceptance"] }), 403);
});

test("23. an organization that is gone answers 403 and writes nothing", async () => {
  await seed(personPool);
  silent(await ask({ organization: "acceptance" }), 403);
});

test("24. unreadable organization metadata answers 503, never 403, and names invalid-metadata", async () => {
  for (const metadata of ["{not json", { basaltPools: [] }, { basaltPools: null }]) {
    await seed({ organizations: { [person]: metadata }, ...personPool });
    unavailable(await ask({ organization: person }), wouldRefuse(person, "invalid-metadata"));
  }
  // Metadata that is not an object, or absent, holds no pools; it is readable.
  for (const metadata of [null, "[]", { basaltPools: undefined }]) {
    await seed({ organizations: { [person]: metadata }, ...personPool });
    refuses(await ask({ organization: person }), person, "no-record");
  }
});

test("24. one organization's unreadable metadata never takes another organization's pool down", async () => {
  const theirs = "app_unreadable_pool";
  await seed({
    organizations: { [person]: { basaltPools: { [pool]: native(pool) } }, org_unreadable: "{not" },
    apps: { [pool]: { owner: owned(person) }, [theirs]: { owner: owned("org_unreadable") } },
  });
  const broken = await ask({ organization: "org_unreadable", pool: theirs });
  unavailable(broken, wouldRefuse("org_unreadable", "invalid-metadata", theirs));
  silent(await ask({ organization: person }));
});

test("25. stale envelopes and a missing signing key keep their answers and write nothing", async () => {
  await seed({ organizations: { [person]: {} }, ...personPool });
  const now = Date.now();
  silent(await ask({ organization: person, at: now + 60_000, expiresAt: now + 61_000 }), 401);
  silent(await ask({ organization: person, at: now - 60_000, expiresAt: now - 1 }), 401);
  silent(await ask({ organization: person, key: null }), 503);
});

class ReadFailed extends Data.TaggedError("ReadFailed") {}

test("an ownership read the database ends at its bound answers 503, never 403 or 204", async () => {
  for (const metadata of [{ basaltPools: { [pool]: native(pool) } }, { basaltPools: {} }]) {
    await seed({ organizations: { [person]: metadata }, ...personPool });
    const answer = await ask({
      organization: person,
      database: ownershipReadAnswers(Effect.fail(endedByDatabase())),
    });
    unavailable(answer, notObserved(person, "timeout"));
  }
});

test("an ownership read that fails answers 503, never 403 or 204", async () => {
  // Once for a pool the organization owns, once for one the rule would refuse.
  for (const organization of [person, "other"]) {
    await seed({
      organizations: { [person]: { basaltPools: { [pool]: native(pool) } }, other: {} },
      ...personPool,
    });
    const answer = await ask({
      organization,
      database: ownershipReadAnswers(Effect.fail(new ReadFailed())),
    });
    unavailable(answer, notObserved(organization, "read-failed"));
  }
});

test("a rule that refuses while its shape read finds ownership answers 503, never 403", async () => {
  await seed({
    organizations: {
      [person]: { basaltPools: { [pool]: { app: pool } } },
      org_other: { basaltPools: { [pool]: { app: "app_other_pool" } } },
    },
    apps: { [pool]: { owner: owned(person) }, app_other_pool: { owner: owned("org_other") } },
  });
  // The rule's read answers no registration for this organization only; the shape read sees its
  // pool owned. A client that sends no batch reads them in one transaction of statements apart.
  const database = ownershipReadAnswers(Effect.succeed([]), person);
  unavailable(await ask({ organization: person, database }), notObserved(person, "changed"));
  // Another organization's pool in the same database still answers on its own read.
  silent(await ask({ organization: "org_other", pool: "app_other_pool", database }));
});

test("metadata the database's JSON type refuses answers 503 and names invalid-metadata", async () => {
  await seed({
    organizations: { [person]: '{"basaltPools":{},"name":"a\\u0000b"}' },
    ...personPool,
  });
  unavailable(await ask({ organization: person }), wouldRefuse(person, "invalid-metadata"));
});

test("a client that sends one batch gives every answer the same, an unexplained refusal included", async () => {
  const batched = true;
  await seed({
    organizations: {
      [person]: { basaltPools: { [pool]: native(pool) } },
      acceptance: {},
      org_unreadable: "{not json",
    },
    apps: { [pool]: { owner: owned(person) }, app_unreadable: { owner: owned("org_unreadable") } },
  });
  silent(await ask({ organization: person, batched }));
  refuses(await ask({ organization: "acceptance", batched }), "acceptance", "other-organization");
  silent(await ask({ organization: "org_gone", batched }), 403);
  unavailable(
    await ask({ organization: "org_unreadable", pool: "app_unreadable", batched }),
    wouldRefuse("org_unreadable", "invalid-metadata", "app_unreadable"),
  );
  for (const [read, reason] of [
    [Effect.fail(new ReadFailed()), "read-failed"],
    [Effect.fail(endedByDatabase()), "timeout"],
    // The rule refuses and the shape read, in the same snapshot, finds the pool owned.
    [Effect.succeed([]), "unexplained"],
  ] as const) {
    const database = ownershipReadAnswers(read, person);
    unavailable(
      await ask({ organization: person, batched, database }),
      notObserved(person, reason),
    );
    refuses(
      await ask({ organization: "acceptance", batched, database }),
      "acceptance",
      "other-organization",
    );
  }
});
