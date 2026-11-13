import { DurableObject } from "cloudflare:workers";
import { BulkCoordinator, bulkObjectName, type BulkEnvironment } from "./bulk-coordinator.ts";

/** Standalone adapter for isolated worker fixtures; production reuses the artifacts coordinator. */
export class BulkUsageImport extends DurableObject<BulkEnvironment> {
  private coordinator: BulkCoordinator;
  constructor(ctx: DurableObjectState, env: BulkEnvironment) {
    super(ctx, env);
    this.coordinator = new BulkCoordinator(
      ctx,
      env,
      (job) => ctx.id.name === bulkObjectName(job),
      () => this.now(),
    );
  }
  protected now() {
    return Date.now();
  }
  fetch(request: Request) {
    return this.coordinator.handle(request);
  }
  alarm() {
    return this.coordinator.alarm();
  }
}
