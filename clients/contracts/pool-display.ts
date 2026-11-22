import type { ConnectionView } from "./connection.ts";

/**
 * A device approved for tools only uses no pool, so the server's access answer names none: its
 * display carries the grant's pool id with an empty name. A device with models always gets its
 * pool's label. The view keeps the display after a disconnect, when its capabilities are gone.
 */
export const namesNoPool = (view: Pick<ConnectionView, "display"> | undefined): boolean =>
  view?.display?.pool.name === "";
