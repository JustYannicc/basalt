import { randomUUID } from "node:crypto";
import { alchemyArgs } from "../alchemy.ts";
import { run } from "../process.ts";
import { checkReleaseHeadroom } from "./headroom.ts";

export const databasePhaseResources = ["PoolDatabase"];

/** Filtered apply leaves every unselected resource and persisted stack output untouched. */
export async function deployInPhases(options: {
  cloud: string;
  environment: NodeJS.ProcessEnv;
  sharedFoundation: boolean;
  preflight?: typeof checkReleaseHeadroom;
  execute?: typeof run;
}) {
  const execute = options.execute ?? run;
  const headroom = await (options.preflight ?? checkReleaseHeadroom)(options.environment);
  console.log(
    `Database release admitted: primary total ${headroom.observed}, release envelope ${headroom.envelope}, ordinary slots ${headroom.ordinarySlots}.`,
  );
  const environment = { ...options.environment, BASALT_RELEASE_ATTEMPT: randomUUID() };
  const deploy = alchemyArgs(
    "deploy",
    "../../../../alchemy.run.ts",
    "--stage",
    options.environment.ALCHEMY_STAGE!,
    "--yes",
  );
  execute(
    "bun",
    [...deploy, ...databasePhaseResources.flatMap((id) => ["--include", id])],
    options.cloud,
    environment,
  );
  try {
    if (options.sharedFoundation)
      execute(
        "bun",
        alchemyArgs("deploy", "alchemy.app-domains.ts", "--stage", "shared", "--yes"),
        options.cloud,
        environment,
      );
    execute("bun", deploy, options.cloud, environment);
  } catch (error) {
    console.error(
      "Application deployment failed after the database phase succeeded. Database changes remain applied; retry with an expand/contract-compatible release.",
    );
    throw error;
  }
}
