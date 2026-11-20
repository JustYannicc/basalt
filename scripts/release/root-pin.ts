import { Data } from "effect";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A refusal of the root pin. Every field is public (`public-report.ts`), so each names what
 * differs and how State records the root in words, never a value.
 */
export class RootPinRefused extends Data.TaggedError("RootPinRefused")<{
  readonly check: "root-pin";
  readonly rule: string;
  readonly why: string;
  readonly fix: string;
}> {}
const refused = (rule: string, why: string, fix: string) =>
  new RootPinRefused({ check: "root-pin", rule, why, fix });

const REGISTRY = "registry.cloudflare.com";
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
// The characters the stack's declaration admits (`ImmutableImage`, src/pool/fleet-deployment.ts).
const REPOSITORY = /^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/u;
const PARTS_FIX =
  'Set POOL_ROOT_PIN to {"repository":"<repository>","digest":"sha256:<64 hex>","input":"<16 hex>"}: the repository and digest of PoolContainer\'s configuration.image, without the registry or the account, and PoolWorker\'s POOL_IMAGE_HASH.';

/**
 * The root pin the preflight and the stack read, as `{image, input}`. The repository variable
 * (`POOL_ROOT_PIN`) holds the repository, the digest and the build input; the account comes from
 * the deploy secret. Composed in the entry's own process, the full reference is never in the job's
 * env, a log or an artifact. Nothing set composes nothing.
 */
export function composeRootPin(parts: string | undefined, accountId: string | undefined) {
  if (!parts?.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(parts);
  } catch {
    parsed = undefined;
  }
  const { repository, digest, input } = record(parsed) ? parsed : {};
  if (
    !record(parsed) ||
    Object.keys(parsed).some((key) => !["repository", "digest", "input"].includes(key)) ||
    typeof repository !== "string" ||
    !REPOSITORY.test(repository) ||
    typeof digest !== "string" ||
    !DIGEST.test(digest) ||
    typeof input !== "string" ||
    !/^[a-f0-9]{16}$/u.test(input)
  )
    throw refused(
      "root-pin-malformed",
      "POOL_ROOT_PIN is not {repository, digest, input}.",
      PARTS_FIX,
    );
  // The variable is public: a repository carrying an account would print it. (The registry's dots
  // never pass the pattern.)
  if (/^[a-f0-9]{32}$/u.test(repository.split("/")[0]!))
    throw refused(
      "root-pin-malformed",
      "POOL_ROOT_PIN's repository starts with an account; the entry adds it.",
      PARTS_FIX,
    );
  if (!accountId)
    throw refused(
      "root-pin-no-account",
      "The root pin needs the deployment account, and this step has none.",
      "Run the entry with the CLOUDFLARE_ACCOUNT_ID secret.",
    );
  if (!/^[a-f0-9]{32}$/u.test(accountId))
    throw refused(
      "root-pin-bad-account",
      "The deployment account this step has is not 32 hex characters.",
      "Check the CLOUDFLARE_ACCOUNT_ID secret's value, for example for a trailing newline.",
    );
  return JSON.stringify({ image: `${REGISTRY}/${accountId}/${repository}@${digest}`, input });
}

/**
 * Puts the composed pin in this process's `POOL_ROOT_IMAGE`, where the preflight and the stack's
 * declaration read it. A pin also given whole is a second source, and refused.
 */
export function setRootPin(env: Record<string, string | undefined>) {
  const pin = composeRootPin(env.POOL_ROOT_PIN, env.CLOUDFLARE_ACCOUNT_ID);
  if (pin === undefined) return;
  if (env.POOL_ROOT_IMAGE)
    throw refused(
      "root-pin-ambiguous",
      "Both POOL_ROOT_PIN and POOL_ROOT_IMAGE are set.",
      "Set only POOL_ROOT_PIN.",
    );
  env.POOL_ROOT_IMAGE = pin;
}

/** How State records the root's image: by an immutable digest, by a tag, or not at all. */
const imageForm = (image: string | undefined) =>
  !image ? "absent" : /@sha256:[a-f0-9]{64}$/u.test(image) ? "by digest" : "by tag";

/** `<registry>/<account>`, the repository without a tag, and the digest of a reference. */
const imageParts = (image: string) => {
  const at = image.lastIndexOf("@");
  const name = at < 0 ? image : image.slice(0, at);
  const [registry = "", account = "", ...rest] = name.split("/");
  const path = rest.join("/");
  const tag = path.lastIndexOf(":");
  return {
    place: `${registry}/${account}`,
    repository: tag > path.lastIndexOf("/") ? path.slice(0, tag) : path,
    digest: at < 0 ? "" : image.slice(at + 1),
  };
};
const word = (same: boolean) => (same ? "equal" : "differs");

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
): RootPinRefused | undefined {
  let pin: unknown;
  try {
    pin = pinVariable ? JSON.parse(pinVariable) : undefined;
  } catch {
    return refused("root-pin-malformed", "The root pin is not JSON.", PARTS_FIX);
  }
  if (pin === undefined) return refused("root-pin-not-set", "The root pin is not set.", PARTS_FIX);
  if (!record(pin))
    return refused("root-pin-malformed", "The root pin is not a JSON object.", PARTS_FIX);
  const attr = record(rootRow) && record(rootRow.attr) ? rootRow.attr : {};
  const configuration = record(attr.configuration) ? attr.configuration : {};
  const props = record(workerRow) && record(workerRow.props) ? workerRow.props : {};
  const env = record(props.env) ? props.env : {};
  const image = typeof configuration.image === "string" ? configuration.image : undefined;
  const input = typeof env.POOL_IMAGE_HASH === "string" ? env.POOL_IMAGE_HASH : undefined;
  const form = imageForm(image);
  if (image === undefined || input === undefined)
    return refused(
      "root-pin-state-unreadable",
      `State records no root image or no POOL_IMAGE_HASH (State records the image ${form}; POOL_IMAGE_HASH ${input === undefined ? "absent" : "present"}).`,
      "Read PoolContainer's and PoolWorker's State rows before any release.",
    );
  if (pin.image === image && pin.input === input) return undefined;
  const pinned = imageParts(typeof pin.image === "string" ? pin.image : "");
  const recorded = imageParts(image);
  const parts =
    pin.image === image
      ? ""
      : ` (registry and account ${word(pinned.place === recorded.place)}, repository ${word(pinned.repository === recorded.repository)}, digest ${word(pinned.digest === recorded.digest)}; State records it ${form})`;
  return refused(
    "root-pin-differs",
    `The root pin does not match State: image ${word(pin.image === image)}${parts}, input ${word(pin.input === input)} from PoolWorker's POOL_IMAGE_HASH.`,
    PARTS_FIX,
  );
}
