import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Answer,
  ask,
  owned,
  person,
  pool,
  seed,
  wouldRefuse,
} from "./pool-organization-fixture.ts";

// One test per way a pool relates to its organization (F1 ownership table). The check's answer is
// today's in every shape; only shapes the ownership rule would refuse write one warning naming why.

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
const reported = (answer: Answer, organization: string, shape: string, target = pool) => {
  assert.equal(answer.status, 204, "nothing is refused yet");
  assert.deepEqual(answer.lines, [wouldRefuse(organization, shape, target)]);
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

test("17. a deleted pool still answers 204 and reports deleted-pool", async () => {
  await seed({ organizations: { [person]: { basaltPools: { [pool]: native(pool) } } } });
  reported(await ask({ organization: person }), person, "deleted-pool");
});

test("18. a cleared association still answers 204 and reports cleared-association", async () => {
  await seed({ organizations: { [person]: { basaltPools: {} } } });
  reported(await ask({ organization: person }), person, "cleared-association");
});

test("19. a record naming an app owned elsewhere still answers 204 and reports foreign-owner", async () => {
  await seed({
    organizations: { [person]: { basaltPools: { [pool]: native(pool) } } },
    apps: { [pool]: { owner: owned("org_elsewhere") } },
  });
  reported(await ask({ organization: person }), person, "foreign-owner");
});

test("20. an organization's app with no pool record still answers 204 and reports no-record", async () => {
  await seed({ organizations: { [person]: {} }, ...personPool });
  reported(await ask({ organization: person }), person, "no-record");
});

test("21. another existing organization naming a person's pool still answers 204 and reports other-organization", async () => {
  await seed({
    organizations: {
      [person]: { basaltPools: { [pool]: native(pool) } },
      acceptance: {},
      org_other: { basaltPools: { "other-owner": { app: "app_other_pool", version: "dpl_3" } } },
    },
    apps: { [pool]: { owner: owned(person) }, app_other_pool: { owner: owned("org_other") } },
  });
  reported(await ask({ organization: "acceptance" }), "acceptance", "other-organization");
  reported(await ask({ organization: "org_other" }), "org_other", "other-organization");
  silent(await ask({ organization: person }));
});

test("22. a tombstoned organization answers 403 and writes nothing", async () => {
  await seed({ organizations: { acceptance: {} }, ...personPool });
  silent(await ask({ organization: "acceptance", tombstoned: ["acceptance"] }), 403);
});

test("23. an organization that is gone answers 403 and writes nothing", async () => {
  await seed(personPool);
  silent(await ask({ organization: "acceptance" }), 403);
});

test("24. unreadable organization metadata still answers 204 and reports invalid-metadata", async () => {
  for (const metadata of ["{not json", { basaltPools: [] }, { basaltPools: null }]) {
    await seed({ organizations: { [person]: metadata }, ...personPool });
    reported(await ask({ organization: person }), person, "invalid-metadata");
  }
  // Metadata that is not an object, or absent, holds no pools; it is readable.
  for (const metadata of [null, "[]", { basaltPools: undefined }]) {
    await seed({ organizations: { [person]: metadata }, ...personPool });
    reported(await ask({ organization: person }), person, "no-record");
  }
});

test("25. stale envelopes and a missing signing key keep their answers and write nothing", async () => {
  await seed({ organizations: { [person]: {} }, ...personPool });
  const now = Date.now();
  silent(await ask({ organization: person, at: now + 60_000, expiresAt: now + 61_000 }), 401);
  silent(await ask({ organization: person, at: now - 60_000, expiresAt: now - 1 }), 401);
  silent(await ask({ organization: person, key: null }), 503);
});
