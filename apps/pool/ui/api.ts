import { json, type Schema } from "apps";
import { createAppClient, mutationReference, queryReference } from "apps/client";
import type {
  addLoginFile,
  cancelSignIn,
  finishSignIn,
  removeAccount,
  Result,
  signInStatus,
  startSignIn,
  view,
} from "../index.ts";
import { productName } from "../deployment.ts";
import type { LoginFileAdded, PoolView, SignInStarted, SignInStatus } from "../contract.ts";

const client = createAppClient();
// The server shapes each result as the contract describes; the page reads it as that.
const result = <T>() => json() as unknown as Schema<Result<T>, boolean>;

function read<T>(promise: Promise<Result<T>>): Promise<Result<T>> {
  return promise.catch(() => ({
    ok: false,
    error: "backend_unavailable",
    message: `${productName} couldn't reach your pool. Try again.`,
  }));
}

export const pool = {
  view: () => read(client.query(queryReference<typeof view>("view"), {}, result<PoolView>())),
  start: (provider: string) =>
    read(client.mutate(mutationReference<typeof startSignIn>("startSignIn"), { provider }, result<SignInStarted>())),
  finish: (session: string, redirectUrl: string) =>
    read(client.mutate(mutationReference<typeof finishSignIn>("finishSignIn"), { session, redirectUrl }, result<SignInStatus>()),
    ),
  status: (session: string) =>
    read(client.query(queryReference<typeof signInStatus>("signInStatus"), { session }, result<SignInStatus>())),
  cancel: (session: string) =>
    read(client.mutate(mutationReference<typeof cancelSignIn>("cancelSignIn"), { session }, result<null>())),
  addLoginFile: (file: unknown) =>
    read(client.mutate(mutationReference<typeof addLoginFile>("addLoginFile"), { file: file as never }, result<LoginFileAdded>()),
    ),
  remove: (id: string) =>
    read(client.mutate(mutationReference<typeof removeAccount>("removeAccount"), { id }, result<null>())),
};

export type PoolApi = typeof pool;
