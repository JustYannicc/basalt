import { Schema } from "effect";
import { LaunchRefused } from "./launch-contract.ts";
import { decodeStoppedApproval } from "./stopped-approval.ts";
import type { StoppedRecovery } from "./stopped-recovery.ts";

/** Future private entrypoint only. The deployed worker does not import or route this action. */
export async function handleStoppedRecovery(
  request: Request,
  service: StoppedRecovery,
  secret: string,
) {
  try {
    if (request.method === "GET")
      return Response.json(
        await service.inspect(new URL(request.url).searchParams.get("operationId") ?? undefined),
        { headers: { "Cache-Control": "no-store" } },
      );
    if (request.method !== "POST") throw new LaunchRefused("method-invalid");
    const text = await request.text();
    if (text.length > 8_192) throw new LaunchRefused("body-too-large");
    const body = Schema.decodeUnknownSync(Schema.Struct({ envelope: Schema.String }), {
      onExcessProperty: "error",
    })(JSON.parse(text));
    return Response.json(await service.run(await decodeStoppedApproval(secret, body.envelope)), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json(
      {
        error: "stopped_recovery_refused",
        reason: error instanceof LaunchRefused ? error.reason : "unavailable",
      },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }
}
