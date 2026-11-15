// Native DO storage and dispatch enforce alarm ownership; only the container process is doubled.
export const runtimeAlarmWorkerd = `
import { PoolRuntimeBlue, PoolHomePeer } from './src/pool/worker.ts';
import { RuntimeWitnessStore } from './src/pool/runtime-slots/witness-store.ts';
import { runtimeConfiguration, configurationDigest } from './src/pool/runtime-slots/configuration.ts';
import { launchTokenHash } from './src/pool/launch-ledger.ts';
import { productionOpsRelease } from './.upstream/apps/hosted/cloud/src/implementation/production-ops-release.ts';
import { poolWorkerRevision } from './.upstream/apps/hosted/server/src/implementation/pool-worker-revision.ts';
export { PoolHomePeer };
const bootId='11111111-1111-1111-1111-111111111111';
function target(ctx) { return {format:'pool-runtime-slot-v1',controllerId:'a'.repeat(64),slotId:'alarm-runtime',
 applicationId:'blue',applicationVersion:'1',instanceId:ctx.id.toString(),imageDigest:'sha256:'+'b'.repeat(64),
 imageInput:'c'.repeat(16),homePeerOrdinal:1}; }
async function seed(ctx,env) {
 const t=target(ctx),configuration=runtimeConfiguration({...env,POOL_HOME_PEER_ORDINAL:'1'}),at=Date.now();
 const authorization={format:'pool-runtime-attestation-v1',kind:'initial-start',operationId:'alarm-proof',
 manifestDigest:'d'.repeat(64),controllerCode:{candidate:productionOpsRelease,workerInput:poolWorkerRevision},
 target:t,configurationFingerprint:await configurationDigest(configuration),
 selection:{expectedEpoch:0,active:null,policyDigest:'e'.repeat(64),revisions:[]},at,expiresAt:at+60000,
 provider:{accountId:'account',namespaceId:'namespace',applicationId:'blue',applicationVersion:'1',
 imageDigest:t.imageDigest,applicationConfigDigest:'a'.repeat(64),observationDigest:'b'.repeat(64),observedAt:at}};
 await new RuntimeWitnessStore(ctx.storage,env.POOL_DEPLOYMENT_KEY).create(authorization,configuration);
}
function synthetic() {
 let running=false,options,resolve;
 const stats={starts:0,keepAlive:0,health:0};
 return {stats,arm(){return new Promise(done=>{resolve=done})},stop(){running=false},
 container:{get running(){return running},start(value){options=value;stats.starts++;running=true},
 async destroy(){throw Error('Alarm must not destroy compute')},async monitor(){},
 async interceptOutboundHttp(){},async setInactivityTimeout(){stats.keepAlive++;resolve?.();},
 getTcpPort(port){if(port!==8318)throw Error('Wrong port');return {async fetch(){stats.health++;
 return Response.json({boot_id:bootId,started_at:'fixture-started'},{headers:{
 'X-Signalbox-Policy-Lease-Ms':'1500','X-Signalbox-Launch-Generation':options.env.POOL_LAUNCH_GENERATION,
 'X-Signalbox-Launch-Token-Sha256':await launchTokenHash(options.env.POOL_LAUNCH_TOKEN)}})}}}}};
}
export class Extra extends PoolRuntimeBlue {
 constructor(ctx,env){const state=synthetic();Object.defineProperty(ctx,'container',{value:state.container});
 super(ctx,env);this.fixture=state;this.state=ctx;ctx.blockConcurrencyWhile(()=>seed(ctx,env));}
 async fetch(request){const path=new URL(request.url).pathname;
 if(path==='/start')return super.fetch(new Request('http://runtime/start',{method:'POST',
 headers:{'content-type':'application/json'},body:JSON.stringify({target:target(this.state)})}));
 if(path==='/arm'){this.observed=this.fixture.arm();await this.state.storage.setAlarm(Date.now());return new Response('armed');}
 if(path==='/await'){await this.observed;}
 if(path==='/stop'){this.fixture.stop();await super.alarm();}
 return Response.json({...this.fixture.stats,alarm:await this.state.storage.getAlarm()});}
}
export default {fetch(request,env){return env.Extra.get(env.Extra.idFromName('alarm')).fetch(request)}};
`;
