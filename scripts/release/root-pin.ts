const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Why the root pin a release was given does not name what State records the root running, or
 * nothing when it does. The image is PoolContainer's `configuration.image`; the input is the
 * identity the controller knows the root by, PoolWorker's POOL_IMAGE_HASH. Once the root is pinned,
 * PoolContainer's own `hash.image` names the reference, not the build, so it is not compared.
 */
export function rootPinMismatch(
  pinVariable: string | undefined,
  rootRow: unknown,
  workerRow: unknown,
): string | undefined {
  let pin: unknown;
  try {
    pin = pinVariable ? JSON.parse(pinVariable) : undefined;
  } catch {
    return "POOL_ROOT_IMAGE is not JSON";
  }
  if (!record(pin)) return "POOL_ROOT_IMAGE is not set";
  const attr = record(rootRow) && record(rootRow.attr) ? rootRow.attr : {};
  const configuration = record(attr.configuration) ? attr.configuration : {};
  const props = record(workerRow) && record(workerRow.props) ? workerRow.props : {};
  const env = record(props.env) ? props.env : {};
  const image = typeof configuration.image === "string" ? configuration.image : undefined;
  const input = typeof env.POOL_IMAGE_HASH === "string" ? env.POOL_IMAGE_HASH : undefined;
  if (image === undefined || input === undefined)
    return "State records no root image or no POOL_IMAGE_HASH";
  if (pin.image === image && pin.input === input) return undefined;
  return `POOL_ROOT_IMAGE does not match State (image ${pin.image === image ? "equal" : "differs"} from PoolContainer's configuration.image, input ${pin.input === input ? "equal" : "differs"} from PoolWorker's POOL_IMAGE_HASH)`;
}
