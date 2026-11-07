import { object, query, string } from "apps";
import { readPublicHistory } from "./history-reader.ts";

/** The provisioned account supplies the pool token; the host supplies the current caller. */
export const publicHistory = query(
  {
    description:
      "Retained request metadata in a UTC range, with timestamp/id pagination. Managers see the pool; members see only their own requests. Request and response content is never returned.",
    input: object({
      from: string(),
      to: string(),
      after: object({ timestamp: string(), id: string() }).optional(),
    }),
  },
  readPublicHistory,
);
