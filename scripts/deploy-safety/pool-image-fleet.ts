import { SafetyGateError } from "./contracts.ts";
import { record, stringField } from "./http.ts";

export class PoolImagePending extends SafetyGateError {}

export interface PoolImageObservation {
  instances: string[];
  fleet?: { applicationId: string; digest: string; instances: string[] }[];
}

export async function assertBoundFleetImages(
  bindings: unknown[],
  root: { applicationId: string; accountId: string },
  application: (id: string) => Promise<unknown>,
  verify: (id: string, digest: string) => Promise<PoolImageObservation>,
): Promise<PoolImageObservation> {
  const read = (name: string) => {
    const matches = bindings
      .map((value) => record(value, "Pool Worker binding"))
      .filter((binding) => binding.name === name);
    if (!matches.length) return undefined;
    if (matches.length !== 1 || matches[0]!.type !== "plain_text")
      throw new SafetyGateError(`Pool fleet binding ${name} is duplicate or not plain text`);
    return stringField(matches[0]!.text, `Pool fleet binding ${name}`);
  };
  const ids = new Set([root.applicationId]);
  const fleet: NonNullable<PoolImageObservation["fleet"]> = [];
  for (const color of ["BLUE", "GREEN"]) {
    const id = read(`POOL_${color}_APPLICATION_ID`);
    const input = read(`POOL_${color}_IMAGE_HASH`);
    if (id === undefined && input === undefined) continue;
    if (!id || !input || !/^[a-f0-9]{16}$/u.test(input) || ids.has(id))
      throw new SafetyGateError(`Pool ${color} fleet application and image input are inconsistent`);
    ids.add(id);
    const app = record(await application(id), "Pool fleet application");
    if (app.id !== id || app.account_id !== root.accountId)
      throw new SafetyGateError(
        `Pool ${color} fleet application identity differs from its binding`,
      );
    const image = stringField(
      record(app.configuration, "Pool fleet configuration").image,
      "Pool fleet image",
    );
    const digest = /@(sha256:[a-f0-9]{64})$/u.exec(image)?.[1];
    if (!digest || !image.startsWith(`registry.cloudflare.com/${root.accountId}/`))
      throw new SafetyGateError(
        `Pool ${color} fleet image is not an immutable image in its account`,
      );
    const observed = await verify(id, digest);
    fleet.push({ applicationId: id, digest, instances: observed.instances });
  }
  const instances = fleet.flatMap((app) => app.instances);
  if (!instances.length)
    throw new PoolImagePending(
      "Pool has no running instance in its root or bound fleet applications",
    );
  if (new Set(instances).size !== instances.length)
    throw new SafetyGateError("Pool fleet applications contain duplicate instance identities");
  return { instances, fleet };
}
