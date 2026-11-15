import type { SeriesDimension } from "./series-contract.ts";

const dimensionColumns = {
  account: "saved_account",
  person: "CASE WHEN attribution = 'import-owner' THEN NULL ELSE person END",
  model: "model",
  provider: "provider",
  app: "app_id",
  attribution: "attribution",
  source: "source",
};

/** Group the exact public key values before paying for JSON serialization. */
export function seriesGrouping(by: readonly SeriesDimension[]) {
  const fields = [
    { name: "currency", value: "CASE WHEN counts_only THEN NULL ELSE currency END" },
    ...by.map((dimension) => ({
      name: dimension,
      value:
        dimension === "account"
          ? "saved_account"
          : `CASE WHEN counts_only THEN NULL ELSE ${dimensionColumns[dimension]} END`,
    })),
  ];
  if (by.includes("person") && !by.includes("attribution"))
    fields.push({
      name: "attribution",
      value:
        "CASE WHEN NOT counts_only AND attribution = 'import-owner' THEN 'import-owner' ELSE NULL END",
    });
  const hasAccount = by.includes("account");
  const columns = fields.map((_, index) => `key_${index}`);
  const key = fields.flatMap((field, index) => [`'${field.name}'`, columns[index]!]);
  const projection = fields.map(
    (field, index) => `(${field.value}) COLLATE "C" AS ${columns[index]}`,
  );
  if (!hasAccount) {
    // Redacted totals retain an account key even when account was not requested.
    columns.push("key_has_account", "key_redacted_account");
    projection.push(
      "counts_only AS key_has_account",
      '(CASE WHEN counts_only THEN saved_account ELSE NULL END) COLLATE "C" AS key_redacted_account',
    );
  }
  const fullKey = `jsonb_build_object(${key.join(", ")})`;
  return {
    projection: projection.join(",\n      "),
    columns: columns.join(", "),
    key: hasAccount
      ? fullKey
      : `CASE WHEN key_has_account THEN ${fullKey} || jsonb_build_object('account', key_redacted_account) ELSE ${fullKey} END`,
  };
}
