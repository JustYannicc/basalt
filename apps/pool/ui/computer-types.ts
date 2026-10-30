// What the computers list and the setup dialog need from the pool app.
// Structural on purpose: the page never imports the server, and it never sees a
// computer's model key or tools token. Those only travel behind the one-time link.

/** One computer the signed-in person set up, bound to the pool chosen for it. */
export interface Computer {
  readonly id: string;
  /** The person's own name for it, such as "Work laptop". */
  readonly name: string;
  readonly poolId: string;
  /** ISO time the computer was created. */
  readonly createdAt: string;
  /** ISO time its first real model request reached the pool, or null. */
  readonly firstModelRequestAt: string | null;
  /** ISO time its first real tool call reached the tools service, or null. */
  readonly firstToolCallAt: string | null;
  /** ISO time it was revoked, or null while it still works. */
  readonly revokedAt: string | null;
  /**
   * ISO time its model key was deleted because the person lost access to its pool, or null.
   * Its tools token stays theirs until they revoke the computer.
   */
  readonly removedAt?: string | null;
  /**
   * The host's lifecycle, when it reports one. `issuing`: its link is out and
   * unclaimed. `revoking`: revoke started but hasn't finished, so it may still work.
   * `removed`: the person lost access to its pool, so its model requests fail.
   */
  readonly state?: ComputerState;
  /** False for a computer set up for models only. Absent from hosts that predate the choice. */
  readonly tools?: boolean;
  /** Its setup link lapsed unclaimed, so it can never be set up. */
  readonly lapsed?: true;
}

export type ComputerState = "issuing" | "active" | "revoking" | "revoked" | "removed";

/** A pool the person can point a computer at: their own, or one shared with them. */
export interface PoolChoice {
  readonly id: string;
  /** The pool app's name, such as "Ada's pool". */
  readonly name: string;
  /** True for the person's own pool. */
  readonly mine: boolean;
}

/** The person's own computers, in every pool they can use. */
export interface ComputersView {
  readonly computers: readonly Computer[];
  /** Every pool this person can pick for a computer. Absent from hosts that can't switch. */
  readonly pools?: readonly PoolChoice[];
  /** The undo paste. It removes exactly the marked entries and restores the backups. */
  readonly undoPrompt: string;
}

/** A fresh one-time setup link for one computer, and everything that carries it. */
export interface SetupLink {
  readonly computerId: string;
  /** The short paste for the agent. It holds the one-time link, never a key. */
  readonly prompt: string;
  /** ISO time the link stops working. */
  readonly expiresAt: string;
  /** One line for macOS and Linux shells that fetches the same instructions. */
  readonly command: string;
  /** The same for Windows PowerShell. */
  readonly powershellCommand: string;
  readonly undoPrompt: string;
}

/** Same shape as the pool API's own results, so its calls fit without adapting. */
export type ComputerResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string; readonly message: string };

/** Reading and revoking. Works wherever the list is mounted. */
export interface ComputersApi {
  computers: () => Promise<ComputerResult<ComputersView>>;
  /** Its next request fails. */
  revoke: (computerId: string) => Promise<ComputerResult<null>>;
  /**
   * Points the computer's existing key at another of the person's pools. Nothing changes on the
   * computer; its next request uses the new pool. Hosts that can't switch leave it out.
   */
  switchPool?: (computerId: string, pool: string) => Promise<ComputerResult<Computer>>;
  /**
   * Schedules the list's refresh while someone sees it. Without it the list refreshes while the
   * browser tab is visible, which a page hidden behind its host's other tabs still is.
   */
  poll?: (refresh: () => void, interval: number) => () => void;
}

/** What a person reads for a pool: their own is "Your pool" whatever it's named. */
export function poolLabel(pool: PoolChoice): string {
  return pool.mine ? "Your pool" : pool.name.trim() || "Shared pool";
}

/** Minting links. Only a host that can mint the tools token implements this. */
export interface SetupApi {
  /** Creates the computer in the chosen pool and its first link. Pasting it is the consent. */
  createSetup: (name: string) => Promise<ComputerResult<SetupLink>>;
  /**
   * Rotates a link that is still unclaimed and unexpired. Any other computer gets a
   * 409 whose message says to revoke it and set up a new one; never a silent replacement.
   */
  refreshSetup: (computerId: string) => Promise<ComputerResult<SetupLink>>;
}

/**
 * How the list starts a setup: in a dialog right here, or by sending the person to
 * the page that can mint links. `href` gets the computer whose unclaimed link to
 * rotate, else undefined, and opens from the person's own click so no popup blocker stops it.
 */
export type SetupMode =
  | { readonly kind: "dialog"; readonly api: SetupApi }
  | { readonly kind: "link"; readonly href: (computer: Computer | undefined) => string; readonly manageHref?: (computer: Computer) => string };

/**
 * Green needs a real model request and, unless it was set up for models only, a real tool call.
 * Anything less is still waiting, and the page says which half arrived. A revoke in flight is never green.
 */
export type ComputerStatus = "connected" | "model-only" | "tools-only" | "waiting" | "revoking" | "revoked" | "removed";

export function computerStatus(computer: Computer): ComputerStatus {
  if (computer.state === "revoked" || computer.revokedAt) return "revoked";
  if (computer.state === "revoking") return "revoking";
  if (computer.state === "removed" || computer.removedAt) return "removed";
  const model = computer.firstModelRequestAt !== null;
  // A models-only computer never makes a tool call, so its model request is the whole proof.
  if (computer.tools === false) return model ? "connected" : "waiting";
  const tools = computer.firstToolCallAt !== null;
  if (model && tools) return "connected";
  if (model) return "model-only";
  if (tools) return "tools-only";
  return "waiting";
}

/** Only an unclaimed link can be rotated. Without a host state, no evidence yet means unclaimed. */
export function canRefresh(computer: Computer): boolean {
  if (computer.state) return computer.state === "issuing";
  return computerStatus(computer) === "waiting";
}

export const nameLimit = 60;
