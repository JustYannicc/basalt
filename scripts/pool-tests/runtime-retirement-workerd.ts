// Platform destruction and provider inventory are synthetic; retirement and its independent proof join are real.
export const runtimeRetirementWorkerd = `
import { DurableObject } from 'cloudflare:workers';
import { PoolContainer } from './src/pool/worker.ts';
import { RuntimeFleet } from './src/pool/runtime-fleet/controller.ts';
import { RuntimeFleetState } from './src/pool/runtime-fleet/state.ts';
import { FleetHandoffCell } from './src/pool/runtime-fleet/cell.ts';
import { BoundSlotDriver, runtimeRequest } from './src/pool/runtime-slots/transport.ts';
import { RuntimeEndpoint } from './src/pool/runtime-slots/endpoint.ts';
import { RuntimeActivity } from './src/pool/runtime-slots/activity.ts';
import { RuntimeWitnessStore } from './src/pool/runtime-slots/witness-store.ts';
import { runtimeConfiguration, configurationDigest } from './src/pool/runtime-slots/configuration.ts';
import { RuntimeProviderReader } from './src/pool/runtime-provider/read.ts';
import { providerDigest } from './src/pool/runtime-provider/canonical.ts';
import { runtimeApplicationSettings } from './src/pool/runtime-provider/settings.ts';
import { decodeProviderApplication } from './src/pool/runtime-provider/application.ts';
const events=[],upkeepEvents=[];
const info=console.info;
console.info=(name,value)=>{if(name==='POOL_RUNTIME_RETIREMENT')events.push(value);else if(name==='POOL_RUNTIME_UPKEEP')upkeepEvents.push(value);else info(name,value);};
const code={candidate:'a'.repeat(40),workerInput:'b'.repeat(64)};
const bootId='11111111-1111-1111-8111-111111111111';
const marker='synthetic-private-retirement-error';
export class Root extends DurableObject {
 async setupCell(fault,ordinal=1){
  const raw=this.env.RAW_APPLICATION;
  this.target={format:'pool-runtime-slot-v1',controllerId:this.ctx.id.toString(),slotId:fault,
   applicationId:raw.id,applicationVersion:'1',instanceId:this.env.Extra.idFromName(fault).toString(),
   imageDigest:'sha256:'+'a'.repeat(64),imageInput:'b'.repeat(16),homePeerOrdinal:ordinal};
  this.identity={...this.target,bootId};
  const target=this.target,identity=this.identity;
  const extra=this.env.Extra.get(this.env.Extra.idFromName(fault));this.extra=extra;
  await extra.fetch('http://fixture/setup',{method:'POST',body:JSON.stringify({target:this.target,fault})});
  const application={accountId:raw.account_id,applicationId:raw.id,namespaceId:raw.durable_objects.namespace_id,
   applicationVersion:'1',imageDigest:this.target.imageDigest,
   applicationConfigDigest:await providerDigest(runtimeApplicationSettings(decodeProviderApplication(raw)))};
  const provider=new RuntimeProviderReader('synthetic-token',async(input)=>{
   const endpoint=await (await extra.fetch('http://fixture/state')).json();
   const instances=new URL(input).pathname.endsWith('instances-v2');
   const unknown=fault.endsWith('provider-unknown')&&!endpoint.actualRunning;
   this.inventory.push({kind:instances?'instances':'application',present:instances?(endpoint.actualRunning||fault.endsWith('provider-present')):undefined,status:unknown?403:200});
   if(unknown)return new Response(null,{status:403});
   return Response.json({success:true,errors:[],result:instances?
    ((endpoint.actualRunning||fault.endsWith('provider-present'))?[{id:target.instanceId,application_id:raw.id,status:{state:'running'},image:raw.configuration.image}]:[]):raw,
    result_info:{next_page_token:''}});
  });
  const driver=new BoundSlotDriver(()=>({fetch:request=>extra.fetch(
   ['held-destroy','held-report','held-body'].includes(fault)?new Request(request,{signal:new AbortController().signal}):request)}));
  this.cell=new FleetHandoffCell({handoff:{selected:async()=>identity},driver,admission:{},application,provider});
  return {target:this.target,identity:this.identity,extra,cell:this.cell};
 }
 async setup(fault){
  events.length=0;this.inventory=[];
  await this.setupCell(fault);
  this.state=new RuntimeFleetState(this.ctx.storage,4);
  await this.state.reserve(this.target);await this.state.dispatch(this.target);await this.state.ready(this.identity);
  await this.state.drain(this.identity);await this.state.acknowledgeDrain(this.identity);
  this.fleet=new RuntimeFleet({state:this.state,cell:()=>this.cell,target:async()=>{throw Error('No growth')},
   legacyActive:async()=>0,currentRequests:()=>0,targetActive:100,idleMilliseconds:60000,maximum:1,
   defer:work=>this.ctx.waitUntil(work),wrap:response=>response,now:Date.now,enabled:()=>false});
 }
 async fetch(request){
  const url=new URL(request.url),fault=url.searchParams.get('fault')??'healthy';
  this.initialized??=this.setup(fault);await this.initialized;
  if(url.pathname==='/release'){await this.extra.fetch('http://fixture/release');return new Response(null,{status:204});}
  let failed=false,result;
  try{if(url.pathname==='/observe')result=await this.cell.retired(this.identity);else await this.fleet.upkeep();}catch{failed=true;}
  const rows=await this.state.inspect();
  return Response.json({failed,result,phase:rows[0]?.phase??'retired',rows:rows.length,inventory:this.inventory,
   endpoint:await(await this.extra.fetch('http://fixture/state')).json(),events});
 }
}
export class AlarmRoot extends Root {
 async setupAlarm(){
  events.length=0;upkeepEvents.length=0;this.inventory=[];this.homeCalls=0;this.homeResolved=false;
  this.homeEntered=new Promise(resolve=>this.enteredHome=resolve);
  this.homeHeld=new Promise(resolve=>this.releaseHome=()=>{this.homeResolved=true;resolve();});
  this.finished=new Promise(resolve=>this.finish=resolve);
  this.state=new RuntimeFleetState(this.ctx.storage,4);
  this.cells=new Map();this.extras=[];
  for(let ordinal=1;ordinal<=2;ordinal++){
   const value=await this.setupCell('alarm-extra-'+ordinal,ordinal);
   this.cells.set(value.target.slotId,value.cell);this.extras.push(value);
   await this.state.reserve(value.target);await this.state.dispatch(value.target);await this.state.ready(value.identity);
  }
  this.reservations=[await this.state.acquire(1),await this.state.acquire(1)];
  for(const value of this.extras){await this.state.drain(value.identity);await this.state.acknowledgeDrain(value.identity);}
  this.runtimeFleet=new RuntimeFleet({state:this.state,cell:target=>this.cells.get(target.slotId),target:async()=>{throw Error('No growth')},
   legacyActive:async()=>0,currentRequests:()=>0,targetActive:100,idleMilliseconds:60000,maximum:2,
   defer:work=>this.ctx.waitUntil(work),wrap:response=>response,now:Date.now,enabled:()=>false});
  Object.defineProperty(this.ctx,'container',{value:{running:true,start(){throw Error('No root starts');},destroy(){throw Error('No root destroy');},
   monitor(){throw Error('No root monitor');},setInactivityTimeout(){throw Error('No root warming');},getTcpPort(){throw Error('No root probe');}},configurable:true});
  this.inner=new PoolContainer(this.ctx,{...this.env,TOOLS_SERVICE:{fetch:async()=>new Response(null,{status:403})}});
  this.inner.fleet={upkeep:async()=>{await this.runtimeFleet.upkeep();
   if((await this.state.inspect()).length)await this.inner.alarms.schedule('fleet',Date.now()+50);else this.finish();}};
  this.inner.homeUpkeep=async()=>{this.homeCalls++;this.enteredHome();await this.homeHeld;};
  await this.inner.alarms.schedule('home',Date.now()+50);
 }
 async alarm(){await this.inner.alarm();}
 async fetch(request){
  const path=new URL(request.url).pathname;
  this.initialized??=this.setupAlarm();await this.initialized;
  if(path==='/release-home'){this.releaseHome();return new Response(null,{status:204});}
  if(path==='/home-finished'){await this.inner.homeUpkeepTask;return Response.json({upkeepEvents});}
  if(path==='/ready'){await this.homeEntered;return Response.json({rows:await this.state.inspect()});}
  if(path==='/release-streams'){
   await Promise.all(this.reservations.map(value=>value.release()));
   await this.inner.alarms.schedule('home',Date.now()+30);
   await this.inner.alarms.schedule('fleet',Date.now()+50);return new Response(null,{status:204});
  }
  if(path==='/result'){
   let timeout;await Promise.race([this.finished,new Promise(resolve=>timeout=setTimeout(resolve,1500))]);clearTimeout(timeout);
   return Response.json({rows:await this.state.inspect(),homeCalls:this.homeCalls,homeResolved:this.homeResolved,
    deadlines:await this.inner.alarms.inspect(),endpoints:await Promise.all(this.extras.map(async value=>(await value.extra.fetch('http://fixture/state')).json())),events,upkeepEvents});
  }
  return new Response(null,{status:204});
 }
}
export class Extra extends DurableObject {
 async setup(input){
  this.target=input.target;this.identity={...input.target,bootId};this.fault=input.fault;this.running=!['no-intent','stale-no-intent'].includes(input.fault);this.actualRunning=this.running;
  if(input.fault==='stale-no-intent')this.running=true;this.monitorCalls=0;this.monitorCompleted=false;this.stopWaiters=[];
  this.destroyed=0;this.healthCalls=0;
  const configuration=runtimeConfiguration({...this.env,POOL_HOME_PEER_ORDINAL:'1'});
  const fingerprint=await configurationDigest(configuration);
  const authorization={format:'pool-runtime-attestation-v1',kind:'initial-start',operationId:'retirement',manifestDigest:'c'.repeat(64),
   controllerCode:code,target:input.target,configurationFingerprint:fingerprint,
   selection:{expectedEpoch:0,active:null,policyDigest:'c'.repeat(64),revisions:[]},at:1,expiresAt:60001,
   provider:{accountId:this.env.RAW_APPLICATION.account_id,namespaceId:this.env.RAW_APPLICATION.durable_objects.namespace_id,
    applicationId:input.target.applicationId,applicationVersion:'1',imageDigest:input.target.imageDigest,
    applicationConfigDigest:'a'.repeat(64),observationDigest:'b'.repeat(64),observedAt:1}};
  const store=new RuntimeWitnessStore(this.ctx.storage,this.env.POOL_DEPLOYMENT_KEY);
  await store.create(authorization,configuration,this.identity);const {record}=await store.read(input.target);
  await store.put(input.target,{...record,witness:{operationId:'retirement',manifestDigest:'c'.repeat(64),target:input.target,
   configurationFingerprint:fingerprint,launch:{operationId:'22222222-2222-2222-8222-222222222222',generation:1,tokenHash:'d'.repeat(64)},bootId}});
  const activity=new RuntimeActivity(this.ctx.storage);await activity.initialize(this.identity,true);await activity.drain(this.identity);
  const self=this;
  Object.defineProperty(this.ctx,'container',{value:{get running(){return self.running;},
   async setInactivityTimeout(){throw Error('Retirement must not warm');},start(){throw Error('No starts');},
   monitor:async()=>{self.monitorCalls++;self.monitorBeforeDestroy=self.actualRunning;
    if(self.actualRunning)await new Promise(resolve=>self.stopWaiters.push(resolve));
    if(self.fault==='stale-held-monitor')await self.hold();
    if(self.fault==='stale-failed-monitor'){self.running=false;throw Error(marker);}
    if(['stale-nonzero-monitor','stale-invalid-exit'].includes(self.fault)){self.running=false;throw Object.assign(Error(marker),{exitCode:self.fault==='stale-nonzero-monitor'?137:'137'});}
    if(self.fault==='stale-inconsistent-monitor')return;
    self.running=false;self.monitorCompleted=true;
   },
   async destroy(){self.destroyed++;self.actualRunning=false;
    if(!self.fault.startsWith('stale-'))self.running=false;
    self.stopWaiters.splice(0).forEach(resolve=>resolve());
    if(self.fault.endsWith('lost-destroy'))throw Error(marker);
    if(self.fault==='held-destroy')await self.hold();
   },getTcpPort(number){if(!self.actualRunning)throw Error('Must not probe stopped runtime');if(number!==8318)throw Error('Only readiness allowed');
    return {fetch:async()=>{self.healthCalls++;return Response.json({boot_id:bootId,started_at:'2026-01-01T00:00:00Z'},
     {headers:{'X-Signalbox-Policy-Lease-Ms':'1500','X-Signalbox-Launch-Generation':'1','X-Signalbox-Launch-Token-Sha256':'d'.repeat(64)}});}};
   }},configurable:true});
  this.endpoint=new RuntimeEndpoint(this.ctx,this.env,'runtime',code,response=>response);
 }
 hold(){return new Promise(resolve=>{const timer=setTimeout(resolve,6000);this.release=()=>{clearTimeout(timer);this.release=undefined;resolve();};});}
 async fetch(request){
  const path=new URL(request.url).pathname;
  if(path==='/setup'){await this.setup(await request.json());return new Response(null,{status:204});}
  if(path==='/state')return Response.json({running:this.running,actualRunning:this.actualRunning,destroyed:this.destroyed,healthCalls:this.healthCalls,monitorCalls:this.monitorCalls,monitorBeforeDestroy:this.monitorBeforeDestroy,monitorCompleted:this.monitorCompleted});
  if(path==='/release'){this.reportReleased=true;this.release?.();return new Response(null,{status:204});}
  if(path==='/retirement'&&this.fault==='held-report'&&!this.reportReleased)await this.hold();
  if(path==='/retirement'&&this.fault==='held-body'&&!this.reportReleased){
   const response=await runtimeRequest(request,this.endpoint);const body=await response.text();
   return new Response(new ReadableStream({start:controller=>{controller.enqueue(new TextEncoder().encode(body.slice(0,-1)));
    this.hold().then(()=>{try{controller.close();}catch{}});},cancel:()=>{this.release?.();}}),{headers:response.headers});
  }
  return runtimeRequest(request,this.endpoint);
 }
}
export default {fetch(request,env){const fault=new URL(request.url).searchParams.get('fault')??'healthy';const ns=fault==='alarm'?env.AlarmRoot:env.Root;return ns.get(ns.idFromName(fault)).fetch(request);}};
`;
