import type {ServerResponse} from 'node:http'
import type {HostEvent} from '@oqelira/protocol'
import type {Store} from './store.js'
import type {RunChannel} from './channel.js'

/** Durable event replay; reconnecting never calls the model or repeats a tool. */
export class RunJournal {
  private pending=Promise.resolve()
  private listeners=new Set<(event:HostEvent)=>void>()
  private closers=new Set<()=>void>()
  private responses=new Set<ServerResponse>()
  private finished=false
  constructor(private store:Store,private channel:RunChannel,private user:string,private conversation:string,private id:string,private cancel:()=>void){}
  publish(event:HostEvent){
    if(this.finished)return
    this.pending=this.pending.then(async()=>{
      const saved=await this.store.appendRunEvent(this.user,this.conversation,this.id,event)
      void this.channel.wake(this.id).catch(()=>undefined)
      for(const listener of this.listeners)listener(saved)
    }).catch(()=>{this.finished=true;this.cancel();for(const close of this.closers)close()})
  }
  async connect(response:ServerResponse,after:number){
    let cursor=after,ready=false,closed=false
    const buffer:HostEvent[]=[]
    const write=(event:HostEvent)=>{if(closed||response.destroyed||response.writableEnded||!event.sequence||event.sequence<=cursor)return;cursor=event.sequence;response.write(JSON.stringify(event)+'\n')}
    const listener=(event:HostEvent)=>{if(ready)write(event);else buffer.push(event)}
    const close=()=>{if(ready&&!response.destroyed)response.end()}
    this.listeners.add(listener);this.closers.add(close)
    this.responses.add(response)
    response.on('close',()=>{closed=true;this.listeners.delete(listener);this.closers.delete(close);this.responses.delete(response)})
    try{
      for(;;){const events=await this.store.runEvents(this.user,this.id,cursor);for(const event of events)write(event);if(events.length<1000||closed)break}
      ready=true
      for(const event of buffer)write(event)
      if(this.finished)close()
    }catch{response.destroy()}
  }
  heartbeat(){for(const response of this.responses)if(!response.destroyed)response.write('\n')}
  async finish(){await this.pending;this.finished=true;for(const close of this.closers)close()}
}

const TERMINAL=['done','error']
const TAIL_POLL_MS=1000
const TAIL_LIMIT_MS=10*60*1000
/**
 * Live tail for a run owned by another replica. The database supplies every event; the channel
 * only wakes the reader early, and the poll bounds delay if a notification is lost.
 */
export async function tailRun(store:Store,channel:RunChannel,user:string,run:string,response:ServerResponse,after:number){
  let cursor=after,wake=()=>{}
  const unwatch=channel.watch(run,()=>wake())
  const deadline=Date.now()+TAIL_LIMIT_MS
  try{
    for(;;){
      // Check liveness before reading: a run that has released its lease has committed all its events.
      const active=await store.runActive(user,run)
      const events=await store.runEvents(user,run,cursor)
      let terminal=false
      for(const event of events){cursor=event.sequence!;if(!response.destroyed)response.write(JSON.stringify(event)+'\n');if(TERMINAL.includes(event.type))terminal=true}
      if(terminal||response.destroyed||Date.now()>deadline)break
      if(!active){if(!response.destroyed)response.write(JSON.stringify({type:'error',message:'Live execution is unavailable on this server. Saved history is retained; inspect the workspace before resuming.'})+'\n');break}
      if(events.length)continue
      await new Promise<void>(resolve=>{const timer=setTimeout(resolve,TAIL_POLL_MS);wake=()=>{clearTimeout(timer);resolve()}})
      wake=()=>{}
    }
  }finally{unwatch();response.end()}
}
