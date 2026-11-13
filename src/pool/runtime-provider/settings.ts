/** Release admission and demand-driven starts compare the same complete application settings. */
export function runtimeApplicationSettings(application: {
  applicationName: string;
  configuration: unknown;
  instances?: number;
  maxInstances: number;
  schedulingPolicy: string;
  constraints?: unknown;
  affinities?: unknown;
  durableObjects?: unknown;
}) {
  return {
    applicationName: application.applicationName,
    configuration: application.configuration,
    instances: application.instances,
    maxInstances: application.maxInstances,
    schedulingPolicy: application.schedulingPolicy,
    constraints: application.constraints,
    affinities: application.affinities,
    durableObjects: application.durableObjects,
  };
}
