import type { ContainerAttributes } from "./application.ts";

/** Release admission and demand-driven starts compare the same complete application settings. */
export function runtimeApplicationSettings(application: ContainerAttributes) {
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
