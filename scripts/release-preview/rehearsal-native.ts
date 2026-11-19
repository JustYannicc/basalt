/**
 * The native cutover, rehearsed: a stage deployed the way production is today (PoolWorker's entry
 * exports both fleet classes, nothing declares them), then ONE plain Alchemy deploy with the fleet
 * declared. Each step's plan and read-back is evidence; the run stops only where the cutover does.
 */
export type NativeReadBack = {
  bindings: { name: string; type: string; className?: string }[];
  namespaces: string[];
  applications: {
    name: string;
    className?: string;
    image?: string;
    instances?: unknown;
    /** The application's version: it moves on every modify, so an apply that changes nothing leaves it. */
    version?: unknown;
    shape: unknown;
    instancesShape?: unknown;
  }[];
  /** Plain-text identity bindings (POOL_IMAGE_HASH, application ids); never secret values. */
  plainText?: Record<string, string>;
};

export interface NativeHooks {
  /** The stage as production is: the fleet classes exported by the entry, nothing declared. */
  deployBaseline(): Promise<void>;
  readBack(label: string): Promise<NativeReadBack>;
  /** Builds the candidate checkout once, under the stage's brand, before it plans or deploys. */
  build(): Promise<void>;
  /** Both colors pinned to the stage pool image by digest, as POOL_FLEET_IMAGES. */
  fleetImages(): Promise<{ blue: string; green: string }>;
  plan(label: string, images: { blue: string; green: string }): Promise<string>;
  apply(images: { blue: string; green: string }): Promise<void>;
  serve(): Promise<unknown>;
}

export type NativeRecord = {
  scenario: "single-writer-native";
  steps: string[];
  plans: Record<string, string[]>;
};

const fleetClasses = ["PoolRuntimeBlue", "PoolRuntimeGreen"] as const;

/** The plan lines that say what the cutover does: classes, migrations, applications, deletions. */
export function planHighlights(plan: string): string[] {
  return plan
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+$/u, ""))
    .filter((line) =>
      /PoolRuntime|new_sqlite_classes|deleted_classes|renamed_classes|transferred_classes|Container|delete|replace|destroy|PoolContainer|No changes|\bcreate\b|\bupdate\b/iu.test(
        line,
      ),
    )
    .slice(0, 120);
}

export function requireBaselineShape(readBack: NativeReadBack) {
  const bound = readBack.bindings.filter((binding) =>
    (fleetClasses as readonly string[]).includes(binding.className ?? binding.name),
  );
  if (bound.length)
    throw new Error(
      `The baseline already binds a fleet class: ${bound.map((b) => b.name).join(", ")}`,
    );
  if (
    readBack.applications.some((application) =>
      /pool-runtime-(?:blue|green)$/u.test(application.name),
    )
  )
    throw new Error("The baseline already has a fleet application");
  if (!readBack.applications.some((application) => application.className === "PoolContainer"))
    throw new Error("The baseline has no PoolContainer application");
}

export function requireCutoverShape(readBack: NativeReadBack) {
  for (const className of fleetClasses) {
    if (!readBack.namespaces.includes(className))
      throw new Error(`The cutover did not create the ${className} namespace`);
    if (!readBack.applications.some((application) => application.className === className))
      throw new Error(`The cutover did not create the ${className} application`);
  }
  if (!readBack.namespaces.includes("PoolContainer"))
    throw new Error("The cutover lost the PoolContainer namespace");
}

export function nativeSteps(hooks: NativeHooks) {
  const record: NativeRecord = { scenario: "single-writer-native", steps: [], plans: {} };
  const step = async <T>(name: string, run: () => Promise<T>) => {
    const value = await run();
    record.steps.push(name);
    return value;
  };
  return {
    record,
    deploy: async () => {
      await step("0-baseline-without-fleet", hooks.deployBaseline);
      await step("0-baseline-readback", async () =>
        requireBaselineShape(await hooks.readBack("baseline")),
      );
    },
    seed: async () => {
      record.steps.push("seed-none");
    },
    smoke: async () => {
      const images = await step("1-fleet-images", hooks.fleetImages);
      await step("1-build", hooks.build);
      const plan = await step("1-plan", () => hooks.plan("cutover", images));
      record.plans.cutover = planHighlights(plan);
      await step("1-apply", () => hooks.apply(images));
      await step("1-readback", async () => requireCutoverShape(await hooks.readBack("cutover")));
      const again = await step("2-replan", () => hooks.plan("replan", images));
      record.plans.replan = planHighlights(again);
      return hooks.serve();
    },
  };
}
