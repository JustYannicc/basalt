import assert from "node:assert/strict";
import { generateKeyPairSync, createHash } from "node:crypto";
import { decryptArtifact } from "./artifact.ts";
import { productionOperation } from "./client.ts";
import { MemoryStorage } from "../pool-tests/sharing-fixture.ts";
import { removalSelection } from "../../src/pool/import-removal/contract.ts";
import { handleImportRemoval } from "../../src/pool/import-removal/http.ts";
import { ImportRemoval } from "../../src/pool/import-removal/operation.ts";

const pair = generateKeyPairSync("rsa", { modulusLength: 3072 });
const recipient = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const target = "https://127.0.0.1";
const secret = "ab".repeat(32);
export const selection = removalSelection({
  organization: "synthetic-organization",
  pool: "synthetic-pool",
  remove: ["1", "2", "3", "4"].map((id, index) => ({
    id: `${id.repeat(8)}-1111-4111-8111-${id.repeat(12)}`,
    provider: ["xai", "claude", "claude", "codex"][index],
  })),
  retain: { id: "55555555-1111-4111-8111-555555555555", provider: "codex" },
});

export function fixture() {
  const state = {
    credentials: selection.remove.map((row) => ({
      ...row,
      uuid: row.id,
      row: JSON.stringify({ ...row, version: 1, deleted: false }),
      disabled: true,
      deleted: false,
    })),
    memberships: selection.remove.map((row, index) => ({
      id: String(index + 1),
      credential: row.id,
      pool: "1",
      channel: `signalbox-pool-${selection.pool}`,
      row: JSON.stringify({ id: index + 1, credential: row.id, deleted: false }),
      deleted: false,
    })),
    retain: { ...selection.retain, sha256: "a".repeat(64) },
    database: "synthetic-database",
  };
  const storage = new MemoryStorage();
  const calls: string[] = [];
  let readyCalls = 0;
  let ready = async () => {
    readyCalls++;
  };
  let home = async (path: string, init: RequestInit) => {
    assert.equal(init.method, "DELETE");
    assert.ok(
      readyCalls > calls.length,
      "Every DELETE must finish readiness before its deadline starts",
    );
    const url = new URL(path, "http://127.0.0.1");
    const row = url.pathname.startsWith("/credentials")
      ? state.credentials.find((row) => row.id === url.searchParams.get("id"))
      : state.memberships.find(
          (row) =>
            row.id ===
            url.pathname
              .split("/")
              .filter((part) => part !== "conditional")
              .at(-1),
        );
    assert.ok(row);
    if (url.pathname.endsWith("/conditional")) {
      const expected = new Headers(init.headers).get("if-match");
      const actual = `"${createHash("sha256").update(row.row).digest("hex")}"`;
      if (expected !== actual)
        return Response.json({ error: "precondition_failed" }, { status: 412 });
    }
    calls.push(path);
    row.deleted = true;
    row.row = JSON.stringify({ ...JSON.parse(row.row), deleted: true, version: 2 });
    return Response.json({ status: "ok" });
  };
  const deps = {
    read: async () => structuredClone(state),
    ready: () => ready(),
    home: (path: string, init: RequestInit) => home(path, init),
    storage,
    secret,
    release: "synthetic-release",
    databaseOrigin: "synthetic-origin",
    now: () => Date.now(),
  };
  let operation = new ImportRemoval(deps);
  const invoke = (
    action = "migrate",
    extra: Partial<Parameters<typeof productionOperation>[0]> = {},
    signal?: AbortSignal,
  ) =>
    productionOperation(
      {
        target,
        signingKey: secret,
        selection: "home-agent-import-removal-v1",
        mode: "dry-run",
        request: JSON.stringify(selection),
        recipient,
        planSha256: "",
        go: "",
        action,
        ...extra,
      },
      async (_url, init) =>
        handleImportRemoval(
          new Request(target, { ...init, signal: signal ?? init?.signal }),
          operation,
          secret,
          target,
        ),
    );
  const approve = (previous: Record<string, unknown>) => {
    const artifact = previous.artifact;
    assert.ok(
      artifact &&
        typeof artifact === "object" &&
        "sha256" in artifact &&
        typeof artifact.sha256 === "string",
    );
    return { mode: "apply", previous, planSha256: artifact.sha256, go: `GO ${artifact.sha256}` };
  };
  const performHome = home;
  const prepare = (original: Record<string, unknown>) =>
    invoke("prepare", {
      selection: "home-agent-import-recovery-v1",
      previous: original,
      planSha256: approve(original).planSha256,
    });
  const resume = (prepared: Record<string, unknown>) =>
    invoke("migrate", { ...approve(prepared), selection: "home-agent-import-recovery-v1" });
  return {
    state,
    storage,
    calls,
    deps,
    invoke,
    approve,
    prepare,
    resume,
    performHome,
    decrypt: (value: unknown) => JSON.parse(decryptArtifact(value, privateKey, target)),
    setReady: (callback: typeof ready) => {
      ready = async () => {
        readyCalls++;
        await callback();
      };
    },
    setHome: (callback: typeof home) => {
      home = callback;
    },
    restart: () => {
      operation = new ImportRemoval(deps);
    },
  };
}
