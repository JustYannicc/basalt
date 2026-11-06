/** A rejected external dependency call, with its original cause kept off the HTTP response. */
export class PoolDependencyFailure extends Error {
  readonly dependency: "storage" | "membership" | "signing";
  constructor(dependency: PoolDependencyFailure["dependency"], cause: unknown) {
    super(`Pool ${dependency} is unavailable`, { cause });
    this.dependency = dependency;
  }
}

/** Wrap only the external I/O promise, so failures in the surrounding work still escape. */
export async function poolDependency<A>(
  dependency: PoolDependencyFailure["dependency"],
  operation: Promise<A>,
): Promise<A> {
  try {
    return await operation;
  } catch (cause) {
    throw new PoolDependencyFailure(dependency, cause);
  }
}
