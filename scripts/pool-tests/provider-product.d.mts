import type { Effect } from "effect";
import type { HomeClient } from "../../src/pool/control.ts";
interface Reply {
  id: string;
  state: string;
  url: string;
  account: { id: string };
}
interface Product {
  origin: string;
  pool: string;
  prefix: string;
  actors: { organization: { id: string }; owner: { cookies: string; userId: string } };
  references: Map<string, string>;
  provider(lab: string): Promise<{ id: string }>;
  select(lab: string, id: string): Promise<void>;
  links(id: string): Promise<readonly { requirement: string; account: { id: string } }[]>;
  reconcile(lab: string, id: string): Promise<void>;
  appPath(id: string): string;
  request(method: string, path: string, input?: unknown): Effect.Effect<Reply, unknown>;
  run<A, E>(program: Effect.Effect<A, E>): Promise<A>;
}
export function withProviderProduct(
  home: HomeClient,
  work: (product: Product) => Promise<void>,
): Promise<void>;
