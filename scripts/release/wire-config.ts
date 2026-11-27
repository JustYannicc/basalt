/**
 * The parts of a release run's wire guard configuration the entry derives from State and the
 * command (deploy.ts), kept pure so tests hold them to the guard itself.
 */

/** A container application as its State row records it. */
export interface RecordedApplication {
  readonly id: string;
  readonly name?: string | undefined;
}

/**
 * The applications the run's guard holds. The root is held by its own id and name, and only the
 * root's pair tells the guard it knows the root (`rootRequired`). The policy's held applications
 * sit beside it, never in the root's lists: a held name must not stand in for the root's.
 */
export function wireHolds(
  root: RecordedApplication | undefined,
  held: ReadonlyArray<RecordedApplication | undefined>,
) {
  return {
    rootApplications: root ? [root.id] : [],
    rootApplicationNames: root?.name ? [root.name] : [],
    heldApplications: held.flatMap((application) =>
      application
        ? [
            application.name
              ? { id: application.id, name: application.name }
              : { id: application.id },
          ]
        : [],
    ),
  };
}

/** Commands that only read production: the guard refuses anything but reads while they run. */
export const readOnlyRun = (stage: string, command: string, digest: string | undefined) =>
  stage === "production" &&
  (["plan", "preflight", "snapshot", "serving"].includes(command) ||
    // A repair without the reviewed digest only plans the repair.
    (command === "repair" && !digest));
