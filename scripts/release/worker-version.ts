import { Data, Effect, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

export class WorkerVersionRefusal extends Data.TaggedError("WorkerVersionRefusal")<{
  readonly script: string;
  readonly why: string;
  readonly fix: string;
  readonly detail?: Record<string, unknown>;
  readonly cause?: unknown;
}> {}

// Lenient: the deployments list carries more keys than these (shape recorded from production).
const Deployments = Schema.Struct({
  result: Schema.Struct({
    deployments: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        versions: Schema.Array(
          Schema.Struct({ version_id: Schema.String, percentage: Schema.Number }),
        ),
      }),
    ),
  }),
});
const Created = Schema.Struct({ result: Schema.Struct({ id: Schema.String }) });

interface Target {
  readonly accountId: string;
  readonly token: Redacted.Redacted<string>;
  readonly script: string;
  readonly apiOrigin?: string;
}
const url = (target: Target) =>
  `${target.apiOrigin ?? "https://api.cloudflare.com/client/v4"}/accounts/${encodeURIComponent(target.accountId)}/workers/scripts/${encodeURIComponent(target.script)}/deployments`;

/** The one version serving 100% of the script now; anything else (a split) refuses. */
export const servingVersion = (target: Target) =>
  Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const body = yield* client
      .execute(
        HttpClientRequest.get(url(target)).pipe(
          HttpClientRequest.bearerToken(Redacted.value(target.token)),
        ),
      )
      .pipe(
        Effect.flatMap((response) => response.json),
        Effect.flatMap(Schema.decodeUnknownEffect(Deployments)),
        Effect.mapError(
          (cause) =>
            new WorkerVersionRefusal({
              script: target.script,
              why: "The serving deployment could not be read",
              fix: "Do not release; nothing would be there to roll back to",
              cause,
            }),
        ),
      );
    const versions = body.result.deployments[0]?.versions ?? [];
    if (versions.length !== 1 || versions[0]!.percentage !== 100)
      return yield* new WorkerVersionRefusal({
        script: target.script,
        why: "The script is not served by exactly one version at 100%",
        fix: "Finish or undo the split first",
        detail: { versions },
      });
    return versions[0]!.version_id;
  });

/** Cloudflare's refusal to deploy a version while a secret differs from the value it ran with. */
const SECRET_CHANGED = 10220;

/**
 * Cloudflare's whole changed-secret message, word for word. `force` overrides every block, not only
 * this one, so a message with anything else in it (a removed secret, a changed binding) names no
 * secrets here and is never forced.
 */
const SECRET_CHANGED_MESSAGE =
  /^A secret has changed since this version was active\. If you are sure this is ok, add a \?force=true query parameter to allow the rollback\. The following secrets have changed: ([A-Za-z_][A-Za-z0-9_]*(?:, [A-Za-z_][A-Za-z0-9_]*)*)\.?$/u;

/** The secrets a changed-secret refusal names, or undefined unless it is exactly that message. */
export const changedSecrets = (message: string): readonly string[] | undefined =>
  SECRET_CHANGED_MESSAGE.exec(message.trim())?.[1]?.split(", ");

const errorsOf = (body: unknown) => {
  const errors = (body as { errors?: unknown } | undefined)?.errors;
  return Array.isArray(errors)
    ? errors.slice(0, 5).map((error) => ({
        code: (error as { code?: unknown })?.code ?? null,
        message: String((error as { message?: unknown })?.message ?? ""),
      }))
    : [];
};

/**
 * Deploys an earlier version at 100%, as `wrangler rollback` does. Cloudflare refuses it across a
 * class change, and while a secret differs from the value the version ran with. That refusal is
 * sent again with `force` only when every secret it names is in `forceSecrets`, the release
 * policy's list of secrets whose value a release changes by design, and the refusal is exactly that
 * one message: Cloudflare's `force` overrides every block, not only the changed secret. Cloudflare
 * keeps a secret's value per version (changing one creates a new version), so the earlier version
 * comes back with the value it ran with.
 */
export const rollbackTo = (
  target: Target,
  versionId: string,
  message: string,
  forceSecrets: ReadonlySet<string> = new Set(),
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    // Cloudflare's own answers are kept: each HTTP status and error code and message go into the
    // refusal's detail, which the release keeps private (sealed), never in its public text.
    const answers: { status: number; errors: { code: unknown; message: string }[] }[] = [];
    const refused = (cause: unknown) =>
      new WorkerVersionRefusal({
        script: target.script,
        why: "Cloudflare did not accept the rollback deployment",
        fix: "Roll back by hand with wrangler rollback",
        detail: { versionId, ...answers[0], ...(answers[1] ? { forced: answers[1] } : {}) },
        cause,
      });
    const deploy = (force: boolean) =>
      client
        .execute(
          HttpClientRequest.post(`${url(target)}${force ? "?force=true" : ""}`).pipe(
            HttpClientRequest.bearerToken(Redacted.value(target.token)),
            HttpClientRequest.bodyJsonUnsafe({
              strategy: "percentage",
              versions: [{ version_id: versionId, percentage: 100 }],
              annotations: { "workers/message": message.slice(0, 100) },
            }),
          ),
        )
        .pipe(
          Effect.flatMap((response) =>
            response.json.pipe(
              Effect.catch(() => Effect.succeed(undefined)),
              Effect.map((body) => {
                const errors = errorsOf(body);
                answers.push({
                  status: response.status,
                  errors: errors.map((error) => ({
                    ...error,
                    message: error.message.slice(0, 300),
                  })),
                });
                return { ok: response.status >= 200 && response.status < 300, body, errors };
              }),
            ),
          ),
          Effect.mapError(refused),
        );
    let reply = yield* deploy(false);
    let forcedSecrets: readonly string[] = [];
    if (!reply.ok) {
      const [only, ...more] = reply.errors;
      const named =
        answers[0]?.status === 400 && only?.code === SECRET_CHANGED && !more.length
          ? changedSecrets(only.message)
          : undefined;
      if (!named?.every((name) => forceSecrets.has(name)))
        return yield* refused(new Error(`HTTP ${answers[0]?.status}`));
      forcedSecrets = named;
      reply = yield* deploy(true);
      if (!reply.ok) return yield* refused(new Error(`HTTP ${answers[1]?.status} with force`));
    }
    const created = yield* Schema.decodeUnknownEffect(Created)(reply.body).pipe(
      Effect.mapError(refused),
    );
    const now = yield* servingVersion(target);
    if (now !== versionId)
      return yield* new WorkerVersionRefusal({
        script: target.script,
        why: "After the rollback another version still serves",
        fix: "Roll back by hand with wrangler rollback",
        detail: { expected: versionId, serving: now },
      });
    return { id: created.result.id, forcedSecrets };
  });
