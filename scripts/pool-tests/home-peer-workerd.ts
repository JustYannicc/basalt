// The native TCP port is synthetic; Root, endpoint, retained peer authority and upgrade hops are real.
export const homePeerWorkerd = `
import { DurableObject } from 'cloudflare:workers';
import { PoolContainer, PoolRuntimeBlue, PoolHomePeer as Peer, handlePoolWorkerRequest } from './src/pool/worker.ts';
import { RuntimeWitnessStore } from './src/pool/runtime-slots/witness-store.ts';
import { runtimeConfiguration, configurationDigest } from './src/pool/runtime-slots/configuration.ts';
import { HomePeerAccess, homePeerSourceKey } from './src/pool/runtime-slots/peer-access.ts';
import { launchStorageKey, launchTokenHash } from './src/pool/launch-ledger.ts';
const bootId = '11111111-1111-1111-1111-111111111111';
const operationId = '22222222-2222-2222-2222-222222222222';
const token = 'd'.repeat(64);
function environment(env) {
  return { ...env, PoolContainer: { jurisdiction: () => env.Root },
    PoolRuntimeBlue: { jurisdiction: () => env.Extra } };
}
async function fixtures(env) {
  const root = env.Root.idFromName('root').toString();
  const extra = env.Extra.idFromName('extra').toString();
  const legacy = { format:'pool-runtime-slot-v1',controllerId:root,slotId:'legacy',applicationId:'legacy',
    applicationVersion:'1',instanceId:root,imageDigest:'sha256:'+'a'.repeat(64),imageInput:'b'.repeat(16) };
  const target = { ...legacy,slotId:'extra',applicationId:'blue',instanceId:extra,homePeerOrdinal:1 };
  const configuration = runtimeConfiguration({ ...env, POOL_HOME_PEER_ORDINAL:'1' });
  const fingerprint = await configurationDigest(configuration);
  const witness = { operationId:'peer-proof',manifestDigest:'c'.repeat(64),target,
    configurationFingerprint:fingerprint,launch:{operationId,generation:1,tokenHash:await launchTokenHash(token)} };
  return { legacy,target,configuration,witness,
    runtimeSource:{kind:'runtime',witness},legacySource:{kind:'legacy',identity:{...legacy,bootId}} };
}
async function seed(ctx,env,extra) {
  const f = await fixtures(env);
  const target = extra ? f.target : f.legacy;
  const configuration = extra ? f.configuration : runtimeConfiguration(env);
  const authorization = { format:'pool-runtime-attestation-v1',kind:extra?'initial-start':'unattested-active',
    operationId:'peer-proof',manifestDigest:'c'.repeat(64),controllerCode:{candidate:'a'.repeat(40),workerInput:'b'.repeat(64)},
    target,configurationFingerprint:await configurationDigest(configuration),
    selection:{expectedEpoch:0,active:null,policyDigest:'c'.repeat(64),revisions:[]},at:1,expiresAt:60001,
    provider:{accountId:'account',namespaceId:'namespace',applicationId:target.applicationId,applicationVersion:'1',
      imageDigest:target.imageDigest,applicationConfigDigest:'a'.repeat(64),observationDigest:'b'.repeat(64),observedAt:1,
      ...(!extra?{instanceId:target.instanceId}:{})},...(!extra?{bootId}:{}) };
  const store = new RuntimeWitnessStore(ctx.storage,env.POOL_DEPLOYMENT_KEY);
  await store.create(authorization,configuration,extra?undefined:f.legacySource.identity);
  if(extra) {
    const {record}=await store.read(target);
    await store.put(target,{...record,witness:f.witness});
    await ctx.storage.put(launchStorageKey,{target:{controllerId:target.controllerId,instanceId:target.instanceId,
      applicationId:'blue',versionId:'1',imageHash:target.imageInput,imageDigest:target.imageDigest,releaseEpoch:'c'.repeat(64)},
      generation:1,operationId,token});
  } else {
    await ctx.storage.put('runtime-slots-v1:selection',{epoch:1,active:{target,identity:f.legacySource.identity,fenced:false}});
    await ctx.storage.put('runtime-fleet-v1:resources',[{target:f.target,phase:'warming',active:0,lastUsedAt:1}]);
  }
  await new HomePeerAccess(ctx,env.POOL_DEPLOYMENT_KEY,async()=>{}).retain(extra?f.runtimeSource:f.legacySource);
}
function container(extra) {
  return { running:true, start(){throw Error('Peer transport must never start compute')},
    async destroy(){throw Error('Peer transport must never destroy compute')},async setInactivityTimeout(){},
    async interceptOutboundHttp(host){if(host!=='home-peer.internal')throw Error('Wrong peer host')},
    getTcpPort(port){
      if(port===8318)return {async fetch(){return Response.json({boot_id:bootId,started_at:'2026-01-01T00:00:00Z'},
        {headers:{'X-Signalbox-Policy-Lease-Ms':'1500'}})}};
      if(port!==(extra?8329:8327))throw Error('Wrong Home port');
      return {connect(){const echo=new TransformStream();return {opened:Promise.resolve(),readable:echo.readable,
        writable:echo.writable,async close(){}}}};
    } };
}
export class PoolHomePeer extends Peer { constructor(ctx,env){super(ctx,environment(env));} }
export class Root extends DurableObject {
  constructor(ctx,env){super(ctx,env);Object.defineProperty(ctx,'container',{value:container(false)});
    ctx.blockConcurrencyWhile(async()=>{await seed(ctx,env,false);this.inner=new PoolContainer(ctx,environment(env));});}
  fetch(request){return this.inner.fetch(request);}
}
export class Extra extends DurableObject {
  constructor(ctx,env){super(ctx,env);Object.defineProperty(ctx,'container',{value:container(true)});
    ctx.blockConcurrencyWhile(async()=>{await seed(ctx,env,true);this.inner=new PoolRuntimeBlue(ctx,environment(env));});}
  fetch(request){return this.inner.fetch(request);}
  homePeerSource(target){return this.inner.homePeerSource(target);}
  assertHomePeer(source){return this.inner.assertHomePeer(source);}
}
export default {async fetch(request,env,ctx){
  const path=new URL(request.url).pathname;
  if(path==='/public')return handlePoolWorkerRequest(new Request('http://home-peer.internal/_internal/home-peer/route/0',request),environment(env));
  const f=await fixtures(env);const source=path==='/legacy-to-extra'?f.legacySource:f.runtimeSource;
  if(path==='/stale')source.witness.launch.generation++;
  if(path==='/missing-source')return env.Root.get(env.Root.idFromName('root')).fetch(new Request('http://home-peer.internal/_internal/home-peer/route/0',{headers:{Upgrade:'websocket'}}));
  const ordinal=path==='/legacy-to-extra'?1:0;
  // Source comes from the loopback binding, never the original request's headers.
  return ctx.exports.PoolHomePeer({props:{source}}).fetch(new Request('http://home-peer.internal/peer/'+ordinal,request));
} };
`;
