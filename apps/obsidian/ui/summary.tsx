import { ago, deviceLabels, type Devices, type VaultState, type Version } from "./model.ts";

const count = (files: number) => `${files} ${files === 1 ? "file" : "files"}`;

export function Summary({
  name,
  state,
  files,
  latest,
  devices,
  now,
}: {
  readonly name: string;
  readonly state: VaultState;
  readonly files: number | null;
  readonly latest: Version | null;
  readonly devices: Devices | null;
  readonly now: number;
}) {
  const known =
    state.kind === "up-to-date" || state.kind === "behind" || state.kind === "saved"
      ? (state.files ?? files)
      : null;
  const change = latest?.time === undefined ? null : `Last change ${ago(latest.time, now)}`;
  const labels = devices === null ? [] : deviceLabels(devices.devices);
  return (
    <section className="summary">
      <div className="min-w-0">
        <h1 className="vault-name">{name}</h1>
        <p className="health">
          <Status state={state} />
          {known !== null && <span className="part">{count(known)}</span>}
          {change !== null && <span className="part">{change}</span>}
        </p>
        {state.kind === "importing" && (
          <div className="progress">
            <div className="bar">
              <i style={{ width: `${state.files ? (100 * state.confirmed) / state.files : 0}%` }} />
            </div>
            <p className="hint">
              Keep Obsidian open on the device that started the import until it finishes. It
              resumes if interrupted. Files show up below as they arrive.
            </p>
          </div>
        )}
        {state.kind === "stuck" && (
          <div className="alert" role="status">
            <p>
              <b>
                The import is stuck at {state.confirmed} of {count(state.files)}.
              </b>{" "}
              {state.since === null
                ? "No device has synced yet."
                : `No device has synced since ${ago(state.since, now)}.`}
            </p>
            <p>
              Open Obsidian on the device that started it and choose Sync now in Signalbox Sync
              settings.
            </p>
          </div>
        )}
      </div>
      <div className="devices">
        <h2>Devices</h2>
        {devices !== null && devices.devices.length > 0 ? (
          devices.devices.map((device, index) => (
            <div className="device" key={device.connection}>
              <span className="device-name">{labels[index]}</span>
              <span className="device-when">
                {device.lastSyncAt === null ? "Not synced yet" : `Synced ${ago(device.lastSyncAt, now)}`}
              </span>
            </div>
          ))
        ) : (
          <p className="hint">
            Connected devices, and Disconnect, are on the Accounts tab.
            {devices === null && " Update Signalbox Sync to see device names and sync times here."}
          </p>
        )}
      </div>
    </section>
  );
}

function Status({ state }: { readonly state: VaultState }) {
  const [dot, label] =
    state.kind === "up-to-date"
      ? ["ok", "Up to date"]
      : state.kind === "behind"
        ? ["busy", "Syncing"]
        : state.kind === "importing"
          ? ["busy", `Importing · ${state.confirmed} of ${count(state.files)}`]
          : state.kind === "stuck"
            ? ["warn", "Needs attention"]
            : ["ok", "Saved in Signalbox"];
  return (
    <span className="state">
      <span className={`dot ${dot}`} aria-hidden />
      {label}
    </span>
  );
}
