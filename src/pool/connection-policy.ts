import { controlBasePath, type ProviderAppConnectionRequired } from "../../apps/pool/contract.ts";
import { ControlFailure } from "./json.ts";

class PoolConnectionRequired extends ControlFailure {
  private readonly app: string;
  constructor(app: string) {
    super(
      409,
      "ProviderAppConnectionRequired",
      "Connect this account on its provider app, then select the saved account in this pool.",
    );
    this.app = app;
  }
  override response(): ProviderAppConnectionRequired {
    return {
      error: "ProviderAppConnectionRequired",
      message: this.message,
      app: this.app,
      requirement: "subscriptions",
      // Only the host can resolve visible provider apps under the caller's current grants.
      destination: {
        kind: "unavailable",
        reason: "Open the provider app from the dashboard to connect an account.",
      },
    };
  }
}

export function refusePoolAcquisition(pool: string): never {
  throw new PoolConnectionRequired(pool);
}

export function isPoolAcquisitionPath(method: string, pathname: string): boolean {
  return [
    `POST ${controlBasePath}/sign-ins`,
    `POST ${controlBasePath}/login-files`,
    `POST ${controlBasePath}/sign-ins/callback`,
    `GET ${controlBasePath}/sign-ins/status`,
  ].includes(`${method} ${pathname}`);
}
