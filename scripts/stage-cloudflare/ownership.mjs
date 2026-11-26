// Which names an isolated test stage owns. The stage tools share the account with production, so
// ownership is checked twice: once here, when the caller names its prefix, and again on every
// resource before any call that reads or changes it.
//
// The release stack names what it deploys `basalt-<stage>-<id>` (basalt-production-poolworker,
// basalt-test-rehearsal-2-pool-runtime-blue) and its image repositories `basalt-<id>-<stage>`
// (basalt-poolcontainer-production). A stage prefix that holds none of the release stages' words,
// and does not start with a word the release stack's own names start with, can therefore own no
// release name. ownership.test.mjs derives those names from the stack's source and fails when a
// new one starts with a word missing here.
//
// These tables are frozen, so nothing at run time can register a prefix or drop a release word.
//
// Stages share the account with each other too. Only a registered prefix is a stage's, and no
// registered prefix continues another at a word boundary (basalt-route-scratch would own
// basalt-route-scratch-1-*), so two stages never own the same name.

/** Every stage tool's prefix: scale-180, test-emulated-upstream, test-route-scratch-1 and -2. */
export const STAGE_PREFIXES = Object.freeze([
  "basalt-180-scale",
  "basalt-emulated-upstream",
  "basalt-route-scratch-1",
  "basalt-route-scratch-2",
]);

/** Words of the release entry's stage names: production, preview-pr-N, test-pr-N, test-rehearsal-N. */
export const RELEASE_STAGE_WORDS = Object.freeze([
  "production",
  "preview",
  "staging",
  "test",
  "rehearsal",
  "pr",
]);
/** First words of the names the release stack and its operators give their resources. */
export const RELEASE_FIRST_WORDS = Object.freeze([
  "api",
  "app",
  "appoutbound",
  "apps",
  "appworkflows",
  "artifacts",
  "artifactscredentials",
  "artifactstokencoordinator",
  "catalog",
  "cloud",
  "developmentdatabase",
  "drive",
  "home",
  "legacy",
  "mcp",
  "migration",
  "placement",
  "pool",
  "poolcontainer",
  "poolruntimeblue",
  "poolruntimegreen",
  "poolworker",
  "provisioning",
  "publicsite",
  "release",
  "router",
  "runtime",
  "sql",
  "synthetic",
  "vault",
  "vaultattachments",
]);
const SHAPE = /^basalt(?:-[a-z0-9]+){2,}$/u;

/**
 * Whether production's own records use `name`: `basalt` itself, or a basalt- name whose first word
 * is a release stage's or one the release stack's names start with. ownership.test.mjs derives
 * every name the release stack and its tooling spell out, and every name it composes, from their
 * source and fails when one is not recognised here. No stage prefix starts like this, so a name
 * this accepts is never a stage's; the caller refuses one anyway, before anything is sent.
 */
export function isProductionName(name) {
  if (typeof name !== "string") return false;
  if (name === "basalt") return true;
  const [app, first] = name.split("-");
  return (
    app === "basalt" && (RELEASE_FIRST_WORDS.includes(first) || RELEASE_STAGE_WORDS.includes(first))
  );
}
const MAX_PREFIX = 48;

/** Release-style names a caller's predicate must refuse; they are never a stage's. */
export const releaseProbes = () =>
  ["production", "test-rehearsal-1", "test-pr-1", "preview-pr-1"].flatMap((stage) =>
    RELEASE_FIRST_WORDS.flatMap((id) => [
      `basalt-${id}`,
      `basalt-${stage}-${id}`,
      `basalt-${id}-${stage}`,
    ]),
  );

/** Why `prefix` cannot be a stage's, or undefined when it can. */
export function prefixRefusal(prefix) {
  if (typeof prefix !== "string" || !SHAPE.test(prefix) || prefix.length > MAX_PREFIX)
    return "a stage prefix is basalt- and at least two more lowercase words, at most 48 characters";
  const words = prefix.split("-").slice(1);
  const stageWord = words.find((word) => RELEASE_STAGE_WORDS.includes(word));
  if (stageWord) return `a stage prefix may not hold the release stage word ${stageWord}`;
  if (RELEASE_FIRST_WORDS.includes(words[0]))
    return `a stage prefix may not start like the release stack's ${words[0]} names`;
  if (!STAGE_PREFIXES.includes(prefix))
    return "a stage prefix is one of STAGE_PREFIXES, so no stage owns another's names";
  // A prefix that another registered one continues at a word boundary would own that stage's names.
  const overlapping = STAGE_PREFIXES.find(
    (other) =>
      other !== prefix && (other.startsWith(`${prefix}-`) || prefix.startsWith(`${other}-`)),
  );
  if (overlapping) return `a stage prefix may not overlap the registered stage ${overlapping}`;
  return undefined;
}

/**
 * The ownership test for one stage: a name starting with `<prefix>-` that `owns`, when given,
 * also accepts. Throws, before anything is called, on a prefix that could own a release name or a
 * predicate that accepts one.
 */
export function stageOwnership(prefix, owns) {
  const refused = prefixRefusal(prefix);
  if (refused) throw new Error(`Refused stage prefix: ${refused}`);
  if (owns !== undefined && typeof owns !== "function")
    throw new Error("Refused stage ownership: owns must be a function of a name");
  // A predicate that throws owns nothing, and what it threw is never shown: it may hold a secret.
  const accepts = (name) => {
    try {
      return owns(name) === true;
    } catch {
      return undefined;
    }
  };
  if (owns) {
    const answers = releaseProbes().map(accepts);
    if (answers.includes(undefined))
      throw new Error("Refused stage ownership: the predicate threw on a release stack's name");
    if (answers.includes(true))
      throw new Error("Refused stage ownership: the predicate accepts a release stack's name");
  }
  return (name) =>
    typeof name === "string" &&
    name.startsWith(`${prefix}-`) &&
    !isProductionName(name) &&
    (owns ? accepts(name) === true : true);
}
