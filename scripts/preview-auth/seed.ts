import { createHash, randomBytes } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { betterAuth } from "better-auth";
import { organization as organizationPlugin } from "better-auth/plugins/organization";
import { Pool } from "pg";
import { Option } from "effect";
import { authOptions, singleResourceOrigin } from "../../.upstream/apps/hosted/server/src/index.ts";
import {
  previewProof,
  responseCookies,
  requireOk,
  smokeUserName,
  type PreviewProof,
} from "./common.ts";

const output = process.env.PREVIEW_AUTH_SEED_OUTPUT;
if (output === undefined || !isAbsolute(output))
  throw new Error("Preview auth output path must be absolute");

const signIn = async (proof: Pick<PreviewProof, "origin" | "email" | "password">) => {
  const response = await fetch(`${proof.origin}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { origin: proof.origin, "content-type": "application/json" },
    body: JSON.stringify({ email: proof.email, password: proof.password, rememberMe: false }),
  });
  await requireOk(response);
  return responseCookies(response);
};

const request = async (origin: string, cookie: string, route: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("origin", origin);
  headers.set("cookie", cookie);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(`${origin}${route}`, {
    ...init,
    headers,
  });
  await requireOk(response);
  return response.json() as Promise<unknown>;
};

const provision = async () => {
  const proof = previewProof(process.env, true);

  const pool = new Pool({ connectionString: proof.databaseUrl, max: 2 });
  try {
    const current = await pool.query("select current_database() as name");
    if (current.rows[0]?.name !== proof.databaseName)
      throw new Error("Preview database name does not match its stage proof");

    const base = authOptions(
      {
        url: proof.origin,
        resourceOrigins: singleResourceOrigin(proof.origin),
        issuer: `${proof.origin}/api/auth`,
        oauthRedirectUri: Option.none(),
      },
      [],
    );
    const auth = betterAuth({
      ...base,
      database: pool,
      // This instance only hashes a password and writes through Better Auth's adapter.
      // Sign-in and sessions use the deployed preview Worker, never this transient secret.
      secret: randomBytes(32).toString("hex"),
      emailAndPassword: { enabled: true, disableSignUp: true },
      plugins: [...base.plugins, organizationPlugin({ disableOrganizationDeletion: true })],
    });
    const context = await auth.$context;
    const existing = await context.internalAdapter.findUserByEmail(proof.email);
    const user = existing?.user
      ? await context.internalAdapter.updateUser(existing.user.id, {
          name: smokeUserName,
          emailVerified: true,
        })
      : await context.internalAdapter.createUser(
          {
            name: smokeUserName,
            email: proof.email,
            emailVerified: true,
          },
          { method: "email-password" },
        );
    const password = await context.password.hash(proof.password);
    if (await context.internalAdapter.findCredentialAccount(user.id))
      await context.internalAdapter.updatePassword(user.id, password);
    else
      await context.internalAdapter.createAccount({
        userId: user.id,
        providerId: "credential",
        accountId: user.id,
        password,
      });

    const cookie = await signIn(proof);
    const organizations = (await request(
      proof.origin,
      cookie,
      "/api/auth/organization/list",
    )) as Array<{ id: string; slug: string }>;
    const slug = `preview-smoke-${createHash("sha256")
      .update(proof.stage)
      .digest("hex")
      .slice(0, 12)}`;
    let organization = organizations.find((item) => item.slug === slug);
    if (organization === undefined) {
      organization = (await request(proof.origin, cookie, "/api/auth/organization/create", {
        method: "POST",
        body: JSON.stringify({
          name: "Preview smoke",
          slug,
          keepCurrentActiveOrganization: true,
        }),
      })) as { id: string; slug: string };
    }
    if (typeof organization.id !== "string" || typeof organization.slug !== "string")
      throw new Error("Preview organization creation failed");

    const deadline = Date.now() + 120_000;
    let poolAppId: string | undefined;
    while (Date.now() < deadline) {
      const inventory = (await request(
        proof.origin,
        cookie,
        `/api/organizations/${encodeURIComponent(organization.id)}/inventory`,
      )) as { apps?: Array<{ id?: string; name?: string; activeVersion?: string | null }> };
      const app = inventory.apps?.find(
        (item) =>
          item.name !== undefined &&
          /^Preview smoke's pool(?: \d+)?$/.test(item.name) &&
          typeof item.id === "string" &&
          typeof item.activeVersion === "string",
      );
      if (app?.id !== undefined) {
        poolAppId = app.id;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    if (poolAppId === undefined) throw new Error("Preview pool app was not provisioned");

    const target = dirname(output);
    await mkdir(target, { recursive: true, mode: 0o700 });
    const file = await open(output, "wx", 0o600);
    try {
      await file.writeFile(
        `${JSON.stringify(
          {
            version: 1,
            stage: proof.stage,
            origin: proof.origin,
            userId: user.id,
            organization: { id: organization.id, slug: organization.slug },
            poolAppId,
          },
          null,
          2,
        )}\n`,
      );
    } finally {
      await file.close();
    }
  } finally {
    await pool.end();
  }
};

provision().then(
  () => console.log("Seeded a verified preview identity, organization, and installed pool app."),
  () => {
    console.error("Preview auth seed failed.");
    process.exitCode = 1;
  },
);
