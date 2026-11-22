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

/** Deploys an earlier version at 100%, as `wrangler rollback` does; Cloudflare refuses it across a class change. */
export const rollbackTo = (target: Target, versionId: string, message: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    // Cloudflare's own answer is kept: its HTTP status and each error's code and message go into
    // the refusal's detail, which the release keeps private (sealed), never in its public text.
    const answer: { status?: number; errors?: { code: unknown; message: string }[] } = {};
    const refused = (cause: unknown) =>
      new WorkerVersionRefusal({
        script: target.script,
        why: "Cloudflare did not accept the rollback deployment",
        fix: "Roll back by hand with wrangler rollback",
        detail: { versionId, ...answer },
        cause,
      });
    const created = yield* client
      .execute(
        HttpClientRequest.post(url(target)).pipe(
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
            Effect.flatMap((body) => {
              answer.status = response.status;
              const errors = (body as { errors?: unknown } | undefined)?.errors;
              if (Array.isArray(errors))
                answer.errors = errors.slice(0, 5).map((error) => ({
                  code: (error as { code?: unknown })?.code ?? null,
                  message: String((error as { message?: unknown })?.message ?? "").slice(0, 300),
                }));
              return response.status >= 200 && response.status < 300
                ? Schema.decodeUnknownEffect(Created)(body)
                : Effect.fail(new Error(`HTTP ${response.status}`));
            }),
          ),
        ),
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
    return created.result.id;
  });
