export interface PriceTarget {
  readonly provider: string;
  readonly model: string;
}

function withoutDate(model: string): string {
  const date = /-(20\d{2})-?(\d{2})-?(\d{2})$/.exec(model);
  if (!date) return model;
  const iso = `${date[1]}-${date[2]}-${date[3]}`;
  const parsed = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().startsWith(iso)
    ? model.slice(0, date.index)
    : model;
}

/** Home tries exact identities before these spelling/date fallbacks. Never guess a model family. */
export function priceAliases(targets: readonly PriceTarget[]) {
  return [...new Set(targets.map((target) => target.model))].flatMap((model) => {
    const bare = model.slice(model.lastIndexOf("/") + 1);
    const undated = withoutDate(bare);
    const candidates = [undated];
    if (/^claude-/i.test(undated)) candidates.push(undated.replace(/(?<=\d)\.(?=\d)/g, "-"));
    const sourceModels = [...new Set(candidates)].filter((candidate) => candidate !== bare);
    return sourceModels.length ? [{ target_model: model, source_models: sourceModels }] : [];
  });
}
