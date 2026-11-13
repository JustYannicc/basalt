import { digest, secretName, tokenName, type BootstrapPlan } from "./contract.ts";

// This is the actual Cloudflare MCP program. Tests execute these same bytes, not a second adapter.
const body = String.raw`
  const target = plan.target;
  const secretName = TARGET_SECRET;
  const tokenName = TARGET_TOKEN;
  const marker = 'basalt-pool-observation-v1:' + target.operationId + ':';
  const base = '/accounts/' + target.accountId;
  const secretsPath = base + '/secrets_store/stores/' + target.storeId + '/secrets';
  const permission = 'cfd39eebc07c4e3ea849e4b3d2644637';
  let tokenId = plan.tokenId, phase = 'read', requests = 0;
  const result = outcome => ({tokenId, secretName, outcome});
  const stop = outcome => { throw {bootstrapOutcome:outcome}; };
  const request = async options => {
    if (++requests > 32 || Date.now() >= plan.expiresAt) stop('refused_inventory');
    const reply = await cloudflare.request(options);
    if (!reply || reply.success !== true || !Array.isArray(reply.errors) || reply.errors.length)
      throw null;
    return reply;
  };
  const list = async (path, query) => {
    const all = [];
    for (let page = 1; page <= 10; page++) {
      const reply = await request({method:'GET',path,query:{...query,page,per_page:100}});
      if (!Array.isArray(reply.result)) stop('refused_inventory');
      all.push(...reply.result);
      const info = reply.result_info;
      if (info && Number.isInteger(info.total_pages)) {
        if (info.total_pages === 0 && page === 1 && reply.result.length === 0 &&
            (info.total_count === undefined || info.total_count === 0)) return all;
        if (info.total_pages < page || (info.page !== undefined && info.page !== page))
          stop('refused_inventory');
        if (page === info.total_pages) return all;
      } else if (reply.result.length < 100) {
        if (info && Number.isInteger(info.total_count) && info.total_count > all.length)
          stop('refused_inventory');
        return all;
      }
    }
    stop('refused_inventory');
  };
  const owned = row => {
    if (!row || !/^[a-f0-9]{32}$/.test(row.id || '') || row.name !== tokenName ||
        row.status !== 'active' || (row.condition &&
          (typeof row.condition !== 'object' || Array.isArray(row.condition) || Object.keys(row.condition).length)) ||
        row.expires_on || row.not_before ||
        !Array.isArray(row.policies) || row.policies.length !== 1) return false;
    const policy = row.policies[0];
    return policy.effect === 'allow' && Array.isArray(policy.permission_groups) &&
      policy.permission_groups.length === 1 && policy.permission_groups[0].id === permission &&
      policy.resources && Object.keys(policy.resources).length === 1 &&
      policy.resources['com.cloudflare.api.account.' + target.accountId] === '*';
  };
  const ownedSecret = (row, id) => row && row.store_id === target.storeId &&
    row.name === secretName && row.comment === marker + id &&
    row.status === 'active' && Array.isArray(row.scopes) &&
    row.scopes.length === 1 && row.scopes[0] === 'workers' &&
    /^[a-f0-9]{32}$/.test(row.id || '');
  try {
    if (accountId !== target.accountId || plan.version !== 1 ||
        !['create','inspect','rotate','revoke'].includes(plan.mode) ||
        !Number.isSafeInteger(plan.expiresAt) || Date.now() >= plan.expiresAt ||
        plan.expiresAt > Date.now() + 600000 ||
        (['rotate','revoke'].includes(plan.mode) && !/^[a-f0-9]{32}$/.test(tokenId || '')))
      return result('refused_target');
    const store = (await request({method:'GET',path:base + '/secrets_store/stores/' + target.storeId})).result;
    if (!store || store.id !== target.storeId || store.name !== 'default_secrets_store' ||
        (store.account_id !== undefined && store.account_id !== target.accountId))
      return result('refused_target');
    const allTokens = await list(base + '/tokens', {});
    const tokens = allTokens.filter(row => row.name === tokenName);
    const secrets = (await list(secretsPath,{search:secretName})).filter(row => row.name === secretName);
    if (tokens.length > 1 || secrets.length > 1) return result('refused_inventory');
    const token = tokens[0], secret = secrets[0];
    if (plan.mode === 'create') {
      if (secret || allTokens.some(row => row.name === secretName ||
          (typeof row.name === 'string' && row.name.startsWith('basalt-' + target.stage + '-pool-observation-'))))
        return result('refused_existing');
      phase = 'create';
      const created = (await request({method:'POST',path:base + '/tokens',body:{
        name:tokenName,policies:[{effect:'allow',permission_groups:[{id:permission}],
          resources:{['com.cloudflare.api.account.' + target.accountId]:'*'}}]
      }})).result;
      if (!created || !/^[a-f0-9]{32}$/.test(created.id || '')) return result('unknown_create');
      tokenId = created.id;
      if (typeof created.value !== 'string' || !created.value) return result('unknown_create');
      const actual = (await request({method:'GET',path:base + '/tokens/' + tokenId})).result;
      if (!owned(actual) || actual.id !== tokenId) return result('refused_ownership');
      phase = 'store';
      const saved = (await request({method:'POST',path:secretsPath,body:[{
        name:secretName,value:created.value,scopes:['workers'],comment:marker + tokenId
      }]})).result;
      created.value = null;
      if (!Array.isArray(saved) || saved.length !== 1 || !ownedSecret(saved[0],tokenId))
        return result('unknown_store');
      return result('stored');
    }
    if (!token) {
      if (plan.mode === 'revoke' && tokenId &&
          !allTokens.some(row => row.id === tokenId) && (!secret || ownedSecret(secret,tokenId)))
        return result('revoked');
      if (secret) return result('refused_ownership');
      return result('absent');
    }
    const actual = (await request({method:'GET',path:base + '/tokens/' + token.id})).result;
    if (!owned(actual) || actual.id !== token.id || (tokenId !== null && actual.id !== tokenId))
      return result('refused_ownership');
    tokenId = actual.id;
    if (secret && !ownedSecret(secret,tokenId)) return result('refused_ownership');
    if (plan.mode === 'inspect') return result(secret ? 'stored' : 'owned_token');
    if (plan.mode === 'revoke') {
      phase = 'revoke';
      await request({method:'DELETE',path:base + '/tokens/' + tokenId});
      return result('revoked');
    }
    phase = 'rotate';
    const rotated = (await request({method:'PUT',path:base + '/tokens/' + tokenId + '/value'})).result;
    if (typeof rotated !== 'string' || !rotated) return result('unknown_rotate');
    phase = 'store';
    const saved = (await request(secret ? {
      method:'PATCH',path:secretsPath + '/' + secret.id,
      body:{value:rotated,scopes:['workers'],comment:marker + tokenId}
    } : {method:'POST',path:secretsPath,body:[{
      name:secretName,value:rotated,scopes:['workers'],comment:marker + tokenId
    }]})).result;
    const row = Array.isArray(saved) && saved.length === 1 ? saved[0] : saved;
    return result(ownedSecret(row,tokenId) ? 'stored' : 'unknown_store');
  } catch (error) {
    // Provider messages may echo the submitted value. Never return any part of an exception.
    if (error && ['refused_inventory'].includes(error.bootstrapOutcome))
      return result('refused_inventory');
    return result('unknown_' + phase);
  }
`;

export function bootstrapProgram(plan: BootstrapPlan) {
  return `async () => {\nconst plan = ${JSON.stringify(plan)};\n${body
    .replace("TARGET_SECRET", JSON.stringify(secretName(plan.target)))
    .replace("TARGET_TOKEN", JSON.stringify(tokenName(plan.target)))}\n}`;
}
export const programDigest = (plan: BootstrapPlan) => digest(bootstrapProgram(plan));
