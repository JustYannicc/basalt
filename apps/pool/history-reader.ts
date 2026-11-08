import { control } from "./control.ts";
import type { PublicHistoryPage, PublicHistoryQuery } from "./history-contract.ts";

/** The public endpoint owns manager/member filtering; input never supplies a pool or caller. */
export function readPublicHistory(
  ctx: Parameters<typeof control>[0],
  { from, to, after }: PublicHistoryQuery,
) {
  const params = new URLSearchParams({ from, to });
  if (after !== undefined) params.set("after", JSON.stringify(after));
  return control<PublicHistoryPage>(ctx, `/usage/history?${params}`);
}
