/**
 * REHEARSAL-ONLY overlay, never part of a production candidate. A `test-rehearsal-<1-9>` stage
 * binds its observation token as a plain Worker secret (`fleet-observation.ts`), because the
 * account's one Secrets Store is production's. The controller reads the token only through the
 * store binding's `{ get() }` shape, and `observeBoundProvider` refuses anything else, so the
 * controller's env presents that secret in the same shape. The value is the Worker's own deployed
 * secret, captured once when the object is constructed; changing a plain secret redeploys the
 * Worker and restarts the object, so it is never stale. Production's binding is the store object,
 * which passes through untouched, as does every other binding.
 */
export function rehearsalObservationEnv<Env extends object>(env: Env): Env {
  const token: unknown = Reflect.get(env, "POOL_PROVIDER_OBSERVATION_TOKEN");
  if (typeof token !== "string") return env;
  const binding = { get: async () => token };
  return new Proxy(env, {
    get: (target, key) =>
      key === "POOL_PROVIDER_OBSERVATION_TOKEN" ? binding : Reflect.get(target, key),
  });
}
