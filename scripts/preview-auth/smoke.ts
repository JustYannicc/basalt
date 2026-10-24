import {
  assertSeedMatchesProof,
  previewProof,
  readSeed,
  requirePoolSetupIntent,
  requireOk,
  responseCookies,
} from "./common.ts";

const run = async () => {
  const proof = previewProof(process.env, false);
  const seed = await readSeed(process.env);
  assertSeedMatchesProof(seed, proof);

  const signedIn = await fetch(`${proof.origin}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { origin: proof.origin, "content-type": "application/json" },
    body: JSON.stringify({ email: proof.email, password: proof.password, rememberMe: false }),
  });
  await requireOk(signedIn);
  const cookie = responseCookies(signedIn);

  const sessionResponse = await fetch(`${proof.origin}/api/auth/get-session`, {
    headers: { origin: proof.origin, cookie },
  });
  await requireOk(sessionResponse);
  const session = (await sessionResponse.json()) as {
    user?: { id?: string; email?: string; emailVerified?: boolean };
  };
  if (
    session.user?.id !== seed.userId ||
    session.user.email?.toLowerCase() !== proof.email.toLowerCase() ||
    session.user.emailVerified !== true
  )
    throw new Error("Preview session did not prove the verified seed identity");

  const organizationResponse = await fetch(`${proof.origin}/api/auth/organization/list`, {
    headers: { origin: proof.origin, cookie },
  });
  await requireOk(organizationResponse);
  const organizations = (await organizationResponse.json()) as Array<{
    id?: string;
    slug?: string;
  }>;
  if (
    !organizations.some(
      (organization) =>
        organization.id === seed.organization.id && organization.slug === seed.organization.slug,
    )
  )
    throw new Error("Preview session does not belong to the seeded organization");

  const inventoryResponse = await fetch(
    `${proof.origin}/api/organizations/${encodeURIComponent(seed.organization.id)}/inventory`,
    { headers: { origin: proof.origin, cookie } },
  );
  await requireOk(inventoryResponse);
  const inventory = (await inventoryResponse.json()) as {
    apps?: Array<{ id?: string; name?: string; activeVersion?: string | null }>;
  };
  const pool = inventory.apps?.find(
    (app) =>
      app.id === seed.poolAppId &&
      app.name !== undefined &&
      /^Preview smoke's pool(?: \d+)?$/.test(app.name) &&
      typeof app.activeVersion === "string",
  );
  if (pool === undefined) throw new Error("Seeded pool app is absent from native inventory");

  const query = await fetch(
    `${proof.origin}/api/organizations/${encodeURIComponent(seed.organization.id)}/apps/${encodeURIComponent(seed.poolAppId)}/data/query`,
    {
      method: "POST",
      headers: { origin: proof.origin, cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "computerContext", input: {} }),
    },
  );
  await requireOk(query);
  requirePoolSetupIntent(await query.json());
};

run().then(
  () => console.log("Preview email sign-in and pool computer-context smoke passed."),
  () => {
    console.error("Preview auth smoke failed.");
    process.exitCode = 1;
  },
);
