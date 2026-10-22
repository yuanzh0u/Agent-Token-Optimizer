import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {UsageLedger,normalizeUsage} from '../../../packages/openclaw-token-efficiency/src/index.mjs';

const mapping={fields:{input:'usage.input',output:'usage.output',cacheRead:'usage.cacheRead',cacheWrite:'usage.cacheWrite'},inputIncludesCacheRead:false,inputIncludesCacheWrite:false,metadata:{provider:'provider',model:'model',sessionId:'sessionId',runId:'runId'}};
const partial='llm_output attempt aggregate; no stable provider billing/request identity; delivery UUID is not a provider request ID';

/** Resources belong only to a full-mode service generation, never discovery. */
export function registerObserver(api){
 const settings=api.pluginConfig??{},life=api.lifecycle;
 if(settings.conversationAccess!==true||!life?.signal||typeof life.signal.addEventListener!=='function'||typeof life.signal.aborted!=='boolean'||typeof life.onDispose!=='function'||life.signal.aborted)return;
 const capacity=settings.queueCapacity??128;
 if(!Number.isSafeInteger(capacity)||capacity<1||capacity>1024)return;
 let generation=0,current=null,retired=false;
 function close(state){if(!state)return;state.accepting=false;if(state.timer)clearImmediate(state.timer);state.timer=null;state.queue.length=0;state.ledger?.close();state.ledger=null;if(current===state)current=null;}
 function flush(state){
  state.timer=null;
  if(current!==state||state.generation!==generation||retired||life.signal.aborted){close(state);return;}
  const events=state.queue.splice(0,capacity);
  if(!events.length&&!state.reasons.size)return;
  try{state.ledger.ingest(events,{source:'openclaw-llm-output',reasons:[partial,...state.reasons]});}
  catch{state.reasons.add('observer ledger write failed; dropped observations');state.dropped+=events.length;}
 }
 function retire(){retired=true;generation++;close(current);}
 // No callback sees the raw event after this synchronous bounded projection.
 api.on('llm_output',(event,ctx)=>{
  const state=current;if(!state?.accepting||retired||life.signal.aborted)return;
  if(state.queue.length>=capacity){state.reasons.add('observer queue overflow; dropped observations');state.dropped++;return;}
  try{
   const projected=normalizeUsage({usage:{input:event.usage?.input,output:event.usage?.output,cacheRead:event.usage?.cacheRead,cacheWrite:event.usage?.cacheWrite},provider:event.provider,model:event.model,sessionId:event.sessionId,runId:event.runId},mapping);
   if(Object.values(projected).some(value=>typeof value==='string'&&!value.length))throw new TypeError('empty metadata');
   if(ctx?.agentId!==undefined){if(typeof ctx.agentId!=='string'||!ctx.agentId.length||ctx.agentId.length>1024||ctx.agentId.includes('\0'))throw new TypeError('invalid agent');projected.agentId=ctx.agentId;}
   projected.sourceRecordKey=randomUUID();projected.runtime='openclaw';
   state.queue.push(projected);
   if(!state.timer)state.timer=setImmediate(()=>flush(state));
  }catch{state.reasons.add('observer invalid metadata/counts; dropped observations');state.dropped++;if(!state.timer)state.timer=setImmediate(()=>flush(state));}
 });
 if(api.registrationMode!=='full')return;
 life.signal.addEventListener('abort',retire,{once:true});life.onDispose(retire);
 api.registerService({id:'token-governor-observer',apiVersion:1,
  start(ctx){
   if(retired||life.signal.aborted)return;
   close(current);generation++;
   const state={generation,accepting:false,queue:[],timer:null,reasons:new Set(),dropped:0,ledger:null};
   try{state.ledger=new UsageLedger(join(ctx.stateDir,'token-governor/usage.sqlite'));state.accepting=true;current=state;}
   catch{close(state);ctx.logger?.warn?.('token-governor: state unavailable; observer disabled');}
  },
  stop(){const state=current;if(!state)return;state.accepting=false;if(state.timer)clearImmediate(state.timer);flush(state);close(state);generation++;}
 });
}
