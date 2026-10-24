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
   * The host's lifecycle, when it reports one. `issuing`: its link is out and
   * unclaimed. `revoking`: revoke started but hasn't finished, so it may still work.
   */
  readonly state?: ComputerState;
}

export type ComputerState = "issuing" | "active" | "revoking" | "revoked";

/** The person's own computers in the current pool. */
export interface ComputersView {
  readonly computers: readonly Computer[];
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
 * Green needs both: a real model request and a real tool call. Anything less is
 * still waiting, and the page says which half arrived. A revoke in flight is never green.
 */
export type ComputerStatus = "connected" | "model-only" | "tools-only" | "waiting" | "revoking" | "revoked";

export function computerStatus(computer: Computer): ComputerStatus {
  if (computer.state === "revoked" || computer.revokedAt) return "revoked";
  if (computer.state === "revoking") return "revoking";
  const model = computer.firstModelRequestAt !== null;
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
