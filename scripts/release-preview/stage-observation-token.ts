/**
 * The operator's two steps for a rehearsal lane's observation token (coordinator 18:33Z 20 Nov).
 * The deploy credential cannot mint tokens and the account's one Secrets Store is production's, so:
 *
 * - mint: the operator's Cloudflare connection creates `basalt-test-rehearsal-<N>-pool-provider-
 *   observation` with production's props (Workers Containers Read on the account, nothing else),
 *   proves it, pipes its value on stdin into the stage job's secret, and keeps only its id, privately.
 * - delete: removes that token by the recorded id, proves it gone with a list read, and deletes the
 *   job's secret. It runs in the same step that removes the lane's paid parts.
 *
 * The value never reaches a log, a file, or an agent's context: the program returns it only to this
 * process, which hands it to `gh secret set` on stdin and drops it.
 */
import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";

export const observationPermission = "cfd39eebc07c4e3ea849e4b3d2644637";
export const laneTokenName = (lane: number) =>
  `basalt-test-rehearsal-${lane}-pool-provider-observation`;
export const laneSecretName = (lane: number) => `REHEARSAL_OBSERVATION_TOKEN_${lane}`;

/** Runs one program on the operator's Cloudflare connection and returns its result to this process. */
export interface OperatorTransport {
  run(program: string): Promise<unknown>;
}

const requireLane = (lane: number) => {
  if (!Number.isInteger(lane) || lane < 1 || lane > 9)
    throw new Error("A rehearsal lane is 1 to 9");
  return lane;
};
const requireAccount = (accountId: string) => {
  if (!/^[a-f0-9]{32}$/u.test(accountId)) throw new Error("An account id is 32 hex characters");
  return accountId;
};

/** Refuses an existing token of that name, creates it, and proves its one policy before returning. */
export function mintProgram(accountId: string, lane: number) {
  const target = {
    accountId: requireAccount(accountId),
    name: laneTokenName(requireLane(lane)),
    permission: observationPermission,
  };
  return `async () => {
  const target = ${JSON.stringify(target)};
  const base = '/accounts/' + target.accountId;
  const request = async (options) => {
    const reply = await cloudflare.request(options);
    if (!reply || reply.success !== true) throw null;
    return reply.result;
  };
  try {
    const existing = (await request({method:'GET',path:base + '/tokens',query:{per_page:100}}) || [])
      .filter(row => row && row.name === target.name);
    if (existing.length) return {outcome:'refused_existing'};
    const created = await request({method:'POST',path:base + '/tokens',body:{name:target.name,
      policies:[{effect:'allow',permission_groups:[{id:target.permission}],
        resources:{['com.cloudflare.api.account.' + target.accountId]:'*'}}]}});
    if (!created || !/^[a-f0-9]{32}$/.test(created.id || '') || typeof created.value !== 'string')
      return {outcome:'unknown_create'};
    const actual = await request({method:'GET',path:base + '/tokens/' + created.id});
    const policy = actual && Array.isArray(actual.policies) && actual.policies.length === 1 && actual.policies[0];
    const owned = actual && actual.id === created.id && actual.name === target.name && policy &&
      policy.effect === 'allow' && policy.permission_groups.length === 1 &&
      policy.permission_groups[0].id === target.permission &&
      Object.keys(policy.resources || {}).length === 1 &&
      policy.resources['com.cloudflare.api.account.' + target.accountId] === '*';
    if (!owned) return {outcome:'refused_ownership', tokenId: created.id};
    return {outcome:'minted', tokenId: created.id, value: created.value};
  } catch {
    // Provider messages may echo a value. Never return any part of an exception.
    return {outcome:'unknown'};
  }
}`;
}

/** Deletes the recorded id only, then proves no token has that id or name. */
export function deleteProgram(accountId: string, lane: number, tokenId: string) {
  if (!/^[a-f0-9]{32}$/u.test(tokenId)) throw new Error("A token id is 32 hex characters");
  const target = {
    accountId: requireAccount(accountId),
    name: laneTokenName(requireLane(lane)),
    tokenId,
  };
  return `async () => {
  const target = ${JSON.stringify(target)};
  const base = '/accounts/' + target.accountId;
  const request = async (options) => {
    const reply = await cloudflare.request(options);
    if (!reply || reply.success !== true) throw null;
    return reply.result;
  };
  try {
    const before = (await request({method:'GET',path:base + '/tokens',query:{per_page:100}}) || []);
    const row = before.find(item => item && item.id === target.tokenId);
    if (row && row.name !== target.name) return {outcome:'refused_ownership'};
    if (row) await request({method:'DELETE',path:base + '/tokens/' + target.tokenId});
    const after = (await request({method:'GET',path:base + '/tokens',query:{per_page:100}}) || []);
    const left = after.filter(item => item && (item.id === target.tokenId || item.name === target.name));
    return {outcome: left.length ? 'still_present' : 'gone', present: left.length};
  } catch {
    return {outcome:'unknown'};
  }
}`;
}

type Spawn = typeof spawn;

/** `gh secret set <name>` with the value on stdin only; it is never an argument or a file. */
export function setJobSecret(name: string, value: string, run: Spawn = spawn) {
  return new Promise<void>((done, fail) => {
    const child = run("gh", ["secret", "set", name, "-R", "JustYannicc/basalt"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.once("error", fail);
    child.once("close", (code) =>
      code === 0 ? done() : fail(new Error(`gh secret set ${name} exited ${code}`)),
    );
    child.stdin?.end(value);
  });
}

export function deleteJobSecret(name: string, run: Spawn = spawn) {
  return new Promise<void>((done, fail) => {
    const child = run("gh", ["secret", "delete", name, "-R", "JustYannicc/basalt"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.once("error", fail);
    child.once("close", (code) =>
      code === 0 ? done() : fail(new Error(`gh secret delete ${name} exited ${code}`)),
    );
  });
}

/** One operator step: mint, prove, set the job's secret, keep the id privately. Prints no value. */
export async function mintLaneToken(input: {
  accountId: string;
  lane: number;
  record: string;
  transport: OperatorTransport;
  setSecret?: typeof setJobSecret;
}) {
  const reply = (await input.transport.run(mintProgram(input.accountId, input.lane))) as {
    outcome?: unknown;
    tokenId?: unknown;
    value?: unknown;
  } | null;
  const tokenId = typeof reply?.tokenId === "string" ? reply.tokenId : undefined;
  // The id is recorded whatever happened next, so a half-done mint can still be deleted by it.
  if (tokenId)
    await writeFile(input.record, `${JSON.stringify({ lane: input.lane, tokenId })}\n`, {
      mode: 0o600,
    });
  if (reply?.outcome !== "minted" || typeof reply.value !== "string" || !reply.value)
    return { outcome: String(reply?.outcome ?? "unknown"), recorded: Boolean(tokenId) };
  await (input.setSecret ?? setJobSecret)(laneSecretName(input.lane), reply.value);
  reply.value = null;
  return { outcome: "minted", recorded: true, secret: laneSecretName(input.lane) };
}

/** One operator step: delete by the recorded id, prove it gone, delete the job's secret. */
export async function deleteLaneToken(input: {
  accountId: string;
  lane: number;
  record: string;
  transport: OperatorTransport;
  deleteSecret?: typeof deleteJobSecret;
}) {
  const recorded = JSON.parse(await readFile(input.record, "utf8")) as {
    lane?: unknown;
    tokenId?: unknown;
  };
  if (recorded.lane !== input.lane || typeof recorded.tokenId !== "string")
    throw new Error("The record names another lane or no token");
  const reply = (await input.transport.run(
    deleteProgram(input.accountId, input.lane, recorded.tokenId),
  )) as { outcome?: unknown } | null;
  if (reply?.outcome !== "gone") return { outcome: String(reply?.outcome ?? "unknown") };
  await (input.deleteSecret ?? deleteJobSecret)(laneSecretName(input.lane));
  await rm(input.record, { force: true });
  return { outcome: "gone", secretDeleted: laneSecretName(input.lane) };
}
