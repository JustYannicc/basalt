// Only platform ports and configured membership are synthetic; routing, endpoint checks and native DO fetch are real.
export const runtimeRouteWorkerd = `
import { DurableObject } from 'cloudflare:workers';
import { forwardPoolRequest } from './src/pool/forward.worker.ts';
import { RuntimeFleet } from './src/pool/runtime-fleet/controller.ts';
import { RuntimeFleetState } from './src/pool/runtime-fleet/state.ts';
import { RuntimeSlotRouter } from './src/pool/runtime-slots/router.ts';
import { RuntimeSlotStorage } from './src/pool/runtime-slots/storage.ts';
import { SlotStreams } from './src/pool/runtime-slots/streams.ts';
import { BoundSlotDriver, runtimeRequest } from './src/pool/runtime-slots/transport.ts';
import { RuntimeEndpoint } from './src/pool/runtime-slots/endpoint.ts';
import { RuntimeActivity } from './src/pool/runtime-slots/activity.ts';
import { RuntimeWitnessStore } from './src/pool/runtime-slots/witness-store.ts';
import { runtimeConfiguration, configurationDigest } from './src/pool/runtime-slots/configuration.ts';
import { NativeStreams } from './src/pool/native-streams.ts';
import { RuntimeProtection } from './src/pool/runtime-protection.ts';
import { nativeResponse } from './src/pool/native-response.worker.ts';
const marker='synthetic-private-exception-body';
const readEvents=[];
const info=console.info;
console.info=(name,value)=>{if(name==='POOL_RUNTIME_READ')readEvents.push(value);else info(name,value);};
const stall=(milliseconds=120)=>new Promise(resolve=>setTimeout(resolve,milliseconds));
const bootId='11111111-1111-1111-8111-111111111111';
const code={candidate:'a'.repeat(40),workerInput:'b'.repeat(64)};
function target(root,env,fault){return {format:'pool-runtime-slot-v1',controllerId:root,slotId:fault,
 applicationId:'blue',applicationVersion:'1',instanceId:env.Extra.idFromName(fault).toString(),
 imageDigest:'sha256:'+'a'.repeat(64),imageInput:'b'.repeat(16),homePeerOrdinal:1};}
function storage(ctx,fault){return {get:key=>ctx.storage.get(key),put:(key,value)=>ctx.storage.put(key,value),
 transaction:work=>fault==='acquire'?Promise.reject(Error(marker)):ctx.storage.transaction(work)};}
export class Root extends DurableObject {
 async fetch(request){
  const fault=new URL(request.url).searchParams.get('fault')??'healthy';
  const value=target(this.ctx.id.toString(),this.env,fault),identity={...value,bootId};
  await this.ctx.storage.put('runtime-fleet-v1:resources',[{target:value,identity,phase:'ready',active:0,lastUsedAt:1}]);
  await this.ctx.storage.put('runtime-fleet-v1:primary-active',fault==='primary'?0:1);
  await this.ctx.storage.put('runtime-slots-v1:selection',{epoch:1,active:{target:value,identity,fenced:fault==='selection'}});
  const slotStreams=new SlotStreams();
  const driver=new BoundSlotDriver(()=>({fetch:request=>{
   const headers=new Headers(request.headers);headers.set('X-Fixture-Fault',fault);
   return this.env.Extra.get(this.env.Extra.idFromString(value.instanceId)).fetch(new Request(request,{headers}));
  }}));
  if(new URL(request.url).pathname==='/probe')return driver.probeFetch(identity,new Request('http://private.invalid/capabilities?private='+marker),8327);
  const router=new RuntimeSlotRouter({controllerId:this.ctx.id.toString(),driver,
   storage:new RuntimeSlotStorage(storage(this.ctx,'')),streams:slotStreams,
   clock:{now:Date.now,monotonic:()=>performance.now()},defer:work=>this.ctx.waitUntil(work),wrap:nativeResponse});
  const fleet=new RuntimeFleet({state:new RuntimeFleetState(storage(this.ctx,fault),4),
   target:async()=>{throw Error('No growth in diagnostic fixture')},
   cell:()=>({selected:async()=>fault==='identity'?{...identity,bootId:'other-boot'}:identity,
    forward:(request,port,pool,before)=>router.forward(pool,request,port,async()=>request,before)}),
   legacyActive:async()=>1,currentRequests:()=>1,targetActive:100,idleMilliseconds:60000,maximum:1,
   enabled:()=>false,balancePrimary:true,defer:work=>this.ctx.waitUntil(work),wrap:nativeResponse,now:Date.now});
  const streams=new NativeStreams();
  const response=await forwardPoolRequest(request,fault==='missing-port'?undefined:8317,{
   env:this.env,computers:{observeUsage:async()=>{}},memberships:{configured:async()=>false},streams,
   lifecycle:Promise.resolve({warm:async()=>{throw Error('Must select ready extra')}}),
   protection:new RuntimeProtection(streams,{check:async()=>{throw Error('Unused primary health')},
    defer:work=>this.ctx.waitUntil(work),unavailable(){}}),
   route:(request,port,pool,legacy,before)=>fleet.forward(request,pool,()=>legacy(request),before),
   fetch:async()=>{throw Error('Must select ready extra')},defer:work=>this.ctx.waitUntil(work)});
  return response;
 }
}
export class Extra extends DurableObject {
 async fetch(request){
  const fault=request.headers.get('X-Fixture-Fault');
  if(fault==='invalid-metadata')return Response.json({error:'runtime-refused'},{status:409,headers:{'X-Signalbox-Runtime-Failure-Step':marker,'X-Signalbox-Runtime-Failure-Reason':marker}});
  if(new URL(request.url).pathname==='/calls')return Response.json({calls:this.calls??0});
  if(new URL(request.url).pathname==='/release-health'){this.releaseHealth?.();return new Response(null,{status:204});}
  if(new URL(request.url).pathname==='/health-cleaned'){await this.healthCleaned;return Response.json({cancelled:this.healthCancelled??0,aborted:this.healthSignal?.aborted??false});}
  if(new URL(request.url).pathname==='/read-state')return Response.json(await new RuntimeActivity(this.ctx.storage).inspect(this.readIdentity));
  if(new URL(request.url).pathname==='/clear-read-events'){readEvents.length=0;return new Response(null,{status:204});}
  if(new URL(request.url).pathname==='/read-events')return Response.json(readEvents);
  if(!this.inner){
   const input=request.headers.get('X-Signalbox-Runtime-Identity')?JSON.parse(request.headers.get('X-Signalbox-Runtime-Identity')):(await request.clone().json()).target;
   const identity={...input,bootId};
   const configuration=runtimeConfiguration({...this.env,POOL_HOME_PEER_ORDINAL:'1'});
   const fingerprint=await configurationDigest(configuration);
   const proof={format:'pool-runtime-attestation-v1',kind:'initial-start',operationId:'diagnostic',manifestDigest:'c'.repeat(64),
    controllerCode:code,target:input,configurationFingerprint:fingerprint,
    selection:{expectedEpoch:0,active:null,policyDigest:'c'.repeat(64),revisions:[]},at:1,expiresAt:60001,
    provider:{accountId:'account',namespaceId:'namespace',applicationId:'blue',applicationVersion:'1',
     imageDigest:input.imageDigest,applicationConfigDigest:'a'.repeat(64),observationDigest:'b'.repeat(64),observedAt:1}};
   const witness={operationId:'diagnostic',manifestDigest:'c'.repeat(64),target:input,configurationFingerprint:fingerprint,
    launch:{operationId:'22222222-2222-2222-8222-222222222222',generation:1,tokenHash:'d'.repeat(64)},bootId};
   const store=new RuntimeWitnessStore(this.ctx.storage,this.env.POOL_DEPLOYMENT_KEY);
   await store.create(proof,configuration,identity);
   const {record}=await store.read(input);await store.put(input,{...record,witness});
   this.readIdentity=identity;
   if(fault?.startsWith('read-')){const activity=new RuntimeActivity(this.ctx.storage);await activity.initialize(identity,true);await activity.acquire(identity);await activity.drain(identity);}
   Object.defineProperty(this.ctx,'container',{value:{running:true,async setInactivityTimeout(){if(fault?.startsWith('read-'))throw Error('Read must not warm compute');},
    start(){throw Error('No starts')},async destroy(){throw Error('No destroys')},getTcpPort:port=>{
     if(port===8318){
      if(fault==='port-lookup')throw Error(marker);
      return {fetch:async(_input,init)=>{
       if(fault==='read-timeout-headers'||fault==='read-timeout-body'){
        this.healthSignal=init.signal;
        let cleaned;this.healthCleaned=new Promise(resolve=>{cleaned=resolve});
        const headers={'X-Signalbox-Policy-Lease-Ms':'1500','X-Signalbox-Launch-Generation':'1','X-Signalbox-Launch-Token-Sha256':'d'.repeat(64)};
        const bytes=new TextEncoder().encode(JSON.stringify({boot_id:bootId,started_at:'2026-01-01T00:00:00Z'}));
        if(fault==='read-timeout-headers')await new Promise(resolve=>{const timer=setTimeout(resolve,2500);this.releaseHealth=()=>{clearTimeout(timer);resolve();}});
        let timer;
        return new Response(new ReadableStream({
         start:c=>{timer=setTimeout(()=>{c.enqueue(bytes);c.close();},2500);this.releaseHealth=()=>{clearTimeout(timer);c.enqueue(bytes);c.close();};},
         cancel:()=>{clearTimeout(timer);this.releaseHealth=undefined;this.healthCancelled=(this.healthCancelled??0)+1;cleaned();},
        }),{headers});
       }
       if(fault==='read-health-headers')await stall();
       if(fault==='read-health-body'){let timer;return new Response(new ReadableStream({start(c){timer=setTimeout(()=>{c.enqueue(new TextEncoder().encode(JSON.stringify({boot_id:bootId,started_at:'2026-01-01T00:00:00Z'})));c.close();},120);},cancel(){clearTimeout(timer);}}),{headers:{'X-Signalbox-Policy-Lease-Ms':'1500','X-Signalbox-Launch-Generation':'1','X-Signalbox-Launch-Token-Sha256':'d'.repeat(64)}});}
       return fault==='health'?new Response(marker,{status:503}):Response.json(
       {boot_id:fault==='boot'?'different-boot':bootId,started_at:'2026-01-01T00:00:00Z'},
       {headers:{'X-Signalbox-Policy-Lease-Ms':fault==='short-lease'?'100':'1500',
        'X-Signalbox-Launch-Generation':'1','X-Signalbox-Launch-Token-Sha256':'d'.repeat(64)}});}};
     }
     if(port===8329)return {fetch:async()=>{if(fault==='read-port-headers')await stall(1_200);return Response.json({caps:true});}};
     if(port!==8317)throw Error('Wrong model port');
     if(fault==='model-port-lookup')throw Error(marker);
     return {fetch:async()=>{this.calls=(this.calls??0)+1;if(fault==='model-port-dispatch')throw Error(marker);return Response.json({ok:true});}};
    }},configurable:true});
   this.inner=new RuntimeEndpoint(this.ctx,this.env,'runtime',code,nativeResponse);
  }
  if(!fault?.startsWith('read-'))return runtimeRequest(request,this.inner);
  const abort=new AbortController();const timer=setTimeout(()=>abort.abort(),fault.startsWith('read-timeout-')?12000:50);
  try{return await runtimeRequest(new Request(request,{signal:abort.signal}),this.inner);}finally{clearTimeout(timer);}
 }
}
export default {fetch(request,env){const fault=new URL(request.url).searchParams.get('fault')??'healthy';
 if(['/calls','/read-events','/clear-read-events','/read-state','/release-health','/health-cleaned'].includes(new URL(request.url).pathname))return env.Extra.get(env.Extra.idFromName(fault)).fetch(request);
 return env.Root.get(env.Root.idFromName(fault)).fetch(request);}};
`;
