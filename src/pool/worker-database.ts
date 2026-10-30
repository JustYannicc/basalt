import * as Cloudflare from "alchemy/Cloudflare";
import type * as Output from "alchemy/Output";
import type * as Planetscale from "alchemy/Planetscale";
import { retain } from "alchemy/RemovalPolicy";
import { Effect, FileSystem } from "effect";
import { fileURLToPath } from "node:url";

/** Worker requests share Hyperdrive's pool; the container keeps its direct URL. */
export const poolWorkerDatabase = (origin: Output.Output<Planetscale.PostgresOrigin, never>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // Reuse the tools service's retained trust root, including on a first deploy.
    const authority = yield* Cloudflare.MtlsCertificate.MtlsCertificate("DatabaseCertificateAuthority", {
      ca: true,
      certificates: yield* fs.readFileString(fileURLToPath(new URL(
        "../../.upstream/apps/hosted/cloud/certificates/isrg-root-x1.pem", import.meta.url,
      ))),
    }).pipe(retain());
    return yield* Cloudflare.Hyperdrive.Connection("PoolModelDatabaseConnection", {
      origin,
      caching: { disabled: true },
      originConnectionLimit: 5,
      mtls: { sslmode: "verify-full", caCertificateId: authority.mtlsCertificateId },
    });
  }).pipe(Effect.orDie);
