import { ago, type VaultState, type Version } from "./model.ts";

const count = (files: number) => `${files.toLocaleString()} ${files === 1 ? "file" : "files"}`;

export function Summary({
  name,
  state,
  files,
  latest,
  now,
}: {
  readonly name: string;
  readonly state: VaultState;
  /** The walked vault; `complete` is false when a huge vault stopped the walk early. */
  readonly files: { readonly count: number; readonly complete: boolean } | null;
  readonly latest: Version | null;
  readonly now: number;
}) {
  const known = state.kind === "saved" ? files : null;
  const change = latest?.time === undefined ? null : `Last change ${ago(latest.time, now)}`;
  return (
    <section className="summary">
      <div className="min-w-0">
        <h1 className="vault-name">{name}</h1>
        <p className="health">
          <Status state={state} />
          {known !== null && (
            <span className="part">
              {known.complete ? count(known.count) : `${known.count.toLocaleString()}+ files`}
            </span>
          )}
          {change !== null && <span className="part">{change}</span>}
        </p>
        {state.kind === "importing" && (
          <div className="progress">
            <div className="bar">
              <i style={{ width: `${state.files ? (100 * state.confirmed) / state.files : 0}%` }} />
            </div>
            <p className="hint">
              Keep Obsidian open on the device that started the import until it finishes. It resumes
              if interrupted. Files show up below as they arrive.
            </p>
          </div>
        )}
      </div>
      <div className="devices">
        <h2>Devices</h2>
        <p className="hint">
          The devices syncing this vault, their last sync and Disconnect are on the Accounts tab.
        </p>
      </div>
    </section>
  );
}

function Status({ state }: { readonly state: VaultState }) {
  const [dot, label] =
    state.kind === "importing"
      ? ["busy", `Importing · ${state.confirmed} of ${count(state.files)}`]
      : ["ok", "Saved in Signalbox"];
  return (
    <span className="state">
      <span className={`dot ${dot}`} aria-hidden />
      {label}
    </span>
  );
}
