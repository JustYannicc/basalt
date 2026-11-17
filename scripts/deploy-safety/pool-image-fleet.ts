import { SafetyGateError } from "./contracts.ts";
import { record, stringField } from "./http.ts";

export interface BoundFleetApplication {
  color: "BLUE" | "GREEN";
  applicationId: string;
  imageInput: string;
}

const imageInput = /^[a-f0-9]{16}$/u;

/**
 * Resolves the blue/green applications bound on the PoolWorker. After a scale-out release retires
 * the root runtime these are the only applications that can serve, so each refusal names the exact
 * binding that is missing or malformed.
 */
export function boundFleet(bindings: unknown[], rootApplicationId: string) {
  const read = (name: string) => {
    const matches = bindings
      .map((value) => record(value, "Pool Worker binding"))
      .filter((binding) => binding.name === name);
    if (!matches.length) return undefined;
    if (matches.length !== 1)
      throw new SafetyGateError(`Pool Worker binding ${name} is duplicated`);
    if (matches[0]!.type !== "plain_text")
      throw new SafetyGateError(`Pool Worker binding ${name} is not plain text`);
    return stringField(matches[0]!.text, `Pool Worker binding ${name}`);
  };
  const applications: BoundFleetApplication[] = [];
  const seen = new Set([rootApplicationId]);
  for (const color of ["BLUE", "GREEN"] as const) {
    const idName = `POOL_${color}_APPLICATION_ID`;
    const inputName = `POOL_${color}_IMAGE_HASH`;
    const applicationId = read(idName);
    const input = read(inputName);
    if (applicationId === undefined && input === undefined) continue;
    if (!applicationId)
      throw new SafetyGateError(
        `Pool Worker binding ${idName} is missing while ${inputName} is set`,
      );
    if (input === undefined)
      throw new SafetyGateError(
        `Pool Worker binding ${inputName} is missing while ${idName} is set`,
      );
    if (!imageInput.test(input))
      throw new SafetyGateError(`Pool Worker binding ${inputName} is not a 16-hex image input`);
    if (seen.has(applicationId))
      // Application IDs are physical names; public refusals name only the binding.
      throw new SafetyGateError(
        `Pool Worker binding ${idName} reuses the root or the other color's application`,
      );
    seen.add(applicationId);
    applications.push({ color, applicationId, imageInput: input });
  }
  if (!applications.length) return undefined;
  const desired = read("POOL_DESIRED_IMAGE_INPUT");
  if (!desired || !imageInput.test(desired))
    throw new SafetyGateError(
      "Pool Worker binding POOL_DESIRED_IMAGE_INPUT is missing or not a 16-hex image input",
    );
  return { applications, desiredImageInput: desired };
}
